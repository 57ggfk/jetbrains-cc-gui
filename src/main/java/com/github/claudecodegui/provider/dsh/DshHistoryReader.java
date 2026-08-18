package com.github.claudecodegui.provider.dsh;

import com.github.claudecodegui.bridge.BridgeDirectoryResolver;
import com.github.claudecodegui.bridge.EnvironmentConfigurator;
import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.github.claudecodegui.startup.BridgePreloader;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.TimeUnit;

/**
 * Reads DSH session history through the Node bridge ({@code channel-manager.js
 * dsh listSessions|loadSession|deleteSession}).
 *
 * <p>Unlike the other CLI readers, DSH history is not on the local filesystem —
 * the persistent {@code dsh web} host owns it and answers over Host RPC. The
 * Node side attaches read-only (never spawns a host for history).
 */
public class DshHistoryReader {

    private static final Logger LOG = Logger.getInstance(DshHistoryReader.class);
    private static final String CHANNEL_SCRIPT = "channel-manager.js";
    private static final long TIMEOUT_SECONDS = 45L;
    private static final int MAX_OUTPUT_CHARS = 4_000_000;

    private final Gson gson = new Gson();
    private final NodeDetector nodeDetector = NodeDetector.getInstance();
    private final EnvironmentConfigurator envConfigurator = new EnvironmentConfigurator();
    private final CodemossSettingsService settingsService = new CodemossSettingsService();

    /**
     * Sessions for one project, shaped like the other CLI readers
     * ({@code {success, sessions[], sessionCount, provider, total}}).
     */
    public String getSessionsForProjectAsJson(String projectPath) {
        JsonObject stdin = new JsonObject();
        stdin.addProperty("cwd", projectPath != null ? projectPath : "");
        JsonObject payload = runDshCommand("listSessions", stdin);
        if (payload == null) {
            JsonObject error = new JsonObject();
            error.addProperty("success", false);
            error.addProperty("provider", "dsh");
            error.add("sessions", new JsonArray());
            error.addProperty("error", "DSH bridge returned no session list");
            return gson.toJson(error);
        }
        return gson.toJson(payload);
    }

    /**
     * One session's messages in the Claude-shaped JSON object list consumed by
     * SessionMessageOrchestrator.
     */
    public List<JsonObject> getSessionMessages(String sessionId, String cwd) {
        if (sessionId == null || sessionId.isBlank()) {
            return Collections.emptyList();
        }
        JsonObject stdin = new JsonObject();
        stdin.addProperty("sessionId", sessionId.trim());
        JsonObject payload = runDshCommand("loadSession", stdin);
        if (payload == null || !payload.has("success") || !payload.get("success").getAsBoolean()) {
            LOG.warn("[DSH] loadSession failed for " + sessionId + ": "
                    + (payload != null && payload.has("error") ? payload.get("error").getAsString() : "no payload"));
            return Collections.emptyList();
        }
        List<JsonObject> messages = new ArrayList<>();
        if (payload.has("messages") && payload.get("messages").isJsonArray()) {
            for (var element : payload.getAsJsonArray("messages")) {
                if (element.isJsonObject()) {
                    messages.add(element.getAsJsonObject());
                }
            }
        }
        return messages;
    }

    /**
     * Archive a session (the DSH "delete" — host-side archive, not a physical
     * log delete). Returns true when the host accepted the archive.
     */
    public boolean deleteSession(String sessionId, String projectPath) {
        if (sessionId == null || sessionId.isBlank()) {
            return false;
        }
        JsonObject stdin = new JsonObject();
        stdin.addProperty("sessionId", sessionId.trim());
        JsonObject payload = runDshCommand("deleteSession", stdin);
        boolean ok = payload != null
                && payload.has("success")
                && payload.get("success").getAsBoolean();
        if (!ok) {
            LOG.warn("[DSH] archive failed for " + sessionId + ": "
                    + (payload != null && payload.has("error") ? payload.get("error").getAsString() : "no payload"));
        }
        return ok;
    }

    /**
     * Run one read-only dsh channel command and return its last JSON stdout
     * object, or null on process/parse failure.
     */
    private JsonObject runDshCommand(String command, JsonObject stdinPayload) {
        Process process = null;
        try {
            String node = nodeDetector.findNodeExecutable();
            BridgeDirectoryResolver resolver = BridgePreloader.getSharedResolver();
            File bridgeDir = resolver != null ? resolver.findSdkDir() : null;
            if (bridgeDir == null || !bridgeDir.exists()) {
                LOG.warn("[DSH] Bridge directory not ready");
                return null;
            }
            File script = new File(bridgeDir, CHANNEL_SCRIPT);
            if (!script.exists()) {
                LOG.warn("[DSH] channel-manager.js not found in " + bridgeDir);
                return null;
            }

            List<String> cmd = new ArrayList<>(NodeDetector.buildNodeScriptCommand(
                    node, script.getAbsolutePath()));
            cmd.add("dsh");
            cmd.add(command);

            ProcessBuilder pb = new ProcessBuilder(cmd);
            pb.directory(bridgeDir);
            pb.redirectErrorStream(false);
            envConfigurator.updateProcessEnvironment(pb, node);
            pb.environment().put("DSH_USE_STDIN", "true");
            DshEnvSupport.inject(pb.environment(), settingsService);

            process = pb.start();

            if (stdinPayload != null) {
                try (OutputStream stdin = process.getOutputStream()) {
                    stdin.write((gson.toJson(stdinPayload) + "\n").getBytes(StandardCharsets.UTF_8));
                    stdin.flush();
                }
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

            boolean finished = process.waitFor(TIMEOUT_SECONDS, TimeUnit.SECONDS);
            if (!finished) {
                process.destroyForcibly();
                LOG.warn("[DSH] " + command + " timed out");
                return null;
            }
            readerThread.join(2000L);

            return extractJsonObject(output.toString());
        } catch (Exception e) {
            LOG.warn("[DSH] " + command + " failed: " + e.getMessage());
            return null;
        } finally {
            if (process != null && process.isAlive()) {
                process.destroyForcibly();
            }
        }
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
                if (obj != null && (obj.has("success") || obj.has("sessions") || obj.has("messages"))) {
                    return obj;
                }
            } catch (Exception ignored) {
            }
        }
        return null;
    }
}
