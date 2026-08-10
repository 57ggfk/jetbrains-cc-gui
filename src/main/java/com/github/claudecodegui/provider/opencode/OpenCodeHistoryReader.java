package com.github.claudecodegui.provider.opencode;

import com.github.claudecodegui.bridge.NodeDetector;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.diagnostic.Logger;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.stream.Stream;

/**
 * Reads OpenCode CLI session history from
 * {@code ~/.local/share/opencode/storage/} (Windows: {@code %USERPROFILE%\.local\share\opencode\storage\}).
 *
 * <p>Layout:
 * <pre>
 *   storage/session/&lt;projectHash&gt;/ses_xxx.json
 *   storage/message/ses_xxx/msg_yyy.json
 *   storage/part/msg_yyy/prt_zzz.json
 * </pre>
 *
 * <p>Sessions are filtered by the {@code directory} field (normalized, case-insensitive)
 * so Windows backslash paths match Unix-style paths written by the CLI.
 */
public class OpenCodeHistoryReader {

    private static final Logger LOG = Logger.getInstance(OpenCodeHistoryReader.class);
    private static final int MAX_TITLE_CHARS = 80;
    private static final int MAX_TOOL_RESULT_CHARS = 20_000;

    private final Gson gson;
    private final Path storageRoot;

    public OpenCodeHistoryReader() {
        this(defaultStorageRoot(), new Gson());
    }

    OpenCodeHistoryReader(Path storageRoot, Gson gson) {
        this.storageRoot = storageRoot;
        this.gson = gson;
    }

    private static Path defaultStorageRoot() {
        String home = NodeDetector.resolveHomeForFileOps();
        String xdg = System.getenv("XDG_DATA_HOME");
        if (xdg != null && !xdg.trim().isEmpty()) {
            return Paths.get(xdg.trim(), "opencode", "storage");
        }
        // OpenCode docs: macOS/Linux ~/.local/share/opencode ; Windows %USERPROFILE%\.local\share\opencode
        return Paths.get(home, ".local", "share", "opencode", "storage");
    }

    public static class SessionInfo {
        public String sessionId;
        public String title;
        public int messageCount;
        public long lastTimestamp;
        public long firstTimestamp;
        public String cwd;
        public long fileSize;
        public String provider = "opencode";
    }

    public String getSessionsForProjectAsJson(String projectPath) {
        try {
            List<SessionInfo> sessions = listSessionsForProject(projectPath);
            Map<String, Object> result = new HashMap<>();
            result.put("success", true);
            result.put("sessions", sessions);
            result.put("sessionCount", sessions.size());
            result.put("provider", "opencode");
            int totalMessages = sessions.stream().mapToInt(s -> s.messageCount).sum();
            result.put("total", totalMessages);
            return gson.toJson(result);
        } catch (Exception e) {
            LOG.error("[OpenCodeHistoryReader] Failed to list sessions: " + e.getMessage(), e);
            Map<String, Object> error = new HashMap<>();
            error.put("success", false);
            error.put("error", "Failed to read OpenCode sessions: " + e.getMessage());
            return gson.toJson(error);
        }
    }

    public List<SessionInfo> listSessionsForProject(String projectPath) throws IOException {
        List<SessionInfo> all = listAllSessions();
        if (projectPath == null || projectPath.trim().isEmpty()) {
            return all;
        }
        List<SessionInfo> filtered = new ArrayList<>();
        for (SessionInfo session : all) {
            if (session.cwd != null && pathsMatch(session.cwd, projectPath)) {
                filtered.add(session);
            }
        }
        filtered.sort(Comparator.comparingLong((SessionInfo s) -> s.lastTimestamp).reversed());
        return filtered;
    }

    public List<SessionInfo> listAllSessions() throws IOException {
        List<SessionInfo> sessions = new ArrayList<>();
        Path sessionRoot = storageRoot.resolve("session");
        if (!Files.isDirectory(sessionRoot)) {
            LOG.info("[OpenCodeHistoryReader] Session root missing: " + sessionRoot);
            return sessions;
        }
        try (Stream<Path> files = Files.walk(sessionRoot, 2)) {
            files.filter(p -> Files.isRegularFile(p) && p.getFileName().toString().endsWith(".json"))
                    .forEach(file -> {
                        SessionInfo info = readSessionSummary(file);
                        if (info != null) {
                            sessions.add(info);
                        }
                    });
        }
        sessions.sort(Comparator.comparingLong((SessionInfo s) -> s.lastTimestamp).reversed());
        return sessions;
    }

