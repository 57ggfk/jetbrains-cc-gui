package com.github.claudecodegui.util;

import com.github.claudecodegui.session.ClaudeSession;
import com.google.gson.JsonObject;
import org.junit.Test;

import java.util.List;

import static org.junit.Assert.assertEquals;

public class TokenUsageUtilsTest {

    @Test
    public void contextTokensExcludeOutputTokens() {
        JsonObject usage = new JsonObject();
        usage.addProperty("input_tokens", 180000);
        usage.addProperty("cache_creation_input_tokens", 12000);
        usage.addProperty("cache_read_input_tokens", 160000);
        usage.addProperty("output_tokens", 2400);

        assertEquals(352000, TokenUsageUtils.extractContextTokens(usage, "claude"));
    }

    @Test
    public void codexContextTokensUseInputOnly() {
        JsonObject usage = new JsonObject();
        usage.addProperty("input_tokens", 180000);
        usage.addProperty("output_tokens", 2400);
        usage.addProperty("cached_input_tokens", 160000);

        assertEquals(180000, TokenUsageUtils.extractContextTokens(usage, "codex"));
    }

    @Test
    public void codexPrefersTopLevelContextUsageOverNestedHistoricalUsage() {
        JsonObject nestedUsage = new JsonObject();
        nestedUsage.addProperty("input_tokens", 22496533);
        JsonObject message = new JsonObject();
        message.add("usage", nestedUsage);

        JsonObject currentUsage = new JsonObject();
        currentUsage.addProperty("input_tokens", 127886);
        JsonObject raw = new JsonObject();
        raw.add("message", message);
        raw.add("usage", currentUsage);

        ClaudeSession.Message assistant = new ClaudeSession.Message(
                ClaudeSession.Message.Type.ASSISTANT,
                "",
                raw
        );

        assertEquals(
                127886,
                TokenUsageUtils.findLastUsageFromSessionMessages(List.of(assistant), "codex")
                        .get("input_tokens").getAsInt()
        );
        assertEquals(
                22496533,
                TokenUsageUtils.findLastUsageFromSessionMessages(List.of(assistant))
                        .get("input_tokens").getAsInt()
        );
    }
}
