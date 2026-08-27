package com.proofofsmart.quiz

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.google.android.play.core.integrity.IntegrityManagerFactory
import com.google.android.play.core.integrity.IntegrityTokenRequest

/**
 * PlayIntegrityPlugin — asks Google to attest that this is the real app binary
 * running on a genuine, unrooted device.
 *
 * The token is opaque here on purpose. It is encrypted for our Google Cloud
 * project and only the server can decode it (services/attestation.js calls
 * decodeIntegrityToken), so a modified client cannot forge or inspect a verdict.
 * All this plugin does is carry the server's nonce to Google and the resulting
 * token back.
 *
 * The nonce comes from POST /api/attest/nonce and is single-use, which is what
 * stops a token captured from one device being replayed by another.
 */
@CapacitorPlugin(name = "PlayIntegrity")
class PlayIntegrityPlugin : Plugin() {

    @PluginMethod
    fun requestToken(call: PluginCall) {
        val nonce = call.getString("nonce")
        if (nonce.isNullOrBlank()) {
            call.reject("A nonce is required")
            return
        }

        // Set at build time from GOOGLE_CLOUD_PROJECT_NUMBER — see
        // mobile/native/android/app/build.gradle.
        val cloudProjectNumber = BuildConfig.GOOGLE_CLOUD_PROJECT_NUMBER
        if (cloudProjectNumber == 0L) {
            call.reject("GOOGLE_CLOUD_PROJECT_NUMBER is not configured in this build")
            return
        }

        try {
            val manager = IntegrityManagerFactory.create(context)
            val request = IntegrityTokenRequest.builder()
                .setNonce(nonce)
                .setCloudProjectNumber(cloudProjectNumber)
                .build()

            manager.requestIntegrityToken(request)
                .addOnSuccessListener { response ->
                    val result = JSObject()
                    result.put("token", response.token())
                    call.resolve(result)
                }
                .addOnFailureListener { error ->
                    // Surfaced to the player as a generic "device check failed".
                    // public/native.js never shows this text verbatim.
                    call.reject(error.message ?: "Integrity request failed", error)
                }
        } catch (error: Exception) {
            call.reject(error.message ?: "Integrity request failed", error)
        }
    }
}