    private SessionInfo readSessionSummary(Path file) {
        try {
            String raw = Files.readString(file, StandardCharsets.UTF_8);
            JsonObject obj = JsonParser.parseString(raw).getAsJsonObject();
            String id = text(obj, "id");
            if (id == null || id.isBlank() || !isSafeSessionId(id)) {
                return null;
            }
            // Skip child/background agent sessions in the main list when parentID is set?
            // Keep them — user may want full history; title usually marks them.

            SessionInfo info = new SessionInfo();
            info.sessionId = id;
            info.cwd = text(obj, "directory");
            info.provider = "opencode";
            info.title = text(obj, "title");
            info.fileSize = Files.size(file);

            JsonObject time = obj.has("time") && obj.get("time").isJsonObject()
                    ? obj.getAsJsonObject("time")
                    : null;
            if (time != null) {
                info.firstTimestamp = longField(time, "created");
                info.lastTimestamp = longField(time, "updated");
            }
            if (info.lastTimestamp <= 0) {
                info.lastTimestamp = fileMtime(file);
            }
            if (info.firstTimestamp <= 0) {
                info.firstTimestamp = info.lastTimestamp;
            }

            Path msgDir = storageRoot.resolve("message").resolve(id);
            info.messageCount = countMessages(msgDir);
            if (info.title == null || info.title.isBlank()) {
                String firstUser = firstUserTitle(msgDir);
                info.title = firstUser != null
                        ? truncate(firstUser, MAX_TITLE_CHARS)
                        : "OpenCode session " + shortId(id);
            }
            return info;
        } catch (Exception e) {
            LOG.debug("[OpenCodeHistoryReader] Failed to read " + file + ": " + e.getMessage());
            return null;
        }
    }

    private int countMessages(Path msgDir) {
        if (!Files.isDirectory(msgDir)) {
            return 0;
        }
        int count = 0;
        try (DirectoryStream<Path> stream = Files.newDirectoryStream(msgDir, "*.json")) {
            for (Path ignored : stream) {
                count++;
            }
        } catch (IOException e) {
            return 0;
        }
        return count;
    }

    private String firstUserTitle(Path msgDir) {
        if (!Files.isDirectory(msgDir)) {
            return null;
        }
        try (DirectoryStream<Path> stream = Files.newDirectoryStream(msgDir, "*.json")) {
            List<Path> files = new ArrayList<>();
            for (Path p : stream) {
                files.add(p);
            }
            files.sort(Comparator.comparing(Path::getFileName));
            for (Path file : files) {
                try {
                    JsonObject msg = JsonParser.parseString(Files.readString(file, StandardCharsets.UTF_8))
                            .getAsJsonObject();
                    if (!"user".equals(text(msg, "role"))) {
                        continue;
                    }
                    if (msg.has("summary") && msg.get("summary").isJsonObject()) {
                        String t = text(msg.getAsJsonObject("summary"), "title");
                        if (t != null && !t.isBlank()) {
                            return t;
                        }
                    }
                    String fromParts = extractMessageText(text(msg, "id"));
                    if (fromParts != null && !fromParts.isBlank()) {
                        return fromParts;
                    }
                } catch (Exception ignored) {
                }
            }
        } catch (IOException ignored) {
        }
        return null;
    }

    public List<JsonObject> getSessionMessages(String sessionId, String cwd) throws IOException {
        if (!isSafeSessionId(sessionId)) {
            return List.of();
        }
        Path msgDir = storageRoot.resolve("message").resolve(sessionId.trim());
        if (!Files.isDirectory(msgDir)) {
            LOG.warn("[OpenCodeHistoryReader] Message dir missing for " + sessionId);
            return List.of();
        }

        List<Path> files = new ArrayList<>();
        try (DirectoryStream<Path> stream = Files.newDirectoryStream(msgDir, "*.json")) {
            for (Path p : stream) {
                files.add(p);
            }
        }
        files.sort(Comparator
                .comparingLong(this::messageCreated)
                .thenComparing(p -> p.getFileName().toString()));

        List<JsonObject> out = new ArrayList<>();
        int counter = 0;
        for (Path file : files) {
            JsonObject msg;
            try {
                msg = JsonParser.parseString(Files.readString(file, StandardCharsets.UTF_8)).getAsJsonObject();
            } catch (Exception e) {
                continue;
            }
            String role = text(msg, "role");
            String messageId = text(msg, "id");
            if ("user".equals(role)) {
                String text = extractMessageText(messageId);
                if (text == null || text.isBlank()) {
                    // Fall back to summary title when parts are missing
                    if (msg.has("summary") && msg.get("summary").isJsonObject()) {
                        text = text(msg.getAsJsonObject("summary"), "title");
                    }
                }
                if (text == null || text.isBlank()) {
                    continue;
                }
                counter++;
                out.add(buildUserTextMessage(text, messageId != null ? messageId : "oc-user-" + counter));
            } else if ("assistant".equals(role)) {
                List<JsonObject> converted = convertAssistantParts(messageId, counter);
                counter += converted.size();
                out.addAll(converted);
            }
        }
        return out;
    }

