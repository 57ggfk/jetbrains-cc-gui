package com.github.claudecodegui.settings;

import com.github.claudecodegui.util.SafeJsonFileOps;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import org.tomlj.Toml;
import org.tomlj.TomlParseResult;

import java.io.IOException;
import java.nio.file.Path;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Pattern;

import static com.github.claudecodegui.settings.ProviderBackupCodec.BackupException;
import static com.github.claudecodegui.settings.ProviderBackupCodec.checkEngine;
import static com.github.claudecodegui.settings.ProviderBackupCodec.parseObject;
import static com.github.claudecodegui.settings.ProviderBackupCodec.string;

/** Add-only backup merge. Pure planning keeps validation/deduplication separate from persistence. */
public final class ProviderBackupService {
    private static final int MAX_PROVIDERS = 2000;
    private static final Gson GSON = new GsonBuilder().serializeNulls().create();
    // Match JavaScript String.trim(), including non-breaking spaces from pasted variable names.
    private static final Pattern ENV_NAME_WHITESPACE = Pattern.compile("^[\\s\\p{Z}\\uFEFF]+|[\\s\\p{Z}\\uFEFF]+$");
    private static final List<String> CLAUDE_FIELDS = List.of("settingsConfig", "customModels");
    private static final List<String> CODEX_FIELDS = List.of(
            "configToml", "authJson", "customModels", "messageEnvVars", "mcpEnvVars");
    private static final Set<String> SPECIAL_IDS = Set.of(
            "__disabled__", "__local_settings_json__", "__cli_login__", "__codex_cli_login__");

    private ProviderBackupService() {}

    public record MergeResult(JsonObject config, int imported, int skipped) {}

    public static JsonObject exportPayload(JsonObject config, String engine) throws IOException {
        checkEngine(engine);
        JsonObject section = objectOrEmpty(config, engine);
        JsonObject stored = objectOrEmpty(section, "providers");
        JsonArray providers = new JsonArray();
        for (String id : ProviderOrderHelper.getProviderOrder(section, stored.keySet())) {
            if (SPECIAL_IDS.contains(id)) {
                continue;
            }
            try {
                JsonObject provider = objectOrEmpty(stored, id);
                if (isVirtual(provider)) {
                    continue;
                }
                JsonObject portable = portableProvider(provider, engine);
                signature(portable, engine);
                providers.add(portable);
            } catch (BackupException e) {
                // Position follows the saved-provider order, excluding virtual login entries.
                throw e.atProvider(providers.size() + 1);
            }
        }
        if (providers.isEmpty()) {
            throw new BackupException("empty");
        }
        if (providers.size() > MAX_PROVIDERS) {
            throw new BackupException("tooLarge");
        }
        JsonObject payload = new JsonObject();
        payload.add("providers", providers);
        return payload;
    }

    public static MergeResult merge(JsonObject original, String engine, JsonObject payload) throws IOException {
        checkEngine(engine);
        if (!payload.has("providers") || !payload.get("providers").isJsonArray()) {
            throw new BackupException("invalidFile");
        }
        JsonArray incoming = payload.getAsJsonArray("providers");
        if (incoming.isEmpty()) {
            throw new BackupException("empty");
        }
        if (incoming.size() > MAX_PROVIDERS) {
            throw new BackupException("tooLarge");
        }

        JsonObject config = original.deepCopy();
        JsonObject section = objectOrEmpty(config, engine);
        JsonObject providers = objectOrEmpty(section, "providers");
        if (!present(section, "current")) {
            // Match ProviderManager's legacy Claude fallback before adding anything;
            // resolving it afterwards could activate a newly imported provider.
            String currentId = "claude".equals(engine) && providers.size() > 0
                    ? providers.keySet().iterator().next() : "";
            section.addProperty("current", currentId);
        }
        Set<JsonObject> signatures = new HashSet<>();
        for (var entry : providers.entrySet()) {
            if (SPECIAL_IDS.contains(entry.getKey()) || !entry.getValue().isJsonObject()) {
                continue;
            }
            try {
                signatures.add(signature(portableProvider(entry.getValue().getAsJsonObject(), engine), engine));
            } catch (BackupException ignored) {
                // An unrelated legacy/malformed local entry must remain untouched.
            }
        }

        int added = 0;
        for (JsonElement entry : incoming) {
            if (!entry.isJsonObject()) {
                throw new BackupException("invalidFile");
            }
            JsonObject provider = portableProvider(entry.getAsJsonObject(), engine);
            if (!signatures.add(signature(provider, engine))) {
                continue;
            }
            String id;
            do {
                id = UUID.randomUUID().toString();
            } while (providers.has(id));
            provider.addProperty("id", id);
            provider.addProperty("createdAt", System.currentTimeMillis());
            providers.add(id, provider);
            added++;
        }
        // Existing entries, order, authorization flags and the effective selection are preserved.
        section.add("providers", providers);
        config.add(engine, section);
        return new MergeResult(config, added, incoming.size() - added);
    }

