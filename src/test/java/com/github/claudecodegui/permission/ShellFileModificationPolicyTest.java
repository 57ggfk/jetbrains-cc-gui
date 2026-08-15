package com.github.claudecodegui.permission;

import com.google.gson.JsonObject;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class ShellFileModificationPolicyTest {

    @Test
    public void detectsRedirectsAndMutators() {
        assertTrue(ShellFileModificationPolicy.looksLikeShellFileModification("echo hi > /tmp/a.txt"));
        assertTrue(ShellFileModificationPolicy.looksLikeShellFileModification("sed -i 's/a/b/' src/a.ts"));
        assertTrue(ShellFileModificationPolicy.looksLikeShellFileModification("rm -rf dist"));
        assertTrue(ShellFileModificationPolicy.looksLikeShellFileModification("mv a b"));
        assertTrue(ShellFileModificationPolicy.looksLikeShellFileModification("git apply patch.diff"));
    }

    @Test
    public void allowsReadOnlyCommands() {
        assertFalse(ShellFileModificationPolicy.looksLikeShellFileModification("ls -la"));
        assertFalse(ShellFileModificationPolicy.looksLikeShellFileModification("cat package.json"));
        assertFalse(ShellFileModificationPolicy.looksLikeShellFileModification("git status"));
        assertFalse(ShellFileModificationPolicy.looksLikeShellFileModification("npm test"));
        assertFalse(ShellFileModificationPolicy.looksLikeShellFileModification("echo hello"));
    }

    @Test
    public void evaluateDeniesByDefault() {
        JsonObject inputs = new JsonObject();
        inputs.addProperty("command", "echo 1 > f.txt");
        ShellFileModificationPolicy.Decision d =
                ShellFileModificationPolicy.evaluate("Bash", inputs, false);
        assertEquals(ShellFileModificationPolicy.Action.DENY, d.action);
        assertTrue(d.message.contains("Edit"));
    }

    @Test
    public void evaluateWarnsWhenAllowed() {
        JsonObject inputs = new JsonObject();
        inputs.addProperty("command", "sed -i s/a/b/ f.ts");
        ShellFileModificationPolicy.Decision d =
                ShellFileModificationPolicy.evaluate("Bash", inputs, true);
        assertEquals(ShellFileModificationPolicy.Action.WARN, d.action);
        assertTrue(d.message.toLowerCase().contains("not track") || d.message.contains("stats"));
    }

    @Test
    public void evaluatePassesNonShellOrReadOnly() {
        JsonObject edit = new JsonObject();
        edit.addProperty("file_path", "a.ts");
        assertEquals(
                ShellFileModificationPolicy.Action.PASS,
                ShellFileModificationPolicy.evaluate("Edit", edit, false).action);

        JsonObject ls = new JsonObject();
        ls.addProperty("command", "ls");
        assertEquals(
                ShellFileModificationPolicy.Action.PASS,
                ShellFileModificationPolicy.evaluate("Bash", ls, false).action);
    }
}
