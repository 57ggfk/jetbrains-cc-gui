package com.github.claudecodegui.util;

import org.junit.Test;

import static org.junit.Assert.assertTrue;

public class HtmlLoaderTest {

    @Test
    public void injectsPageGenerationBeforeFrontendBundle() {
        HtmlLoader loader = new HtmlLoader(HtmlLoaderTest.class);
        String html = "<html><head><script src=\"main.js\"></script></head><body></body></html>";

        String injected = loader.injectPageGeneration(html, 42);

        int generationIndex = injected.indexOf("window.__CCG_PAGE_GENERATION__ = 42");
        int bundleIndex = injected.indexOf("main.js");
        assertTrue(generationIndex > 0);
        assertTrue(generationIndex < bundleIndex);
    }
}