    public static MergeResult importPayload(Path configPath, String engine, JsonObject payload) throws IOException {
        return ConfigFileTransaction.call(configPath, () -> importPayloadLocked(configPath, engine, payload));
    }

    private static MergeResult importPayloadLocked(Path configPath, String engine, JsonObject payload) throws IOException {
        AtomicReference<MergeResult> result = new AtomicReference<>();
        SafeJsonFileOps.mutatePrivateJsonAtomically(configPath, 3, 50, current -> {
            MergeResult plan = merge(current == null ? new JsonObject() : current, engine, payload);
            result.set(plan);
            // A duplicate-only import does not even rewrite the file or its backup.
            return plan.imported() == 0 ? null : writer -> GSON.toJson(plan.config(), writer);
        });
        return result.get();
    }

    private static JsonObject portableProvider(JsonObject source, String engine) throws IOException {
        if (isVirtual(source)) {
            throw new BackupException("invalidFile");
        }
        String name = validateField("name", () -> string(source, "name"));
        if (name.isBlank() || name.length() > 4096) {
            throw new BackupException("invalidFile").withField("name");
        }
        JsonObject result = new JsonObject();
        result.addProperty("name", name);
        for (String field : List.of("remark", "websiteUrl", "category")) {
            if (present(source, field)) {
                result.addProperty(field, validateField(field, () -> string(source, field)));
            }
        }
        for (String field : "claude".equals(engine) ? CLAUDE_FIELDS : CODEX_FIELDS) {
            if (present(source, field)) {
                JsonElement value = validateField(field, () -> {
                    JsonElement stored = source.get(field);
                    // Bound the tree before Gson's recursive deepCopy as well as before encoding.
                    ProviderBackupCodec.checkJsonDepth(stored, 0);
                    return stored.deepCopy();
                });
                if ("messageEnvVars".equals(field) || "mcpEnvVars".equals(field)) {
                    validateField(field, () -> normalizeEnvNames(value));
                }
                result.add(field, value);
            }
        }
        // Deliberately drop IDs, cc-switch source linkage, activity and legacy credential markers.
        return result;
    }

    private static JsonElement normalizeEnvNames(JsonElement value) throws BackupException {
        if (!value.isJsonArray()) {
            throw new BackupException("invalidFile");
        }
        for (JsonElement entry : value.getAsJsonArray()) {
            if (!entry.isJsonObject()) {
                throw new BackupException("invalidFile");
            }
            JsonObject env = entry.getAsJsonObject();
            env.addProperty("key", ENV_NAME_WHITESPACE.matcher(string(env, "key")).replaceAll(""));
        }
        return value;
    }

    private static JsonObject signature(JsonObject provider, String engine) throws IOException {
        JsonObject result = new JsonObject();
        if ("claude".equals(engine)) {
            result.add("settingsConfig", validateField("settingsConfig", () -> claudeSettingsSignature(provider)));
        } else {
            result.add("configToml", validateField("configToml", () -> codexTomlSignature(provider)));
            result.add("authJson", validateField("authJson", () -> codexAuthSignature(provider)));
            result.add("messageEnvVars", validateField("messageEnvVars", () -> envSignature(provider, "messageEnvVars")));
            result.add("mcpEnvVars", validateField("mcpEnvVars", () -> envSignature(provider, "mcpEnvVars")));
        }
        result.add("customModels", validateField("customModels", () -> modelSignature(provider)));
        return result;
    }

