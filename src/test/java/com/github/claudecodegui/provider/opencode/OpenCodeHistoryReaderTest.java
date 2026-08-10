package com.github.claudecodegui.provider.opencode;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class OpenCodeHistoryReaderTest {

    @Test
    public void pathsMatchNormalizesWindowsSeparators() {
        assertTrue(OpenCodeHistoryReader.pathsMatch(
                "D:\\software\\my project",
                "d:/software/my project"));
    }

    @Test
    public void listsAndLoadsSessionFromStorageLayout() throws Exception {
        Path storage = Files.createTempDirectory("oc-history-test");
        String sessionId = "ses_test123abc";
        String projectHash = "abc123hash";

        Path sessionFile = storage.resolve("session").resolve(projectHash).resolve(sessionId + ".json");
        Files.createDirectories(sessionFile.getParent());
        Files.writeString(sessionFile, """
                {
                  "id": "%s",
                  "projectID": "%s",
                  "directory": "D:\\\\develop\\\\my-app",
                  "title": "Windows OpenCode chat",
                  "time": { "created": 1000, "updated": 2000 }
                }
                """.formatted(sessionId, projectHash), StandardCharsets.UTF_8);

        String userMsgId = "msg_user1";
        String asstMsgId = "msg_asst1";
        Path userMsg = storage.resolve("message").resolve(sessionId).resolve(userMsgId + ".json");
        Path asstMsg = storage.resolve("message").resolve(sessionId).resolve(asstMsgId + ".json");
        Files.createDirectories(userMsg.getParent());
        Files.writeString(userMsg, """
                {"id":"%s","sessionID":"%s","role":"user","time":{"created":1001}}
                """.formatted(userMsgId, sessionId), StandardCharsets.UTF_8);
        Files.writeString(asstMsg, """
                {"id":"%s","sessionID":"%s","role":"assistant","time":{"created":1002}}
                """.formatted(asstMsgId, sessionId), StandardCharsets.UTF_8);

        Path userPart = storage.resolve("part").resolve(userMsgId).resolve("prt_1.json");
        Path asstText = storage.resolve("part").resolve(asstMsgId).resolve("prt_2.json");
        Path asstTool = storage.resolve("part").resolve(asstMsgId).resolve("prt_3.json");
        Files.createDirectories(userPart.getParent());
        Files.createDirectories(asstText.getParent());
        Files.writeString(userPart, """
                {"id":"prt_1","type":"text","text":"hello opencode","messageID":"%s"}
                """.formatted(userMsgId), StandardCharsets.UTF_8);
        Files.writeString(asstText, """
                {"id":"prt_2","type":"text","text":"world","messageID":"%s"}
                """.formatted(asstMsgId), StandardCharsets.UTF_8);
        Files.writeString(asstTool, """
                {
                  "id":"prt_3","type":"tool","callID":"call_1","tool":"read",
                  "messageID":"%s",
                  "state":{"status":"completed","input":{"filePath":"a.txt"},"output":"ok"}
                }
                """.formatted(asstMsgId), StandardCharsets.UTF_8);

        OpenCodeHistoryReader reader = new OpenCodeHistoryReader(storage, new Gson());

        List<OpenCodeHistoryReader.SessionInfo> listed =
                reader.listSessionsForProject("D:/develop/my-app");
        assertEquals(1, listed.size());
        assertEquals(sessionId, listed.get(0).sessionId);
        assertEquals("Windows OpenCode chat", listed.get(0).title);
        assertEquals(2, listed.get(0).messageCount);

        List<JsonObject> messages = reader.getSessionMessages(sessionId, "D:\\develop\\my-app");
        assertFalse(messages.isEmpty());
        assertEquals("user", messages.get(0).get("type").getAsString());
        assertTrue(messages.size() >= 2);

        boolean hasTool = messages.stream().anyMatch(m ->
                m.has("message")
                        && m.getAsJsonObject("message").has("content")
                        && m.getAsJsonObject("message").getAsJsonArray("content").toString().contains("tool_use"));
        assertTrue(hasTool);

        assertTrue(reader.deleteSession(sessionId, "D:/develop/my-app"));
        assertTrue(reader.listSessionsForProject("D:/develop/my-app").isEmpty());
    }
}
