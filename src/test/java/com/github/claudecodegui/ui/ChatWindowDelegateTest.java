package com.github.claudecodegui.ui;

import com.github.claudecodegui.handler.SettingsHandler;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Test;

import static org.junit.Assert.assertEquals;

/**
 * Unit tests for Java-to-frontend tab state used during WebView recovery.
 */
public class ChatWindowDelegateTest {

    /** Verifies that recovery serializes the complete authoritative Session selection state. */
    @Test
    public void buildsAuthoritativeBackendTabState() {
        String json = ChatWindowDelegate.buildBackendTabStateJson(
                "codex",
                "gpt-5.6-sol",
                "bypassPermissions",
                "high",
                "fast"
        );

        JsonObject state = JsonParser.parseString(json).getAsJsonObject();
        assertEquals("codex", state.get("provider").getAsString());
        assertEquals("gpt-5.6-sol", state.get("model").getAsString());
        assertEquals("bypassPermissions", state.get("permissionMode").getAsString());
        assertEquals("high", state.get("reasoningEffort").getAsString());
        assertEquals("fast", state.get("codexFastMode").getAsString());
    }

    /** Verifies that recovery preserves v0.5's provider-aware Codex context-window lookup. */
    @Test
    public void resolvesCodexRecoveryLimitThroughExistingProviderConfiguration() {
        int limit = ChatWindowDelegate.resolveModelContextLimitForRecovery(
                "codex",
                "gpt-5.6-sol",
                null
        );

        assertEquals(SettingsHandler.getModelContextLimit("codex", "gpt-5.6-sol"), limit);
    }
}
