package com.github.claudecodegui.provider;

import org.junit.Test;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;

public class CustomModelContextWindowProviderTest {

    @Test
    public void shouldResolveProviderSpecificContextWindowsAndClaudeSuffix() throws Exception {
        Path config = Files.createTempFile("custom-model-context", ".json");
        Files.writeString(config, """
                {
                  "customModelContextWindows": {
                    "claude": {
                      "shared-model": 500000,
                      "invalid-model": -1
                    },
                    "codex": {
                      "shared-model": 1000000,
                      "fractional-model": 12.5
                    }
                  }
                }
                """);

        CustomModelContextWindowProvider provider = CustomModelContextWindowProvider.createForTests(config);

        assertEquals(500_000, provider.getContextWindow("claude", "shared-model").orElseThrow());
        assertEquals(500_000, provider.getContextWindow("claude", "shared-model[1m]").orElseThrow());
        assertEquals(1_000_000, provider.getContextWindow("codex", "shared-model").orElseThrow());
        assertFalse(provider.getContextWindow("claude", "invalid-model").isPresent());
        assertFalse(provider.getContextWindow("codex", "fractional-model").isPresent());
        assertFalse(provider.getContextWindow("codex", "missing-model").isPresent());
    }
}
