package com.github.claudecodegui.provider;

import org.junit.Test;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

/**
 * Regression tests for the Claude context window override.
 */
public class ClaudeContextWindowOverrideProviderTest {

    private static ClaudeContextWindowOverrideProvider providerFor(String json) throws Exception {
        Path settings = Files.createTempFile("claude-settings", ".json");
        Files.writeString(settings, json);
        return ClaudeContextWindowOverrideProvider.createForTests(settings);
    }

    @Test
    public void shouldReadOverrideFromClaudeSettingsEnv() throws Exception {
        ClaudeContextWindowOverrideProvider provider = providerFor("""
                {
                  "env": {
                    "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "512000"
                  }
                }
                """);

        assertEquals(512_000, provider.readSettingsOverride());
    }

    @Test
    public void shouldIgnoreMissingOrInvalidOverride() throws Exception {
        assertEquals(-1, providerFor("{\"env\": {}}").readSettingsOverride());
        assertEquals(-1, providerFor("{}").readSettingsOverride());
        assertEquals(-1, providerFor(
                "{\"env\": {\"CLAUDE_CODE_MAX_CONTEXT_TOKENS\": \"not-a-number\"}}")
                .readSettingsOverride());
        assertEquals(-1, providerFor(
                "{\"env\": {\"CLAUDE_CODE_MAX_CONTEXT_TOKENS\": \"0\"}}")
                .readSettingsOverride());
    }

    @Test
    public void shouldParseOnlyPositiveIntegers() {
        assertEquals(512_000, ClaudeContextWindowOverrideProvider.parsePositiveInt(" 512000 ").orElse(-1));
        assertTrue(ClaudeContextWindowOverrideProvider.parsePositiveInt(null).isEmpty());
        assertTrue(ClaudeContextWindowOverrideProvider.parsePositiveInt("-1").isEmpty());
        assertTrue(ClaudeContextWindowOverrideProvider.parsePositiveInt("512k").isEmpty());
    }
}
