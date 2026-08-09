package com.github.claudecodegui.provider.pi;

import com.github.claudecodegui.provider.common.MarkerCliBridge;

import java.util.Map;

/**
 * PI CLI bridge.
 *
 * <p>No official SDK — spawns local {@code pi} via channel-manager and maps
 * its JSON event stream onto the shared marker protocol.
 */
public class PiCliBridge extends MarkerCliBridge {

    public PiCliBridge() {
        super(PiCliBridge.class);
    }

    @Override
    protected String getProviderName() {
        return "pi";
    }

    @Override
    protected String getStdinEnvKey() {
        return "PI_USE_STDIN";
    }

    @Override
    protected void configureExtraEnv(Map<String, String> env) {
        // Reserved for future PI-specific env (e.g. PI_OFFLINE).
    }
}
