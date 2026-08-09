package com.github.claudecodegui.service;

import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.github.claudecodegui.service.commit.CommitAIClient;
import com.github.claudecodegui.service.commit.CommitDiffProvider;
import com.github.claudecodegui.service.commit.CommitMessageCallback;
import com.github.claudecodegui.service.commit.CommitPromptBuilder;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.vcs.changes.Change;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import java.io.IOException;
import java.util.Collection;

/**
 * Slim orchestrator for AI commit-message generation.
 *
 * <p>Collaborates with three focused units:
 * <ul>
 *     <li>{@link CommitDiffProvider} — real {@code git diff} via git4idea.</li>
 *     <li>{@link CommitPromptBuilder} — lean prompt assembly.</li>
 *     <li>{@link CommitAIClient} — reuses the shared SDK daemon + streams.</li>
 * </ul>
 *
 * <p>The {@code protected} seams ({@link #generateGitDiff}, {@link #callClaudeAPI},
 * {@link #callCodexAPI}, {@link #getCommitAiConfig}) are preserved so routing
 * and diff unit tests can override them.
 */
public class GitCommitMessageService {

    private static final Logger LOG = Logger.getInstance(GitCommitMessageService.class);

    private final Project project;
    private final CodemossSettingsService settingsService;
    private final CommitAIClient client;
    private final CommitDiffProvider diffProvider;
    private final CommitPromptBuilder promptBuilder;

    public GitCommitMessageService(@Nullable Project project) {
        this.project = project;
        this.settingsService = new CodemossSettingsService();
        this.client = new CommitAIClient(project);
        this.diffProvider = new CommitDiffProvider(project, LOG);
        this.promptBuilder = new CommitPromptBuilder(settingsService, project);
    }

    /**
     * Generate a commit message for the selected changes.
     *
     * @param changes  the selected file changes
     * @param callback the callback (onSuccess / onError / onProgress)
     */
    public void generateCommitMessage(
            @NotNull Collection<Change> changes,
            @NotNull CommitMessageCallback callback
    ) {
        try {
            // 1. Real git diff.
            String diff = generateGitDiff(changes);
            if (diff.isEmpty()) {
                callback.onError(ClaudeCodeGuiBundle.message("commit.noChangesFound"));
                return;
            }

            // 2. Lean prompt.
            String prompt = promptBuilder.build(diff);

            // 3. Route to the resolved provider's shared bridge (streams).
            callAIService(prompt, callback);
        } catch (IOException e) {
            LOG.warn("AI service call failed", e);
            String message = e.getMessage();
            callback.onError("AI service call failed: " + (message != null ? message : e.getClass().getSimpleName()));
        } catch (Exception e) {
            LOG.error("Failed to generate commit message", e);
            String message = e.getMessage();
            callback.onError(message != null ? message : e.getClass().getSimpleName());
        }
    }

    /** Cancel the in-flight generation (channel-scoped; safe for shared bridges). */
    public void cancel() {
        client.cancel();
    }

    // -------------------------------------------------------------------------
    // Protected seams (overridable by tests)
    // -------------------------------------------------------------------------

    /**
     * Generate the unified git diff for the changes. Delegates to
     * {@link CommitDiffProvider} (real git4idea diff, with a content fallback).
     */
    protected String generateGitDiff(@NotNull Collection<Change> changes) {
        return diffProvider.generate(changes);
    }

    /**
     * Resolve provider + model and dispatch. Falls back to Claude unless Codex
     * is explicitly resolved.
     */
    private void callAIService(String prompt, CommitMessageCallback callback) throws IOException {
        JsonObject commitAiConfig = getCommitAiConfig();
        String effectiveProvider = getResolvedCommitAiProvider(commitAiConfig);

        if (effectiveProvider == null) {
            callback.onError(ClaudeCodeGuiBundle.message("commit.noAvailableProvider"));
            return;
        }

        if (CommitAIClient.PROVIDER_CODEX.equals(effectiveProvider)) {
            callCodexAPI(prompt, getResolvedCommitAiModel(commitAiConfig, CommitAIClient.PROVIDER_CODEX), callback);
            return;
        }

        callClaudeAPI(prompt, getResolvedCommitAiModel(commitAiConfig, CommitAIClient.PROVIDER_CLAUDE), callback);
    }

    /** Call the Claude bridge (shared daemon). Overridable by tests. */
    protected void callClaudeAPI(String prompt, String model, CommitMessageCallback callback) {
        client.send(prompt, CommitAIClient.PROVIDER_CLAUDE, model, callback,
                ClaudeCodeGuiBundle.message("commit.emptyMessage"));
    }

    /** Call the Codex bridge (shared daemon). Overridable by tests. */
    protected void callCodexAPI(String prompt, String model, CommitMessageCallback callback) {
        client.send(prompt, CommitAIClient.PROVIDER_CODEX, model, callback,
                ClaudeCodeGuiBundle.message("commit.emptyMessage"));
    }

    protected JsonObject getCommitAiConfig() throws IOException {
        return settingsService.getCommitAiConfig();
    }

    @Nullable
    private String getResolvedCommitAiProvider(JsonObject commitAiConfig) {
        if (commitAiConfig == null
                || !commitAiConfig.has("effectiveProvider")
                || commitAiConfig.get("effectiveProvider").isJsonNull()) {
            return null;
        }
        String provider = commitAiConfig.get("effectiveProvider").getAsString().trim();
        return provider.isEmpty() ? null : provider;
    }

    @Nullable
    private String getResolvedCommitAiModel(JsonObject commitAiConfig, String provider) {
        if (commitAiConfig == null
                || !commitAiConfig.has("models")
                || !commitAiConfig.get("models").isJsonObject()) {
            return null;
        }
        JsonObject models = commitAiConfig.getAsJsonObject("models");
        if (!models.has(provider) || models.get(provider).isJsonNull()) {
            return null;
        }
        String model = models.get(provider).getAsString().trim();
        return model.isEmpty() ? null : model;
    }
}
