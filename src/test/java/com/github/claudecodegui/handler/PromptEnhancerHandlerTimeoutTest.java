package com.github.claudecodegui.handler;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

/**
 * Unit tests for pure helpers on {@link PromptEnhancerHandler}:
 * dynamic timeout sizing and CONTENT_DELTA JSON payload parsing.
 */
public class PromptEnhancerHandlerTimeoutTest {

    @Test
    public void computeEnhanceTimeoutSeconds_shortPromptUsesBase() {
        assertEquals(45L, PromptEnhancerHandler.computeEnhanceTimeoutSeconds(0));
        assertEquals(45L, PromptEnhancerHandler.computeEnhanceTimeoutSeconds(399));
    }

    @Test
    public void computeEnhanceTimeoutSeconds_growsWithLengthThenCaps() {
        // 400 chars => +1s
        assertEquals(46L, PromptEnhancerHandler.computeEnhanceTimeoutSeconds(400));
        // 40_000 chars => +100s => would be 145, capped at 120
        assertEquals(120L, PromptEnhancerHandler.computeEnhanceTimeoutSeconds(40_000));
    }

    @Test
    public void parseJsonStringPayload_decodesJsonString() {
        assertEquals("Hello\nWorld", PromptEnhancerHandler.parseJsonStringPayload("\"Hello\\nWorld\""));
        assertEquals("plain", PromptEnhancerHandler.parseJsonStringPayload("plain"));
        assertNull(PromptEnhancerHandler.parseJsonStringPayload(""));
        assertNull(PromptEnhancerHandler.parseJsonStringPayload(null));
    }
}
