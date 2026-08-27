package com.proofofsmart.quiz;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

/**
 * Registers the two custom plugins. `cap add android` generates this file with
 * an empty body; the overlay replaces it, so any Capacitor plugin added later
 * via npm still auto-registers while these two are explicit.
 */
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(PlayIntegrityPlugin.class);
        registerPlugin(MobileWalletAdapterPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
