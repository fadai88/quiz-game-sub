package com.proofofsmart.quiz

import android.util.Base64
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.solana.mobilewalletadapter.clientlib.ActivityResultSender
import com.solana.mobilewalletadapter.clientlib.ConnectionIdentity
import com.solana.mobilewalletadapter.clientlib.MobileWalletAdapter
import com.solana.mobilewalletadapter.clientlib.TransactionResult
import com.solana.mobilewalletadapter.clientlib.successPayload
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * MobileWalletAdapterPlugin — non-custodial wallet access on Android.
 *
 * The web client talks to browser extensions through an injected `window.solana`
 * provider. There is no such injection in a WebView, so on Android the same
 * operations go through Mobile Wallet Adapter: an app-to-app protocol where the
 * wallet (Phantom, Solflare, Backpack…) is a separate installed app that we hand
 * a request to and get a signature back from.
 *
 * We never see a private key — MWA is exactly as non-custodial as the extension
 * flow it replaces. public/wallet.js bridges these methods into the same
 * WalletManager shape the game code already uses, so game.js and login.js are
 * unchanged.
 *
 * Threading: MWA suspends (it round-trips to another app), so every call runs in
 * a coroutine and resolves the Capacitor call from the callback.
 */
@CapacitorPlugin(name = "MobileWalletAdapter")
class MobileWalletAdapterPlugin : Plugin() {

    private lateinit var walletAdapter: MobileWalletAdapter
    private lateinit var activityResultSender: ActivityResultSender
    private val scope = CoroutineScope(Dispatchers.IO)

    // Cached so signMessage / signAndSendTransaction can report which account
    // the wallet actually authorized. The game guards that this matches the
    // logged-in wallet before letting a stake through.
    private var authorizedAddress: String? = null

    override fun load() {
        val activity = this.activity
        activityResultSender = ActivityResultSender(activity)

        walletAdapter = MobileWalletAdapter(
            connectionIdentity = ConnectionIdentity(
                identityUri = android.net.Uri.parse(BuildConfig.APP_IDENTITY_URI),
                iconRelativeUri = android.net.Uri.parse("favicon.ico"),
                identityName = BuildConfig.APP_IDENTITY_NAME
            )
        )
        // Must match the network the server's RPC is on; a mismatch makes every
        // stake transfer fail at simulation.
        walletAdapter.blockchain = when (BuildConfig.SOLANA_CLUSTER) {
            "mainnet-beta" -> com.solana.mobilewalletadapter.clientlib.Solana.Mainnet
            "testnet" -> com.solana.mobilewalletadapter.clientlib.Solana.Testnet
            else -> com.solana.mobilewalletadapter.clientlib.Solana.Devnet
        }
    }

    /**
     * Ask a wallet app to authorize this app and return the chosen account.
     * The wallet shows its own picker, so this covers every MWA-capable wallet
     * without us enumerating them — the multi-wallet story of public/wallet.js,
     * delegated to the platform.
     */
    @PluginMethod
    fun authorize(call: PluginCall) {
        scope.launch {
            when (val result = walletAdapter.connect(activityResultSender)) {
                is TransactionResult.Success -> {
                    val address = encodeBase58(result.authResult.accounts.first().publicKey)
                    authorizedAddress = address
                    val payload = JSObject()
                    payload.put("publicKey", address)
                    payload.put("label", result.authResult.accounts.first().accountLabel ?: "")
                    call.resolve(payload)
                }
                is TransactionResult.NoWalletFound ->
                    call.reject("No MWA-compatible wallet app is installed", "NO_WALLET")
                is TransactionResult.Failure ->
                    call.reject(result.e.message ?: "Wallet authorization failed", "AUTH_FAILED")
            }
        }
    }

    /** Drop the authorization so the next connect() shows the wallet picker again. */
    @PluginMethod
    fun deauthorize(call: PluginCall) {
        scope.launch {
            try {
                walletAdapter.disconnect(activityResultSender)
            } catch (_: Exception) {
                // Best effort — the local state below is what the UI reads.
            }
            authorizedAddress = null
            call.resolve()
        }
    }

