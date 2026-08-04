package com.github.claudecodegui.ui;

import org.junit.Assert;
import org.junit.Test;
import org.cef.browser.CefBrowser;

import java.lang.reflect.Proxy;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

/**
 * Unit tests for WebView bootstrap, runtime page generation, and native recovery reload behavior.
 */
public class WebviewInitializerTest {

    /** Verifies that the bootstrap includes every frontend configuration callback. */
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

    /** Verifies that repeated Shift+Escape injection cannot register duplicate listeners. */
    @Test
    public void shiftEscapeInjectionIsIdempotent() {
        String injection = WebviewInitializer.buildShiftEscInjection("hidePanelQuery();");

        Assert.assertTrue(injection.contains("if (!window.__ccgShiftEscInstalled)"));
        Assert.assertTrue(injection.contains("window.__ccgShiftEscInstalled = true"));
        Assert.assertTrue(injection.contains("hidePanelQuery();"));
    }

    /** Verifies that bridge retries switch from fast startup polling to low-frequency polling. */
    @Test
    public void slowsBridgeInjectionRetriesAfterStartupWindow() {
        int fastDelay = WebviewInitializer.bridgeInjectionRetryDelayMs(50);
        int slowDelay = WebviewInitializer.bridgeInjectionRetryDelayMs(51);

        Assert.assertEquals(fastDelay, WebviewInitializer.bridgeInjectionRetryDelayMs(1));
        Assert.assertTrue(slowDelay > fastDelay);
        Assert.assertEquals(slowDelay, WebviewInitializer.bridgeInjectionRetryDelayMs(500));
    }

    /** Verifies that bridge injection wakes the frontend startup waiter once available. */
    @Test
    public void bridgeInjectionNotifiesFrontendBootstrapOnceBridgeExists() {
        String injection = WebviewInitializer.buildBridgeInjection("query(msg);");

        Assert.assertTrue(injection.contains("window.sendToJava = function(msg)"));
        Assert.assertTrue(injection.contains("window.__ccgOnBridgeReady();"));
    }

    /** Verifies that messages from a previous runtime page generation are rejected. */
    @Test
    public void bridgeEnvelopeRejectsMessagesFromOtherPageGenerations() {
        String expression = WebviewInitializer.buildBridgeMessageExpression(7);
        String message = "__CCG_PAGE_GENERATION__:7:frontend_ready:";

        Assert.assertTrue(expression.contains("__CCG_PAGE_GENERATION__:7:"));
        assertEquals("frontend_ready:", WebviewInitializer.unwrapBridgeMessage(message, 7));
        assertNull(WebviewInitializer.unwrapBridgeMessage(message, 8));
        assertNull(WebviewInitializer.unwrapBridgeMessage("frontend_ready:", 7));
    }

    /** Verifies that independent frontend configuration snippets remain valid statements. */
    @Test
    public void configurationInjectionsAreSeparatedAsStatements() {
        String script = WebviewInitializer.joinConfigurationInjections(
                List.of("first()", "second()"));

        assertEquals("first();second();", script);
    }

    /** Verifies that generation-guarded scripts only target their active runtime page. */
    @Test
    public void pageGuardRejectsScriptsForOtherGenerations() {
        String injection = WebviewInitializer.guardPageScript(7, "bootstrap();");

        Assert.assertTrue(injection.startsWith("if (window.__CCG_PAGE_GENERATION__ === 7)"));
        Assert.assertTrue(injection.contains("bootstrap();"));
    }

    /** Verifies that browser recreation cannot reuse a generation accepted by the old browser. */
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

