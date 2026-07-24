package com.github.claudecodegui.handler.provider;

import com.github.claudecodegui.handler.core.BaseMessageHandler;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.handler.UsagePushService;
import com.github.claudecodegui.provider.CustomModelContextWindowProvider;
import com.github.claudecodegui.provider.CustomPricingProvider;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.github.claudecodegui.settings.ModelPricing;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.diagnostic.Logger;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Handles persistence of user-configured model pricing and context windows.
 *
 * <p>The frontend sends {@code set_custom_model_pricing} whenever plugin-level custom models or
 * pricing-only Claude configured models change. The payload shape is:
 * <pre>
 * { "provider": "claude"|"codex", "models": [ { "id": "...", "pricing": { ... } } ] }
 * </pre>
 * Pricing and context-window maps are persisted independently. Missing fields are omitted from
 * their respective maps so existing hardcoded context and pricing fallbacks remain unchanged.
 */
public class CustomModelPricingHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(CustomModelPricingHandler.class);

    static final String SET_TYPE = "set_custom_model_pricing";

    private final CodemossSettingsService settingsService;
    private final UsagePushService usagePushService;

    public CustomModelPricingHandler(HandlerContext context, CodemossSettingsService settingsService) {
        super(context);
        this.settingsService = settingsService;
        this.usagePushService = context == null ? null : new UsagePushService(context);
    }

    @Override
    public boolean handle(String type, String content) {
        if (!SET_TYPE.equals(type)) {
            return false;
        }
        try {
            JsonObject payload = JsonParser.parseString(content).getAsJsonObject();
            String provider = payload.has("provider") && !payload.get("provider").isJsonNull()
                    ? payload.get("provider").getAsString()
                    : null;
            if (!"claude".equals(provider) && !"codex".equals(provider)) {
                LOG.warn("[CustomModelPricingHandler] Rejected unknown provider: " + provider);
                return true;
            }

            Map<String, ModelPricing> pricingMap = new LinkedHashMap<>();
            Map<String, Integer> contextWindowMap = new LinkedHashMap<>();
            if (payload.has("models") && payload.get("models").isJsonArray()) {
                JsonArray models = payload.getAsJsonArray("models");
                for (JsonElement el : models) {
                    if (!el.isJsonObject()) {
                        continue;
                    }
                    JsonObject model = el.getAsJsonObject();
                    if (!model.has("id") || model.get("id").isJsonNull()) {
                        continue;
                    }
                    String id = model.get("id").getAsString().trim();
                    if (id.isEmpty()) {
                        continue;
                    }
                    ModelPricing pricing = parsePricing(model);
                    if (pricing != null) {
                        pricingMap.put(id, pricing);
                    }
                    Integer contextWindow = parseContextWindow(model);
                    if (contextWindow != null) {
                        contextWindowMap.put(id, contextWindow);
                    }
                }
            }

            settingsService.setCustomModelPricing(provider, pricingMap);
            settingsService.setCustomModelContextWindows(provider, contextWindowMap);
            CustomPricingProvider.getInstance().invalidateCache();
            CustomModelContextWindowProvider.getInstance().invalidateCache();
            LOG.info("[CustomModelPricingHandler] Persisted " + pricingMap.size()
                    + " custom model pricing entries and " + contextWindowMap.size()
                    + " context window entries for " + provider);

            refreshCurrentUsage(provider);
        } catch (Exception e) {
            LOG.error("[CustomModelPricingHandler] Failed to handle " + type + ": " + e.getMessage(), e);
        }
        return true;
    }

    @Override
    public String[] getSupportedTypes() {
        return new String[]{SET_TYPE};
    }

    private ModelPricing parsePricing(JsonObject model) {
        if (!model.has("pricing") || !model.get("pricing").isJsonObject()) {
            return null;
        }
        JsonObject p = model.getAsJsonObject("pricing");
        Double input = readDouble(p, "inputCostPer1M");
        Double output = readDouble(p, "outputCostPer1M");
        Double cacheWrite = readDouble(p, "cacheWriteCostPer1M");
        Double cacheRead = readDouble(p, "cacheReadCostPer1M");
        if (input == null && output == null && cacheWrite == null && cacheRead == null) {
            return null;
        }
        return new ModelPricing(input, output, cacheWrite, cacheRead);
    }

    private Integer parseContextWindow(JsonObject model) {
        if (!model.has("contextWindowTokens") || model.get("contextWindowTokens").isJsonNull()) {
            return null;
        }
        try {
            int value = model.get("contextWindowTokens").getAsBigDecimal().intValueExact();
            return value > 0 ? value : null;
        } catch (Exception e) {
            return null;
        }
    }

    private void refreshCurrentUsage(String provider) {
        if (usagePushService == null || context == null || !provider.equalsIgnoreCase(context.getCurrentProvider())) {
            return;
        }
        int maxTokens = ModelProviderHandler.getModelContextLimit(provider, context.getCurrentModel());
        usagePushService.pushUsageUpdateAfterModelChange(maxTokens);
    }

    private static Double readDouble(JsonObject obj, String key) {
        if (obj == null || !obj.has(key) || obj.get(key).isJsonNull()) {
            return null;
        }
        try {
            double v = obj.get(key).getAsDouble();
            return Double.isFinite(v) && v >= 0 ? v : null;
        } catch (Exception e) {
            return null;
        }
    }
}