    private long messageCreated(Path file) {
        try {
            JsonObject msg = JsonParser.parseString(Files.readString(file, StandardCharsets.UTF_8)).getAsJsonObject();
            if (msg.has("time") && msg.get("time").isJsonObject()) {
                long created = longField(msg.getAsJsonObject("time"), "created");
                if (created > 0) {
                    return created;
                }
            }
        } catch (Exception ignored) {
        }
        return fileMtime(file);
    }

    private String extractMessageText(String messageId) {
        if (messageId == null || messageId.isBlank()) {
            return null;
        }
        Path partDir = storageRoot.resolve("part").resolve(messageId);
        if (!Files.isDirectory(partDir)) {
            return null;
        }
        StringBuilder sb = new StringBuilder();
        try (DirectoryStream<Path> stream = Files.newDirectoryStream(partDir, "*.json")) {
            List<Path> parts = new ArrayList<>();
            for (Path p : stream) {
                parts.add(p);
            }
            parts.sort(Comparator.comparing(p -> p.getFileName().toString()));
            for (Path partFile : parts) {
                try {
                    JsonObject part = JsonParser.parseString(Files.readString(partFile, StandardCharsets.UTF_8))
                            .getAsJsonObject();
                    if ("text".equals(text(part, "type"))) {
                        String t = text(part, "text");
                        if (t != null && !t.isEmpty()) {
                            if (sb.length() > 0) {
                                sb.append('\n');
                            }
                            sb.append(t);
                        }
                    }
                } catch (Exception ignored) {
                }
            }
        } catch (IOException e) {
            return null;
        }
        return sb.length() > 0 ? sb.toString() : null;
    }

    private List<JsonObject> convertAssistantParts(String messageId, int counterBase) {
        List<JsonObject> out = new ArrayList<>();
        if (messageId == null || messageId.isBlank()) {
            return out;
        }
        Path partDir = storageRoot.resolve("part").resolve(messageId);
        if (!Files.isDirectory(partDir)) {
            return out;
        }
        List<Path> parts = new ArrayList<>();
        try (DirectoryStream<Path> stream = Files.newDirectoryStream(partDir, "*.json")) {
            for (Path p : stream) {
                parts.add(p);
            }
        } catch (IOException e) {
            return out;
        }
        parts.sort(Comparator.comparing(p -> p.getFileName().toString()));

        int n = counterBase;
        StringBuilder textBuf = new StringBuilder();
        StringBuilder thinkBuf = new StringBuilder();
        for (Path partFile : parts) {
            JsonObject part;
            try {
                part = JsonParser.parseString(Files.readString(partFile, StandardCharsets.UTF_8)).getAsJsonObject();
            } catch (Exception e) {
                continue;
            }
            String type = text(part, "type");
            if ("text".equals(type)) {
                String t = text(part, "text");
                if (t != null && !t.isEmpty()) {
                    if (textBuf.length() > 0) {
                        textBuf.append('\n');
                    }
                    textBuf.append(t);
                }
            } else if ("reasoning".equals(type)) {
                String t = text(part, "text");
                if (t != null && !t.isEmpty()) {
                    if (thinkBuf.length() > 0) {
                        thinkBuf.append('\n');
                    }
                    thinkBuf.append(t);
                }
            } else if ("tool".equals(type)) {
                if (thinkBuf.length() > 0) {
                    n++;
                    out.add(buildAssistantThinkingMessage(thinkBuf.toString(), messageId + "-think-" + n));
                    thinkBuf.setLength(0);
                }
                if (textBuf.length() > 0) {
                    n++;
                    out.add(buildAssistantTextMessage(textBuf.toString(), messageId + "-text-" + n));
                    textBuf.setLength(0);
                }
                String callId = text(part, "callID");
                if (callId == null || callId.isBlank()) {
                    callId = text(part, "id");
                }
                if (callId == null || callId.isBlank()) {
                    callId = "oc-tool-" + (++n);
                }
                String toolName = text(part, "tool");
                if (toolName == null || toolName.isBlank()) {
                    toolName = "tool";
                }
                JsonObject input = new JsonObject();
                String resultText = "";
                boolean isError = false;
                if (part.has("state") && part.get("state").isJsonObject()) {
                    JsonObject state = part.getAsJsonObject("state");
                    if (state.has("input") && state.get("input").isJsonObject()) {
                        input = state.getAsJsonObject("input");
                    }
                    String status = text(state, "status");
                    isError = "error".equals(status) || "failed".equals(status);
                    if (state.has("output") && !state.get("output").isJsonNull()) {
                        resultText = stringify(state.get("output"));
                    } else if (state.has("error") && !state.get("error").isJsonNull()) {
                        resultText = stringify(state.get("error"));
                        isError = true;
                    }
                }
                out.add(buildToolUseMessage(callId, toolName, input));
                if (resultText != null && !resultText.isBlank()) {
                    out.add(buildToolResultMessage(callId, truncate(resultText, MAX_TOOL_RESULT_CHARS), isError));
                }
            }
        }
        if (thinkBuf.length() > 0) {
            n++;
            out.add(buildAssistantThinkingMessage(thinkBuf.toString(), messageId + "-think-" + n));
        }
        if (textBuf.length() > 0) {
            n++;
            out.add(buildAssistantTextMessage(textBuf.toString(), messageId + "-text-" + n));
        }
        return out;
    }

