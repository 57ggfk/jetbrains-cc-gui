package com.github.claudecodegui.provider;

import com.github.claudecodegui.settings.ConfigPathManager;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.diagnostic.Logger;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.util.OptionalInt;

/**
 * Resolves the explicit Claude context window override.
 *
 * <p>The Claude CLI reads {@code CLAUDE_CODE_MAX_CONTEXT_TOKENS} (process env or the
 * {@code env} block of {@code ~/.claude/settings.json}) and uses that value for its own
 * context accounting, which is what {@code /context} reports. Claude SDK usage payloads
 * do not carry a context-window field, so the plugin must resolve the same override
 * instead of falling back to the static per-model table.</p>
 */
public final class ClaudeContextWindowOverrideProvider {

    static final String ENV_KEY = "CLAUDE_CODE_MAX_CONTEXT_TOKENS";

    private static final Logger LOG = Logger.getInstance(ClaudeContextWindowOverrideProvider.class);

    private static volatile ClaudeContextWindowOverrideProvider instance;

    private final ConfigPathManager pathManager;
    private volatile CachedOverride cache;

    private ClaudeContextWindowOverrideProvider() {
        this(new ConfigPathManager());
    }

    ClaudeContextWindowOverrideProvider(ConfigPathManager pathManager) {
        this.pathManager = pathManager;
    }

    public static ClaudeContextWindowOverrideProvider getInstance() {
        ClaudeContextWindowOverrideProvider local = instance;
        if (local == null) {
            synchronized (ClaudeContextWindowOverrideProvider.class) {
                local = instance;
                if (local == null) {
                    local = new ClaudeContextWindowOverrideProvider();
                    instance = local;
                }
            }
        }
        return local;
    }

    @org.jetbrains.annotations.TestOnly
    public static void setInstanceForTests(ClaudeContextWindowOverrideProvider testInstance) {
        instance = testInstance;
    }

    @org.jetbrains.annotations.TestOnly
    public static ClaudeContextWindowOverrideProvider createForTests(Path settingsPath) {
        return new ClaudeContextWindowOverrideProvider(new ConfigPathManager() {
            @Override
            public Path getClaudeSettingsPath() {
                return settingsPath;
            }
        });
    }

    /**
     * @return the configured context window in tokens, or empty when no override is set
     */
    public OptionalInt getOverride() {
        int fromSettings = readSettingsOverride();
        if (fromSettings > 0) {
            return OptionalInt.of(fromSettings);
        }
        return parsePositiveInt(System.getenv(ENV_KEY));
    }

    int readSettingsOverride() {
        Path settingsPath = pathManager.getClaudeSettingsPath();
        long mtime = readMtimeSafe(settingsPath);
        CachedOverride current = cache;
        if (current != null && current.mtime == mtime) {
            return current.value;
        }

        synchronized (this) {
            current = cache;
            if (current != null && current.mtime == mtime) {
                return current.value;
            }
            int value = loadSettingsOverride(settingsPath);
            cache = new CachedOverride(mtime, value);
            return value;
        }
    }

    private static int loadSettingsOverride(Path settingsPath) {
        if (!Files.exists(settingsPath)) {
            return -1;
        }
        try {
            JsonObject settings = JsonParser.parseString(
                    Files.readString(settingsPath, StandardCharsets.UTF_8)).getAsJsonObject();
            if (!settings.has("env") || !settings.get("env").isJsonObject()) {
                return -1;
            }
            JsonElement raw = settings.getAsJsonObject("env").get(ENV_KEY);
            if (raw == null || raw.isJsonNull() || !raw.isJsonPrimitive()) {
                return -1;
            }
            return parsePositiveInt(raw.getAsString()).orElse(-1);
        } catch (Exception e) {
            LOG.warn("[ClaudeContextWindowOverrideProvider] Failed to read settings: " + e.getMessage());
            return -1;
        }
    }

    static OptionalInt parsePositiveInt(String raw) {
        if (raw == null) {
            return OptionalInt.empty();
        }
        try {
            int value = Integer.parseInt(raw.trim());
            return value > 0 ? OptionalInt.of(value) : OptionalInt.empty();
        } catch (NumberFormatException e) {
            return OptionalInt.empty();
        }
    }

    private static long readMtimeSafe(Path path) {
        try {
            FileTime time = Files.getLastModifiedTime(path);
            return time == null ? 0L : time.toMillis();
        } catch (Exception e) {
            return 0L;
        }
    }

    private static final class CachedOverride {
        final long mtime;
        final int value;

        CachedOverride(long mtime, int value) {
            this.mtime = mtime;
            this.value = value;
        }
    }
}
