package com.github.claudecodegui.ui;

import org.junit.Assert;
import org.junit.Test;

import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

public class WebviewInitializerTest {

    @Test
    public void bootstrapIncludesEveryFrontendConfiguration() {
        List<String> scripts = WebviewInitializer.buildConfigurationInjections(
                "{\"editor\":true}",
                "{\"ui\":true}",
                "{\"code\":true}",
                "{\"language\":true}"
        );
        String bootstrap = String.join("\n", scripts);

        Assert.assertTrue(bootstrap.contains("applyIdeaFontConfig"));
        Assert.assertTrue(bootstrap.contains("applyUiFontConfig"));
        Assert.assertTrue(bootstrap.contains("applyCodeFontConfig"));
        Assert.assertTrue(bootstrap.contains("applyIdeaLanguageConfig"));
    }

    @Test
    public void shiftEscapeInjectionIsIdempotent() {
        String injection = WebviewInitializer.buildShiftEscInjection("hidePanelQuery();");

        Assert.assertTrue(injection.contains("if (!window.__ccgShiftEscInstalled)"));
        Assert.assertTrue(injection.contains("window.__ccgShiftEscInstalled = true"));
        Assert.assertTrue(injection.contains("hidePanelQuery();"));
    }

    @Test
    public void slowsBridgeInjectionRetriesAfterStartupWindow() {
        int fastDelay = WebviewInitializer.bridgeInjectionRetryDelayMs(50);
        int slowDelay = WebviewInitializer.bridgeInjectionRetryDelayMs(51);

        Assert.assertEquals(fastDelay, WebviewInitializer.bridgeInjectionRetryDelayMs(1));
        Assert.assertTrue(slowDelay > fastDelay);
        Assert.assertEquals(slowDelay, WebviewInitializer.bridgeInjectionRetryDelayMs(500));
    }

    @Test
    public void bridgeInjectionNotifiesFrontendBootstrapOnceBridgeExists() {
        String injection = WebviewInitializer.buildBridgeInjection("query(msg);");

        Assert.assertTrue(injection.contains("window.sendToJava = function(msg)"));
        Assert.assertTrue(injection.contains("window.__ccgOnBridgeReady();"));
    }

    @Test
    public void bridgeEnvelopeRejectsMessagesFromOtherPageGenerations() {
        String expression = WebviewInitializer.buildBridgeMessageExpression(7);
        String message = "__CCG_PAGE_GENERATION__:7:frontend_ready:";

        Assert.assertTrue(expression.contains("__CCG_PAGE_GENERATION__:7:"));
        assertEquals("frontend_ready:", WebviewInitializer.unwrapBridgeMessage(message, 7));
        assertNull(WebviewInitializer.unwrapBridgeMessage(message, 8));
        assertNull(WebviewInitializer.unwrapBridgeMessage("frontend_ready:", 7));
    }

    @Test
    public void configurationInjectionsAreSeparatedAsStatements() {
        String script = WebviewInitializer.joinConfigurationInjections(
                List.of("first()", "second()"));

        assertEquals("first();second();", script);
    }

    @Test
    public void pageGuardRejectsScriptsForOtherGenerations() {
        String injection = WebviewInitializer.guardPageScript(7, "bootstrap();");

        Assert.assertTrue(injection.startsWith("if (window.__CCG_PAGE_GENERATION__ === 7)"));
        Assert.assertTrue(injection.contains("bootstrap();"));
    }

    @Test
    public void pageGenerationsDoNotRepeatAcrossBrowserRecreation() {
        WebviewInitializer initializer = new WebviewInitializer(null);

        int oldBrowserGeneration = initializer.nextPageGeneration();
        int invalidationGeneration = initializer.nextPageGeneration();
        int replacementBrowserGeneration = initializer.nextPageGeneration();

        Assert.assertTrue(invalidationGeneration > oldBrowserGeneration);
        Assert.assertTrue(replacementBrowserGeneration > invalidationGeneration);
        Assert.assertNotEquals(oldBrowserGeneration, replacementBrowserGeneration);
    }
}
