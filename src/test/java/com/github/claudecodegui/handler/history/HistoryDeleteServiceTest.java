package com.github.claudecodegui.handler.history;

import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.session.ClaudeSession;
import com.github.claudecodegui.util.PathUtils;
import com.google.gson.JsonObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class HistoryDeleteServiceTest {

    @Rule
    public TemporaryFolder temporaryFolder = new TemporaryFolder();

    @Test
    public void parseSessionIdsAcceptsArrayPayload() {
        assertEquals(
                Arrays.asList("session-one", "session-two"),
                HistoryDeleteService.parseSessionIds("[\"session-one\",\"session-two\"]"));
    }

    @Test
    public void parseSessionIdsAcceptsObjectPayload() {
        assertEquals(
                Arrays.asList("session-one", "session-two"),
                HistoryDeleteService.parseSessionIds("{\"sessionIds\":[\"session-one\",\"session-two\"]}"));
    }

    @Test
    public void parseSessionIdsTrimsAndDeduplicates() {
        assertEquals(
                Arrays.asList("session-one", "session-two"),
                HistoryDeleteService.parseSessionIds("[\" session-one \",\"session-two\",\"session-one\",\"\"]"));
    }

    @Test
    public void parseSessionIdsRejectsMissingPayload() {
        assertEquals(Collections.emptyList(), HistoryDeleteService.parseSessionIds(""));
        assertEquals(Collections.emptyList(), HistoryDeleteService.parseSessionIds(null));
    }

    @Test
    public void parseSessionIdsRejectsMalformedPayload() {
        assertEquals(Collections.emptyList(), HistoryDeleteService.parseSessionIds("["));
    }

    @Test
    public void codexFileMatchAnchorsToHyphenAndExtension() {
        String sessionId = "019b690b-c87f-7350-8f45-bc3dbb59ff77";
        Path matching = Paths.get("/tmp/rollout-2025-12-29T15-38-58-" + sessionId + ".jsonl");
        assertTrue(HistoryDeleteService.isCodexSessionFileMatch(matching, sessionId));
    }

    @Test
    public void codexFileMatchRejectsSubstringWithinNeighbouringSessionId() {
        // Different session whose UUID merely contains the target as a substring
        String target = "abcd1234";
        Path neighbour = Paths.get("/tmp/rollout-2025-12-29T15-38-58-prefix" + target + "suffix.jsonl");
        assertFalse(HistoryDeleteService.isCodexSessionFileMatch(neighbour, target));
    }

    @Test
    public void codexFileMatchRejectsNonJsonlExtension() {
        String sessionId = "019b690b-c87f-7350";
        Path wrongExt = Paths.get("/tmp/rollout-2025-12-29T15-38-58-" + sessionId + ".log");
        assertFalse(HistoryDeleteService.isCodexSessionFileMatch(wrongExt, sessionId));
    }

    @Test
    public void codexFileDiscoveryIncludesSubagentDescendantsWithoutParentRollout() throws Exception {
        String parentId = "019f6887-814a-7af1-ab43-4fa5e5fb8e1b";
        String childId = "019f6889-a450-7bb3-8589-59de68b6bb4d";
        String grandchildId = "019f688a-a450-7bb3-8589-59de68b6bb4d";
        Path sessionDir = temporaryFolder.newFolder("sessions").toPath();

        Path child = writeCodexRollout(sessionDir, childId, parentId, "child");
        Path grandchild = writeCodexRollout(sessionDir, grandchildId, childId, "grandchild");
        Path unrelated = writeCodexRollout(sessionDir, "019f6999-a450-7bb3-8589-59de68b6bb4d",
                "019f6000-0000-0000-0000-000000000000", parentId);

        List<Path> matches = HistoryDeleteService.findCodexSessionFiles(sessionDir, parentId);

        assertEquals(new HashSet<>(Arrays.asList(child, grandchild)), new HashSet<>(matches));
        assertFalse(matches.contains(unrelated));
    }

    @Test
    public void codexBatchDiscoveryBuildsOneSnapshotForMultipleRoots() throws Exception {
        String parentId = "019f6887-814a-7af1-ab43-4fa5e5fb8e1b";
        String childId = "019f6889-a450-7bb3-8589-59de68b6bb4d";
        String grandchildId = "019f688a-a450-7bb3-8589-59de68b6bb4d";
        Path sessionDir = temporaryFolder.newFolder("batch-sessions").toPath();

        Path child = writeCodexRollout(sessionDir, childId, parentId, "child");
        Path grandchild = writeCodexRollout(sessionDir, grandchildId, childId, "grandchild");

        Map<String, List<Path>> matches = HistoryDeleteService.findCodexSessionFiles(
                sessionDir, Arrays.asList(parentId, childId));

        assertEquals(new HashSet<>(Arrays.asList(child, grandchild)),
                new HashSet<>(matches.get(parentId)));
        assertEquals(new HashSet<>(Arrays.asList(child, grandchild)),
                new HashSet<>(matches.get(childId)));
    }

    @Test
    public void codexDeletionCompletesOnlyWhenEveryMatchedFileSucceeds() {
        Path parent = Paths.get("parent.jsonl");
        Path child = Paths.get("child.jsonl");

        assertTrue(HistoryDeleteService.isCodexSessionDeletionComplete(
                Arrays.asList(parent, child), Collections.emptySet()));
        assertFalse(HistoryDeleteService.isCodexSessionDeletionComplete(
                Arrays.asList(parent, child), Collections.singleton(child)));
        assertFalse(HistoryDeleteService.isCodexSessionDeletionComplete(
                Collections.emptyList(), Collections.emptySet()));
    }

    @Test
    public void quiescesOnlyTheMatchingProviderSessionBeforeDeletion() {
        RecordingClaudeSession matching = new RecordingClaudeSession("session-1", "codex");
        HistoryDeleteService.quiesceActiveSessionForDeletion(
                matching, Collections.singleton("session-1"), "codex").join();
        assertTrue(matching.interrupted);

        RecordingClaudeSession otherSession = new RecordingClaudeSession("session-2", "codex");
        HistoryDeleteService.quiesceActiveSessionForDeletion(
                otherSession, Collections.singleton("session-1"), "codex").join();
        assertFalse(otherSession.interrupted);

        RecordingClaudeSession otherProvider = new RecordingClaudeSession("session-1", "claude");
        HistoryDeleteService.quiesceActiveSessionForDeletion(
                otherProvider, Collections.singleton("session-1"), "codex").join();
        assertFalse(otherProvider.interrupted);
    }

    @Test
    public void failedQuiesceDoesNotStartDeletionContinuation() {
        RecordingClaudeSession matching = new RecordingClaudeSession("session-1", "codex") {
            @Override
            public CompletableFuture<Void> interrupt() {
                CompletableFuture<Void> failed = new CompletableFuture<>();
                failed.completeExceptionally(new IllegalStateException("interrupt failed"));
                return failed;
            }
        };
        AtomicBoolean deletionStarted = new AtomicBoolean(false);

        CompletableFuture<Void> deletion = HistoryDeleteService.quiesceActiveSessionForDeletion(
                matching, Collections.singleton("session-1"), "codex")
                .thenRun(() -> deletionStarted.set(true));

        try {
            deletion.join();
        } catch (CompletionException expected) {
            assertEquals("interrupt failed", expected.getCause().getMessage());
        }
        assertFalse(deletionStarted.get());
        assertTrue(deletion.isCompletedExceptionally());
    }

    @Test
    public void deleteSessionPayloadProviderOverridesStalePanelState() throws Exception {
        // The panel's currentProvider can be stale after switching chat providers
        // without reopening the history list; the payload provider must win so a
        // Claude session is not routed into the Codex delete branch.
        HandlerContext context = new HandlerContext(null, null, null, null, null);
        RecordingHistoryLoadService historyLoadService = new RecordingHistoryLoadService(context);
        HistoryDeleteService service = new HistoryDeleteService(context, null, historyLoadService);

        service.handleDeleteSession("{\"sessionId\":\"session-1\",\"provider\":\"claude\"}", "codex");

        assertTrue(historyLoadService.awaitReload());
        assertEquals("claude", historyLoadService.provider);
    }

    @Test
    public void batchDeleteQuiescesTheActiveSessionWithThePayloadProvider() throws Exception {
        // Same stale-panel scenario as the single delete: the interrupt has to be
        // routed by the payload provider, otherwise the CLI keeps appending to a
        // transcript this batch is about to delete.
        HandlerContext context = new HandlerContext(null, null, null, null, null);
        RecordingClaudeSession active = new RecordingClaudeSession("session-1", "claude");
        context.setSession(active);
        RecordingHistoryLoadService historyLoadService = new RecordingHistoryLoadService(context);
        HistoryDeleteService service = new HistoryDeleteService(context, null, historyLoadService);

        service.handleDeleteSessions("{\"sessionIds\":[\"session-1\"],\"provider\":\"claude\"}", "codex");

        assertTrue(historyLoadService.awaitReload());
        assertTrue("the active session must be interrupted before its files go away",
                active.interrupted);
        // The reload follows the deleted rows, not the panel: reloading the panel's
        // provider would swap the visible list for another provider's rows.
        assertEquals("claude", historyLoadService.provider);
    }

    @Test
    public void abortedDeletionReloadsHistoryAfterOptimisticFrontendRemoval() throws Exception {
        HandlerContext context = new HandlerContext(null, null, null, null, null);
        context.setSession(new RecordingClaudeSession("session-1", "codex") {
            @Override
            public CompletableFuture<Void> interrupt() {
                CompletableFuture<Void> failed = new CompletableFuture<>();
                failed.completeExceptionally(new IllegalStateException("interrupt failed"));
                return failed;
            }
        });
        RecordingHistoryLoadService historyLoadService = new RecordingHistoryLoadService(context);
        HistoryDeleteService service = new HistoryDeleteService(context, null, historyLoadService);

        service.handleDeleteSession("session-1", "codex");

        assertTrue(historyLoadService.awaitReload());
        assertEquals("codex", historyLoadService.provider);
    }

    @Test
    public void payloadProviderWinsOverStalePanelProvider() {
        JsonObject request = HistoryDeleteService.parseRequestObject(
                "{\"sessionId\":\"session-1\",\"provider\":\"claude\"}");

        assertEquals("claude", HistoryDeleteService.resolveProvider(request, "codex"));
    }

    @Test
    public void missingPayloadProviderFallsBackToPanelProvider() {
        assertEquals("codex", HistoryDeleteService.resolveProvider(null, "codex"));
        assertEquals("codex", HistoryDeleteService.resolveProvider(
                HistoryDeleteService.parseRequestObject("{\"sessionId\":\"session-1\"}"), "codex"));
    }

    @Test
    public void sidecarDirectoryRemovalDeletesSubagentTranscripts() throws Exception {
        Path projectDir = temporaryFolder.newFolder("projects", "proj").toPath();
        String sessionId = "9d1f0f6e-1b2c-4b3a-9d4e-2f5a6b7c8d90";
        Path subagentsDir = projectDir.resolve(sessionId).resolve("subagents");
        Files.createDirectories(subagentsDir);
        Path transcript = Files.write(subagentsDir.resolve("agent-a80732c8.jsonl"),
                Collections.singletonList("{}"), StandardCharsets.UTF_8);
        Path meta = Files.write(subagentsDir.resolve("agent-a80732c8.meta.json"),
                Collections.singletonList("{}"), StandardCharsets.UTF_8);

        Path otherSubagentsDir = projectDir.resolve("other-session").resolve("subagents");
        Files.createDirectories(otherSubagentsDir);
        Path otherTranscript = Files.write(otherSubagentsDir.resolve("agent-keep.jsonl"),
                Collections.singletonList("{}"), StandardCharsets.UTF_8);

        int deleted = HistoryDeleteService.deleteSessionSidecarDirectory(projectDir, sessionId);

        assertEquals(2, deleted);
        assertFalse(Files.exists(transcript));
        assertFalse(Files.exists(meta));
        assertFalse(Files.exists(projectDir.resolve(sessionId)));
        assertTrue(Files.exists(otherTranscript));
    }

    @Test
    public void sidecarDirectoryRemovalKeepsUnknownSessionFiles() throws Exception {
        // Only the known subagents subtree is ours to delete; a future Claude Code
        // artifact beside it must survive, and so must the directory holding it.
        Path projectDir = temporaryFolder.newFolder("projects", "proj").toPath();
        String sessionId = "9d1f0f6e-1b2c-4b3a-9d4e-2f5a6b7c8d90";
        Path sessionDir = Files.createDirectories(projectDir.resolve(sessionId));
        Path subagentsDir = Files.createDirectories(sessionDir.resolve("subagents"));
        Files.write(subagentsDir.resolve("agent-a80732c8.jsonl"),
                Collections.singletonList("{}"), StandardCharsets.UTF_8);
        Path unknown = Files.write(sessionDir.resolve("future-artifact.bin"),
                Collections.singletonList("keep"), StandardCharsets.UTF_8);

        int deleted = HistoryDeleteService.deleteSessionSidecarDirectory(projectDir, sessionId);

        assertEquals(1, deleted);
        assertFalse(Files.exists(subagentsDir));
        assertTrue(Files.exists(unknown));
        assertTrue(Files.exists(sessionDir));
    }

    @Test
    public void sidecarDirectoryRemovalRefusesSymlinkedSessionDirectory() throws Exception {
        // Deleting through a symlinked session directory would reach whatever it
        // points at, so the walk must refuse the link itself.
        Path projectDir = temporaryFolder.newFolder("projects", "proj").toPath();
        Path realDir = temporaryFolder.newFolder("elsewhere", "real").toPath();
        Path realSubagents = Files.createDirectories(realDir.resolve("subagents"));
        Path transcript = Files.write(realSubagents.resolve("agent-a80732c8.jsonl"),
                Collections.singletonList("{}"), StandardCharsets.UTF_8);
        String sessionId = "9d1f0f6e-1b2c-4b3a-9d4e-2f5a6b7c8d90";
        try {
            Files.createSymbolicLink(projectDir.resolve(sessionId), realDir);
        } catch (Exception symlinksUnavailable) {
            // Windows without Developer Mode cannot create links; nothing to assert.
            return;
        }

        assertEquals(0, HistoryDeleteService.deleteSessionSidecarDirectory(projectDir, sessionId));
        assertTrue(Files.exists(transcript));
    }

    @Test
    public void sidecarDirectoryRemovalRejectsEscapingSessionId() throws Exception {
        Path projectDir = temporaryFolder.newFolder("projects", "proj").toPath();
        Path outsideDir = Files.createDirectories(projectDir.getParent().resolve("outside"));
        Path survivor = Files.write(outsideDir.resolve("keep.jsonl"),
                Collections.singletonList("{}"), StandardCharsets.UTF_8);

        assertEquals(0, HistoryDeleteService.deleteSessionSidecarDirectory(projectDir, "../outside"));
        assertTrue(Files.exists(survivor));
    }

    @Test
    public void sidecarDirectoryRemovalIgnoresSessionsWithoutSidecars() throws Exception {
        Path projectDir = temporaryFolder.newFolder("projects", "proj").toPath();

        assertEquals(0, HistoryDeleteService.deleteSessionSidecarDirectory(projectDir, "missing-session"));
    }

    @Test
    public void deleteRemovesTranscriptLegacyAgentFilesAndSidecars() throws Exception {
        String sessionId = "0b6f7d3e-2c1a-4d5e-8f90-1a2b3c4d5e6f";
        String otherSessionId = "11111111-2222-3333-4444-555555555555";
        Path homeDir = temporaryFolder.newFolder("home").toPath();
        String projectPath = temporaryFolder.newFolder("project").getAbsolutePath();
        Path projectDir = claudeProjectDir(homeDir, projectPath);

        Path transcript = write(projectDir.resolve(sessionId + ".jsonl"), "{}");
        Path legacyAgent = write(projectDir.resolve("agent-legacy.jsonl"),
                "{\"sessionId\":\"" + sessionId + "\"}");
        Path sidecarTranscript = write(
                projectDir.resolve(sessionId).resolve("subagents").resolve("agent-new.jsonl"), "{}");
        Path sidecarMeta = write(
                projectDir.resolve(sessionId).resolve("subagents").resolve("agent-new.meta.json"), "{}");
        Path otherTranscript = write(projectDir.resolve(otherSessionId + ".jsonl"), "{}");
        Path otherSidecar = write(
                projectDir.resolve(otherSessionId).resolve("subagents").resolve("agent-keep.jsonl"), "{}");

        int[] result = new HistoryDeleteService(new HandlerContext(null, null, null, null, null), null, null)
                .deleteClaudeSession(sessionId, projectPath, homeDir);

        assertEquals(1, result[0]);
        assertEquals(3, result[1]);
        assertFalse(Files.exists(transcript));
        assertFalse(Files.exists(legacyAgent));
        assertFalse(Files.exists(sidecarTranscript));
        assertFalse(Files.exists(sidecarMeta));
        assertFalse(Files.exists(projectDir.resolve(sessionId)));
        assertTrue(Files.exists(otherTranscript));
        assertTrue(Files.exists(otherSidecar));
    }

    @Test
    public void deleteLeavesSidecarsAloneWhenTheTranscriptIsAlreadyGone() throws Exception {
        // A stray sidecar directory must not authorize a delete on its own: the
        // transcript has to be there for the sidecars to count as this session's.
        String sessionId = "0b6f7d3e-2c1a-4d5e-8f90-1a2b3c4d5e6f";
        Path homeDir = temporaryFolder.newFolder("home").toPath();
        String projectPath = temporaryFolder.newFolder("project").getAbsolutePath();
        Path projectDir = claudeProjectDir(homeDir, projectPath);
        Path sidecar = write(projectDir.resolve(sessionId).resolve("subagents").resolve("agent-new.jsonl"), "{}");

        int[] result = new HistoryDeleteService(new HandlerContext(null, null, null, null, null), null, null)
                .deleteClaudeSession(sessionId, projectPath, homeDir);

        assertEquals(0, result[0]);
        assertEquals(0, result[1]);
        assertTrue(Files.exists(sidecar));
    }

    private Path claudeProjectDir(Path homeDir, String projectPath) throws Exception {
        Path projectsDir = Files.createDirectories(homeDir.resolve(".claude").resolve("projects"));
        Path projectDir = projectsDir.resolve(PathUtils.getSanitizedPathCandidates(projectPath).get(0));
        Files.createDirectories(projectDir);
        return projectDir;
    }

    private Path write(Path file, String line) throws Exception {
        Files.createDirectories(file.getParent());
        return Files.write(file, Collections.singletonList(line), StandardCharsets.UTF_8);
    }

    private Path writeCodexRollout(Path sessionDir, String sessionId, String parentId, String body)
            throws Exception {
        Path path = sessionDir.resolve("rollout-2026-07-16T09-27-59-" + sessionId + ".jsonl");
        String metadata = "{\"type\":\"session_meta\",\"payload\":{\"id\":\"" + sessionId
                + "\",\"source\":{\"subagent\":{\"thread_spawn\":{\"parent_thread_id\":\""
                + parentId + "\",\"depth\":1}}}}}";
        Files.write(path, Arrays.asList(metadata, body), StandardCharsets.UTF_8);
        return path;
    }

    private static class RecordingClaudeSession extends ClaudeSession {
        private final String sessionId;
        private final String provider;
        private boolean interrupted;

        private RecordingClaudeSession(String sessionId, String provider) {
            super(null, null, null, null);
            this.sessionId = sessionId;
            this.provider = provider;
        }

        @Override
        public String getSessionId() {
            return sessionId;
        }

        @Override
        public String getProvider() {
            return provider;
        }

        @Override
        public CompletableFuture<Void> interrupt() {
            interrupted = true;
            return CompletableFuture.completedFuture(null);
        }
    }

    private static class RecordingHistoryLoadService extends HistoryLoadService {
        private final CountDownLatch reloaded = new CountDownLatch(1);
        private String provider;

        private RecordingHistoryLoadService(HandlerContext context) {
            super(context, null);
        }

        @Override
        void handleLoadHistoryData(String provider) {
            this.provider = provider;
            reloaded.countDown();
        }

        private boolean awaitReload() throws InterruptedException {
            return reloaded.await(5, TimeUnit.SECONDS);
        }
    }
}