    @PluginMethod
    fun getAuthorized(call: PluginCall) {
        val payload = JSObject()
        payload.put("publicKey", authorizedAddress)
        call.resolve(payload)
    }

    /**
     * Sign the login challenge. The server dictates the message
     * (utils/challengeStore.js) and verifies the signature, so this is the
     * native equivalent of WalletManager.signMessage.
     *
     * @param message base64 of the exact bytes to sign
     */
    @PluginMethod
    fun signMessage(call: PluginCall) {
        val messageB64 = call.getString("message")
        if (messageB64.isNullOrBlank()) {
            call.reject("A message is required")
            return
        }
        val messageBytes = Base64.decode(messageB64, Base64.NO_WRAP)

        scope.launch {
            val result = walletAdapter.transact(activityResultSender) { authResult ->
                val address = encodeBase58(authResult.accounts.first().publicKey)
                authorizedAddress = address
                signMessagesDetached(
                    arrayOf(messageBytes),
                    arrayOf(authResult.accounts.first().publicKey)
                )
            }

            when (result) {
                is TransactionResult.Success -> {
                    val signature = result.successPayload
                        ?.messages
                        ?.firstOrNull()
                        ?.signatures
                        ?.firstOrNull()
                    if (signature == null) {
                        call.reject("Wallet returned no signature", "NO_SIGNATURE")
                    } else {
                        val payload = JSObject()
                        payload.put("signature", Base64.encodeToString(signature, Base64.NO_WRAP))
                        payload.put("publicKey", authorizedAddress)
                        call.resolve(payload)
                    }
                }
                is TransactionResult.NoWalletFound ->
                    call.reject("No MWA-compatible wallet app is installed", "NO_WALLET")
                is TransactionResult.Failure ->
                    call.reject(result.e.message ?: "Message signing failed", "SIGN_FAILED")
            }
        }
    }

    /**
     * Sign AND send the stake transfer, returning its signature.
     *
     * Note this differs from the web flow, which signs locally and broadcasts
     * through the page's own RPC connection. MWA's signAndSendTransactions has
     * the wallet broadcast, which is the supported path on mobile. The server
     * only ever receives a transaction signature to verify on-chain
     * (services/transactionVerifier.js), so it cannot tell the difference.
     *
     * @param transaction base64 of the serialized unsigned transaction
     */
    @PluginMethod
    fun signAndSendTransaction(call: PluginCall) {
        val txB64 = call.getString("transaction")
        if (txB64.isNullOrBlank()) {
            call.reject("A transaction is required")
            return
        }
        val txBytes = Base64.decode(txB64, Base64.NO_WRAP)

        scope.launch {
            val result = walletAdapter.transact(activityResultSender) {
                signAndSendTransactions(arrayOf(txBytes))
            }

            when (result) {
                is TransactionResult.Success -> {
                    val signature = result.successPayload
                        ?.signatures
                        ?.firstOrNull()
                    if (signature == null) {
                        call.reject("Wallet returned no transaction signature", "NO_SIGNATURE")
                    } else {
                        val payload = JSObject()
                        payload.put("signature", encodeBase58(signature))
                        call.resolve(payload)
                    }
                }
                is TransactionResult.NoWalletFound ->
                    call.reject("No MWA-compatible wallet app is installed", "NO_WALLET")
                is TransactionResult.Failure ->
                    call.reject(result.e.message ?: "Transaction was not sent", "SEND_FAILED")
            }
        }
    }

    // Solana addresses and transaction signatures are base58; the MWA client
    // hands back raw bytes.
    private fun encodeBase58(bytes: ByteArray): String {
        val alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
        var leadingZeros = 0
        while (leadingZeros < bytes.size && bytes[leadingZeros].toInt() == 0) leadingZeros++

        var value = java.math.BigInteger(1, bytes)
        val sb = StringBuilder()
        val radix = java.math.BigInteger.valueOf(58)
        while (value > java.math.BigInteger.ZERO) {
            val divRem = value.divideAndRemainder(radix)
            sb.append(alphabet[divRem[1].toInt()])
            value = divRem[0]
        }
        repeat(leadingZeros) { sb.append(alphabet[0]) }
        return sb.reverse().toString()
    }
}
