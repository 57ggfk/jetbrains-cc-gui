package com.github.claudecodegui.handler;

import com.github.claudecodegui.bridge.BridgeDirectoryResolver;
import com.github.claudecodegui.bridge.EnvironmentConfigurator;
import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.handler.core.BaseMessageHandler;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.provider.dsh.DshEnvSupport;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.github.claudecodegui.startup.BridgePreloader;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.util.concurrency.AppExecutorUtil;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

/**
 * DSH host lifecycle + connection settings for the Settings CLI card.
 *
 * <p>Frontend protocol:
 * <ul>
 *   <li>{@code sendToJava('get_dsh_status')} → {@code window.updateDshStatus(json)}</li>
 *   <li>{@code sendToJava('start_dsh_host')} → {@code window.updateDshStatus(json)}</li>
 *   <li>{@code sendToJava('stop_dsh_host')} → {@code window.updateDshStatus(json)}</li>
 *   <li>{@code sendToJava('save_dsh_settings:<json>')} → persists the {@code dsh}
 *       config section and replies {@code window.updateDshStatus(json)}</li>
 * </ul>
 *
 * <p>Only bin / host / port / autoStart live here. Provider keys and the model
 * catalog stay in the DSH Web UI ($DSH_HOME) — the plugin never writes them.
 */
