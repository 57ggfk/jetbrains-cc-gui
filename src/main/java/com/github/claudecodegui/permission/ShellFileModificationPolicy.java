package com.github.claudecodegui.permission;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Detect shell tools that modify the filesystem and provide policy messages.
 * Mirrors ai-bridge/utils/shell-file-modification.js for the Java permission path.
 */
public final class ShellFileModificationPolicy {

    public static final String DENY_MESSAGE =
            "This mode only allows file changes via AI Edit/Write tools (for visible diffs and edit stats). "
                    + "Shell/Bash commands that modify files are blocked. "
                    + "Please use the Edit or Write tool instead. "
                    + "To allow shell file modifications, enable Settings → Behavior → Allow shell to modify files.";

    public static final String WARN_NO_STATS_MESSAGE =
            "Warning: this shell command modifies files outside Edit/Write, so StatusPanel edit stats "
                    + "/ structured diffs will not track these changes. Prefer Edit or Write when possible.";

    private static final Set<String> SHELL_TOOLS = Set.of(
            "bash",
            "shell",
            "shell_command",
            "run_terminal_cmd",
            "run_terminal_command",
            "execute_command",
            "exec_command",
            "local_shell"
    );

    private static final Pattern REDIRECT = Pattern.compile(
            "(?:^|[\\s;|&(])(?:\\d*)?>>?(?!\\s*&)\\s*[\"']?[^\\s|&;]+");
    private static final Pattern SED_INPLACE = Pattern.compile("\\bsed\\b[\\s\\S]*\\s-i\\b");
    private static final Pattern PERL_INPLACE = Pattern.compile("\\bperl\\b[\\s\\S]*\\s-i\\b");
    private static final Pattern RUBY_INPLACE = Pattern.compile("\\bruby\\b[\\s\\S]*\\s-i\\b");
    private static final Pattern MUTATORS = Pattern.compile(
            "\\b(?:rm|rmdir|mv|cp|install|truncate|touch|mkdir|chmod|chown|chgrp|ln|unlink|rename|tee|dd|rsync|scp|sftp)\\b");
    private static final Pattern PATCHERS = Pattern.compile(
            "\\b(?:patch|git\\s+apply|git\\s+checkout\\s+--|git\\s+restore\\b|git\\s+clean\\b|git\\s+reset\\b)\\b");
    private static final Pattern HEREDOC_WRITE = Pattern.compile(
            "<<\\s*['\"]?\\w+['\"]?", Pattern.CASE_INSENSITIVE);

    private ShellFileModificationPolicy() {
    }

    public static boolean isShellTool(String toolName) {
        if (toolName == null || toolName.isBlank()) {
            return false;
        }
        return SHELL_TOOLS.contains(toolName.trim().toLowerCase(Locale.ROOT));
    }

    public static String extractCommand(JsonObject inputs) {
        if (inputs == null) {
            return "";
        }
        for (String key : new String[]{"command", "cmd", "shell_command", "script"}) {
            if (inputs.has(key) && !inputs.get(key).isJsonNull()) {
                JsonElement el = inputs.get(key);
                if (el.isJsonPrimitive()) {
                    String s = el.getAsString();
                    if (s != null && !s.isBlank()) {
                        return s;
                    }
                }
            }
        }
        return "";
    }

    public static boolean looksLikeShellFileModification(String command) {
        if (command == null) {
            return false;
        }
        String cmd = command.trim();
        if (cmd.isEmpty()) {
            return false;
        }
        if (REDIRECT.matcher(cmd).find()) {
            return true;
        }
        if (HEREDOC_WRITE.matcher(cmd).find()
                && (cmd.contains("cat") || cmd.contains("tee") || cmd.contains("dd"))) {
            return true;
        }
        if (SED_INPLACE.matcher(cmd).find()
                || PERL_INPLACE.matcher(cmd).find()
                || RUBY_INPLACE.matcher(cmd).find()) {
            return true;
        }
        if (MUTATORS.matcher(cmd).find() || PATCHERS.matcher(cmd).find()) {
            return true;
        }
        if (cmd.contains("open(") && (cmd.contains("'w") || cmd.contains("\"w"))) {
            return true;
        }
        return false;
    }

    public static boolean isShellFileModificationRequest(String toolName, JsonObject inputs) {
        if (!isShellTool(toolName)) {
            return false;
        }
        return looksLikeShellFileModification(extractCommand(inputs));
    }

    public enum Action {
        PASS,
        DENY,
        WARN
    }

    public static final class Decision {
        public final Action action;
        public final String message;

        public Decision(Action action, String message) {
            this.action = action;
            this.message = message;
        }
    }

    public static Decision evaluate(String toolName, JsonObject inputs, boolean allowShellFileModification) {
        if (!isShellFileModificationRequest(toolName, inputs)) {
            return new Decision(Action.PASS, null);
        }
        if (!allowShellFileModification) {
            return new Decision(Action.DENY, DENY_MESSAGE);
        }
        return new Decision(Action.WARN, WARN_NO_STATS_MESSAGE);
    }
}