    public boolean deleteSession(String sessionId, String projectPath) throws IOException {
        if (!isSafeSessionId(sessionId)) {
            return false;
        }
        String id = sessionId.trim();
        boolean deleted = false;
        // Remove session metadata files under storage/session/**/id.json
        Path sessionRoot = storageRoot.resolve("session");
        if (Files.isDirectory(sessionRoot)) {
            try (Stream<Path> files = Files.walk(sessionRoot, 2)) {
                List<Path> matches = files
                        .filter(p -> Files.isRegularFile(p) && p.getFileName().toString().equals(id + ".json"))
                        .toList();
                for (Path match : matches) {
                    Files.deleteIfExists(match);
                    deleted = true;
                }
            }
        }
        // Remove message + part trees
        Path msgDir = storageRoot.resolve("message").resolve(id);
        if (Files.isDirectory(msgDir)) {
            // Collect part dirs from messages then delete messages
            try (DirectoryStream<Path> stream = Files.newDirectoryStream(msgDir, "*.json")) {
                for (Path msgFile : stream) {
                    try {
                        JsonObject msg = JsonParser.parseString(Files.readString(msgFile, StandardCharsets.UTF_8))
                                .getAsJsonObject();
                        String messageId = text(msg, "id");
                        if (messageId != null && isSafeSessionId(messageId)) {
                            deleteRecursively(storageRoot.resolve("part").resolve(messageId));
                        }
                    } catch (Exception ignored) {
                    }
                    Files.deleteIfExists(msgFile);
                    deleted = true;
                }
            }
            try {
                Files.deleteIfExists(msgDir);
            } catch (Exception ignored) {
            }
        }
        return deleted;
    }

    private static void deleteRecursively(Path root) throws IOException {
        if (root == null || !Files.exists(root)) {
            return;
        }
        if (Files.isDirectory(root)) {
            try (DirectoryStream<Path> stream = Files.newDirectoryStream(root)) {
                for (Path child : stream) {
                    deleteRecursively(child);
                }
            }
        }
        Files.deleteIfExists(root);
    }

    private static JsonObject buildUserTextMessage(String text, String uuid) {
        JsonObject root = new JsonObject();
        root.addProperty("type", "user");
        root.addProperty("uuid", uuid);
        JsonObject message = new JsonObject();
        message.addProperty("role", "user");
        JsonArray content = new JsonArray();
        JsonObject block = new JsonObject();
        block.addProperty("type", "text");
        block.addProperty("text", text);
        content.add(block);
        message.add("content", content);
        root.add("message", message);
        return root;
    }