public class DshHostHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(DshHostHandler.class);
    private static final String CHANNEL_SCRIPT = "channel-manager.js";
    private static final long STATUS_TIMEOUT_SECONDS = 30L;
    private static final long LIFECYCLE_TIMEOUT_SECONDS = 60L;
    private static final int MAX_OUTPUT_CHARS = 64_000;

    private static final String[] SUPPORTED_TYPES = {
            "get_dsh_status",
            "start_dsh_host",
            "stop_dsh_host",
            "save_dsh_settings",
    };

    private final Gson gson = new Gson();
    private final NodeDetector nodeDetector = NodeDetector.getInstance();
    private final EnvironmentConfigurator envConfigurator = new EnvironmentConfigurator();
    private final CodemossSettingsService settingsService = new CodemossSettingsService();

    public DshHostHandler(HandlerContext context) {
        super(context);
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    @Override
    public boolean handle(String type, String content) {
        switch (type) {
            case "get_dsh_status":
                CompletableFuture.runAsync(
                        () -> pushStatus(runDshCommand("status", null, STATUS_TIMEOUT_SECONDS)),
                        AppExecutorUtil.getAppExecutorService());
                return true;
            case "start_dsh_host":
                CompletableFuture.runAsync(
                        () -> pushStatus(runDshCommand("ensureHost", null, LIFECYCLE_TIMEOUT_SECONDS)),
                        AppExecutorUtil.getAppExecutorService());
                return true;
            case "stop_dsh_host":
                CompletableFuture.runAsync(
                        () -> pushStatus(runDshCommand("stopHost", null, STATUS_TIMEOUT_SECONDS)),
                        AppExecutorUtil.getAppExecutorService());
                return true;
            case "save_dsh_settings":
                saveSettings(content);
                CompletableFuture.runAsync(
                        () -> pushStatus(runDshCommand("status", null, STATUS_TIMEOUT_SECONDS)),
                        AppExecutorUtil.getAppExecutorService());
                return true;
            default:
                return false;
        }
    }

    private void saveSettings(String content) {
        try {
            if (content == null || content.isBlank()) {
                return;
            }
            JsonObject payload = JsonParser.parseString(content).getAsJsonObject();
            if (payload.has("bin")) {
                settingsService.setDshBin(payload.get("bin").isJsonNull() ? "" : payload.get("bin").getAsString());
            }
            if (payload.has("host")) {
                settingsService.setDshHost(payload.get("host").isJsonNull() ? "" : payload.get("host").getAsString());
            }
            if (payload.has("port") && !payload.get("port").isJsonNull()) {
                settingsService.setDshPort(payload.get("port").getAsInt());
            }
            if (payload.has("autoStart") && !payload.get("autoStart").isJsonNull()) {
                settingsService.setDshAutoStart(payload.get("autoStart").getAsBoolean());
            }
        } catch (Exception e) {
            LOG.warn("[DshHost] Failed to save settings: " + e.getMessage());
        }
    }

    private JsonObject runDshCommand(String command, JsonObject stdinPayload, long timeoutSeconds) {
        Process process = null;
        try {
            String node = nodeDetector.findNodeExecutable();
            BridgeDirectoryResolver resolver = BridgePreloader.getSharedResolver();
            File bridgeDir = resolver != null ? resolver.findSdkDir() : null;
            if (bridgeDir == null || !bridgeDir.exists()) {
                return errorPayload("Bridge directory not ready");
            }
            File script = new File(bridgeDir, CHANNEL_SCRIPT);
            if (!script.exists()) {
                return errorPayload("channel-manager.js not found");
            }

            List<String> cmd = new ArrayList<>(NodeDetector.buildNodeScriptCommand(
                    node, script.getAbsolutePath()));
            cmd.add("dsh");
            cmd.add(command);

            ProcessBuilder pb = new ProcessBuilder(cmd);
            pb.directory(bridgeDir);
            pb.redirectErrorStream(false);
            envConfigurator.updateProcessEnvironment(pb, node);
            DshEnvSupport.inject(pb.environment(), settingsService);
            if (stdinPayload != null) {
                pb.environment().put("DSH_USE_STDIN", "true");
            }

            process = pb.start();
            if (stdinPayload != null) {
                try (OutputStream stdin = process.getOutputStream()) {
                    stdin.write((gson.toJson(stdinPayload) + "\n").getBytes(StandardCharsets.UTF_8));
                    stdin.flush();
                }
            } else {
                process.getOutputStream().close();
            }

            StringBuilder output = new StringBuilder();
            Process finalProcess = process;
            Thread readerThread = new Thread(() -> {
                try (BufferedReader reader = new BufferedReader(
                        new InputStreamReader(finalProcess.getInputStream(), StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = reader.readLine()) != null) {
                        synchronized (output) {
                            if (output.length() < MAX_OUTPUT_CHARS) {
                                output.append(line).append('\n');
                            }
                        }
                    }
                } catch (Exception ignored) {
                }
            });
            readerThread.setDaemon(true);
            readerThread.start();

            boolean finished = process.waitFor(timeoutSeconds, TimeUnit.SECONDS);
            if (!finished) {
                process.destroyForcibly();
                return errorPayload("Timed out running dsh " + command);
            }
            readerThread.join(2000L);

            JsonObject payload = extractJsonObject(output.toString());
            return payload != null ? payload : errorPayload("No JSON output from dsh " + command);
        } catch (Exception e) {
            LOG.warn("[DshHost] " + command + " failed: " + e.getMessage());
            return errorPayload(e.getMessage() != null ? e.getMessage() : "dsh " + command + " failed");
        } finally {
            if (process != null && process.isAlive()) {
                process.destroyForcibly();
            }
        }
    }

    private JsonObject errorPayload(String message) {
        JsonObject payload = new JsonObject();
        payload.addProperty("success", false);
        payload.addProperty("provider", "dsh");
        payload.addProperty("error", message);
        return payload;
    }

    private JsonObject extractJsonObject(String raw) {
        if (raw == null || raw.isEmpty()) {
            return null;
        }
        String[] lines = raw.split("\\R");
        for (int i = lines.length - 1; i >= 0; i--) {
            String line = lines[i].trim();
            if (!line.startsWith("{") || !line.endsWith("}")) {
                continue;
            }
            try {
                JsonObject obj = JsonParser.parseString(line).getAsJsonObject();
                if (obj != null) {
                    return obj;
                }
            } catch (Exception ignored) {
            }
        }
        return null;
    }

    private void pushStatus(JsonObject payload) {
        if (payload == null) {
            payload = errorPayload("no result");
        }
        // Always echo the effective settings so the card can reflect them.
        try {
            JsonObject settings = new JsonObject();
            settings.addProperty("bin", settingsService.getDshBin());
            settings.addProperty("host", settingsService.getDshHost());
            settings.addProperty("port", settingsService.getDshPort());
            settings.addProperty("autoStart", settingsService.getDshAutoStart());
            payload.add("settings", settings);
        } catch (Exception ignored) {
        }
        callJavaScript("window.updateDshStatus", escapeJs(gson.toJson(payload)));
    }
}