    private static JsonObject claudeSettingsSignature(JsonObject provider) throws BackupException {
        if (!provider.has("settingsConfig") || !provider.get("settingsConfig").isJsonObject()) {
            throw new BackupException("invalidFile");
        }
        JsonObject settings = provider.getAsJsonObject("settingsConfig");
        if (present(settings, "env") && !settings.get("env").isJsonObject()) {
            throw new BackupException("invalidFile");
        }
        if (present(settings, "env")) {
            for (JsonElement value : settings.getAsJsonObject("env").asMap().values()) {
                if (!value.isJsonPrimitive()) {
                    throw new BackupException("invalidFile");
                }
            }
        }
        return settings;
    }

    private static JsonObject codexTomlSignature(JsonObject provider) throws IOException {
        String toml = optionalString(provider, "configToml");
        // Bound embedded TOML independently of the outer JSON.
        if (toml.length() > 256 * 1024) {
            throw new BackupException("tooLarge");
        }
        return parseToml(toml);
    }

    private static JsonElement codexAuthSignature(JsonObject provider) throws BackupException {
        String auth = optionalString(provider, "authJson");
        // Match CodexSettingsManager: missing/blank auth means no provider-owned auth.
        // Keep that distinct from an explicitly supplied {}. Never synthesize credentials.
        return auth.trim().isEmpty() ? JsonNull.INSTANCE : parseObject(auth);
    }

    private static String optionalString(JsonObject provider, String key) throws BackupException {
        return present(provider, key) ? string(provider, key) : "";
    }

    private static JsonArray modelSignature(JsonObject provider) throws BackupException {
        JsonArray models = new JsonArray();
        if (present(provider, "customModels")) {
            if (!provider.get("customModels").isJsonArray()) {
                throw new BackupException("invalidFile");
            }
            models = provider.getAsJsonArray("customModels");
            for (JsonElement model : models) {
                if (!model.isJsonObject() || string(model.getAsJsonObject(), "id").isBlank()
                        || string(model.getAsJsonObject(), "label").isBlank()) {
                    throw new BackupException("invalidFile");
                }
            }
        }
        return models;
    }

    @FunctionalInterface
    private interface Validation<T> {
        T run() throws IOException;
    }

    private static <T> T validateField(String field, Validation<T> validation) throws IOException {
        try {
            return validation.run();
        } catch (BackupException e) {
            throw e.withField(field);
        }
    }

    private static JsonObject envSignature(JsonObject provider, String field) throws IOException {
        JsonObject env = new JsonObject();
        if (!present(provider, field)) {
            return env;
        }
        if (!provider.get(field).isJsonArray()) {
            throw new BackupException("invalidFile");
        }
        Set<String> keys = new HashSet<>();
        for (JsonElement entry : provider.getAsJsonArray(field)) {
            if (!entry.isJsonObject()) {
                throw new BackupException("invalidFile");
            }
            String key = string(entry.getAsJsonObject(), "key");
            String value = string(entry.getAsJsonObject(), "value");
            if (!key.matches("[a-zA-Z_][a-zA-Z0-9_]*") || value.length() > 16 * 1024
                    || !keys.add(key.toUpperCase(Locale.ROOT))) {
                throw new BackupException("invalidFile");
            }
            env.addProperty(key, value);
        }
        return env;
    }

    private static JsonObject parseToml(String text) throws IOException {
        try {
            TomlParseResult parsed = Toml.parse(text);
            if (parsed.hasErrors()) {
                throw new BackupException("invalidFile");
            }
            return parseObject(parsed.toJson());
        } catch (StackOverflowError | IllegalArgumentException e) {
            // tomlj's recursive parser can exhaust its stack on deeply nested untrusted arrays.
            // Do not strand the UI operation or expose parser messages containing credentials.
            throw new BackupException("invalidFile");
        }
    }

    private static boolean isVirtual(JsonObject provider) {
        if (provider.has("id") && provider.get("id").isJsonPrimitive()
                && SPECIAL_IDS.contains(provider.get("id").getAsString())) {
            return true;
        }
        return "true".equals(String.valueOf(provider.get("isLocalProvider")))
                || "true".equals(String.valueOf(provider.get("isCliLoginProvider")));
    }

    private static boolean present(JsonObject object, String key) {
        return object.has(key) && !object.get(key).isJsonNull();
    }

    private static JsonObject objectOrEmpty(JsonObject object, String key) throws BackupException {
        if (!object.has(key)) {
            return new JsonObject();
        }
        if (!object.get(key).isJsonObject()) {
            throw new BackupException("invalidFile");
        }
        return object.getAsJsonObject(key);
    }
}