    private static JsonObject buildAssistantTextMessage(String text, String uuid) {
        JsonObject root = new JsonObject();
        root.addProperty("type", "assistant");
        root.addProperty("uuid", uuid);
        JsonObject message = new JsonObject();
        message.addProperty("role", "assistant");
        JsonArray content = new JsonArray();
        JsonObject block = new JsonObject();
        block.addProperty("type", "text");
        block.addProperty("text", text);
        content.add(block);
        message.add("content", content);
        root.add("message", message);
        return root;
    }

    private static JsonObject buildAssistantThinkingMessage(String text, String uuid) {
        JsonObject root = new JsonObject();
        root.addProperty("type", "assistant");
        root.addProperty("uuid", uuid);
        JsonObject message = new JsonObject();
        message.addProperty("role", "assistant");
        JsonArray content = new JsonArray();
        JsonObject block = new JsonObject();
        block.addProperty("type", "thinking");
        block.addProperty("thinking", text);
        content.add(block);
        message.add("content", content);
        root.add("message", message);
        return root;
    }

    private static JsonObject buildToolUseMessage(String id, String name, JsonObject input) {
        JsonObject root = new JsonObject();
        root.addProperty("type", "assistant");
        JsonObject message = new JsonObject();
        message.addProperty("role", "assistant");
        JsonArray content = new JsonArray();
        JsonObject block = new JsonObject();
        block.addProperty("type", "tool_use");
        block.addProperty("id", id);
        block.addProperty("name", name);
        block.add("input", input != null ? input : new JsonObject());
        content.add(block);
        message.add("content", content);
        root.add("message", message);
        return root;
    }

    private static JsonObject buildToolResultMessage(String toolUseId, String contentText, boolean isError) {
        JsonObject root = new JsonObject();
        root.addProperty("type", "user");
        JsonObject message = new JsonObject();
        message.addProperty("role", "user");
        JsonArray content = new JsonArray();
        JsonObject block = new JsonObject();
        block.addProperty("type", "tool_result");
        block.addProperty("tool_use_id", toolUseId);
        block.addProperty("is_error", isError);
        block.addProperty("content", contentText != null ? contentText : "");
        content.add(block);
        message.add("content", content);
        root.add("message", message);
        return root;
    }

    static String normalizePath(String path) {
        if (path == null) {
            return "";
        }
        String p = path.trim().replace('\\', '/');
        if (p.length() >= 2 && p.charAt(1) == ':') {
            p = Character.toLowerCase(p.charAt(0)) + p.substring(1);
        }
        while (p.endsWith("/") && p.length() > 1) {
            p = p.substring(0, p.length() - 1);
        }
        return p;
    }

    static boolean pathsMatch(String sessionCwd, String projectPath) {
        if (sessionCwd == null || projectPath == null) {
            return false;
        }
        String a = normalizePath(sessionCwd).toLowerCase(Locale.ROOT);
        String b = normalizePath(projectPath).toLowerCase(Locale.ROOT);
        return a.equals(b);
    }

    static boolean isSafeSessionId(String sessionId) {
        if (sessionId == null || sessionId.trim().isEmpty()) {
            return false;
        }
        String id = sessionId.trim();
        if (id.contains("/") || id.contains("\\") || id.contains("..")) {
            return false;
        }
        return id.matches("^[A-Za-z0-9._-]+$");
    }

    private static String text(JsonObject obj, String field) {
        if (obj == null || !obj.has(field) || obj.get(field).isJsonNull()) {
            return null;
        }
        try {
            return obj.get(field).getAsString();
        } catch (Exception e) {
            return null;
        }
    }

    private static long longField(JsonObject obj, String field) {
        if (obj == null || !obj.has(field) || obj.get(field).isJsonNull()) {
            return 0L;
        }
        try {
            return obj.get(field).getAsLong();
        } catch (Exception e) {
            return 0L;
        }
    }

    private static long fileMtime(Path path) {
        try {
            return Files.getLastModifiedTime(path).toMillis();
        } catch (IOException e) {
            return 0L;
        }
    }

    private static String stringify(JsonElement el) {
        if (el == null || el.isJsonNull()) {
            return "";
        }
        if (el.isJsonPrimitive()) {
            return el.getAsString();
        }
        return el.toString();
    }

    private static String truncate(String text, int max) {
        if (text == null) {
            return "";
        }
        String t = text.trim().replaceAll("\\s+", " ");
        if (t.length() <= max) {
            return t;
        }
        return t.substring(0, max - 1) + "…";
    }

    private static String shortId(String id) {
        if (id == null) {
            return "";
        }
        return id.length() <= 10 ? id : id.substring(0, 10);
    }
}