    /** Verifies that Java distinguishes initial, startup-retry, and runtime-recovery page contexts. */
    @Test
    public void runtimePageContextCarriesGenerationAndRecoveryState() {
        String initial = WebviewInitializer.buildPageContextInjection(
                7, WebviewInitializer.PageLoadKind.INITIAL_LOAD);
        String startupRetry = WebviewInitializer.buildPageContextInjection(
                8, WebviewInitializer.PageLoadKind.STARTUP_RETRY);
        String runtimeRecovery = WebviewInitializer.buildPageContextInjection(
                9, WebviewInitializer.PageLoadKind.RUNTIME_RECOVERY);

        Assert.assertTrue(initial.contains("window.__CCG_PAGE_GENERATION__ = 7"));
        Assert.assertTrue(initial.contains("window.__CCGUI_PAGE_LOAD_KIND__ = 'initial_load'"));
        Assert.assertTrue(initial.contains("window.__CCGUI_RECOVERY_RELOAD__ = false"));
        Assert.assertTrue(initial.contains("window.__CCGUI_PAGE_CONTEXT_READY__ = true"));
        Assert.assertTrue(initial.contains("window.__CCGUI_RECOVERY_STATE_APPLIED__ = true"));
        Assert.assertTrue(startupRetry.contains("window.__CCG_PAGE_GENERATION__ = 8"));
        Assert.assertTrue(startupRetry.contains("window.__CCGUI_PAGE_LOAD_KIND__ = 'startup_retry'"));
        Assert.assertTrue(startupRetry.contains("window.__CCGUI_RECOVERY_RELOAD__ = false"));
        Assert.assertTrue(startupRetry.contains("window.__CCGUI_RECOVERY_STATE_APPLIED__ = true"));
        Assert.assertTrue(runtimeRecovery.contains("window.__CCG_PAGE_GENERATION__ = 9"));
        Assert.assertTrue(runtimeRecovery.contains("window.__CCGUI_PAGE_LOAD_KIND__ = 'runtime_recovery'"));
        Assert.assertTrue(runtimeRecovery.contains("window.__CCGUI_RECOVERY_RELOAD__ = true"));
        Assert.assertTrue(runtimeRecovery.contains("window.__CCGUI_RECOVERY_STATE_APPLIED__ = false"));
        Assert.assertTrue(runtimeRecovery.startsWith("if (window.__CCG_PAGE_GENERATION__ !== 9"));
    }

    /** Verifies that watchdog retries become authoritative only after a frontend was ready once. */
    @Test
    public void recoveryPageKindDependsOnPriorFrontendReadiness() {
        Assert.assertEquals(
                WebviewInitializer.PageLoadKind.STARTUP_RETRY,
                WebviewInitializer.recoveryPageLoadKind(false));
        Assert.assertEquals(
                WebviewInitializer.PageLoadKind.RUNTIME_RECOVERY,
                WebviewInitializer.recoveryPageLoadKind(true));
    }

    /** Verifies that runtime context is executed before every generation-guarded bridge script. */
    @Test
    public void runtimePageContextPrecedesBridgeExposure() {
        String context = WebviewInitializer.buildPageContextInjection(
                9, WebviewInitializer.PageLoadKind.RUNTIME_RECOVERY);
        String bootstrap = WebviewInitializer.joinRuntimePageBootstrap(
                context,
                "bridge();",
                "shortcuts();"
        );

        Assert.assertTrue(bootstrap.indexOf("window.__CCGUI_PAGE_CONTEXT_READY__ = true")
                < bootstrap.indexOf("bridge();"));
        Assert.assertTrue(bootstrap.indexOf("bridge();") < bootstrap.indexOf("shortcuts();"));
    }

    /** Verifies that watchdog soft recovery invokes native CefBrowser reload exactly once. */
    @Test
    public void softRecoveryReloadsCurrentCefPage() {
        AtomicInteger reloadCalls = new AtomicInteger();
        CefBrowser cefBrowser = (CefBrowser) Proxy.newProxyInstance(
                CefBrowser.class.getClassLoader(),
                new Class<?>[]{CefBrowser.class},
                (proxy, method, args) -> {
                    if ("reload".equals(method.getName())) {
                        reloadCalls.incrementAndGet();
                    }
                    return null;
                }
        );

        WebviewInitializer.reloadCurrentPage(cefBrowser);

        Assert.assertEquals(1, reloadCalls.get());
    }
}
