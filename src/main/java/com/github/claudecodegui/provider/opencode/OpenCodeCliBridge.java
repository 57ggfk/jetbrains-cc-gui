package com.github.claudecodegui.provider.opencode;

import com.github.claudecodegui.provider.common.MarkerCliBridge;

import java.util.Map;

/**
 * OpenCode CLI bridge.
 *
 * <p>MVP uses {@code opencode run --format json} via channel-manager (same
 * approach as desktop-cc-gui). Managed {@code opencode serve} / SDK can be
 * layered later without changing the Java marker contract.
 */
public class OpenCodeCliBridge extends MarkerCliBridge {

    public OpenCodeCliBridge() {
        super(OpenCodeCliBridge.class);
    }

    @Override
    protected String getProviderName() {
        return "opencode";
    }

    @Override
    protected String getStdinEnvKey() {
        return "OPENCODE_USE_STDIN";
    }

    @Override
    protected void configureExtraEnv(Map<String, String> env) {
        // Reserved for OPENCODE_HOME / OPENCODE_CONFIG_CONTENT injection.
    }
}
