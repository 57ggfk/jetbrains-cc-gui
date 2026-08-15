/**
 * Detect shell/Bash commands that modify the filesystem so policy can
 * prefer structured Edit/Write tools (StatusPanel diffs / edit stats).
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/** Tool names treated as shell execution (normalized lower-case). */
export const SHELL_TOOL_NAMES = new Set([
  'bash',
  'shell',
  'shell_command',
  'run_terminal_cmd',
  'run_terminal_command',
  'execute_command',
  'exec_command',
  'local_shell',
]);

export function isShellToolName(toolName) {
  if (!toolName) return false;
  return SHELL_TOOL_NAMES.has(String(toolName).toLowerCase());
}

export function extractShellCommand(input) {
  if (!input || typeof input !== 'object') return '';
  const candidates = [
    input.command,
    input.cmd,
    input.shell_command,
    input.script,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c;
  }
  return '';
}

/**
 * Heuristic: does this shell command likely create/modify/delete files?
 * Intentionally broad — false positives only force Edit/Write; false negatives
 * would skip the policy.
 */
export function looksLikeShellFileModification(command) {
  const cmd = String(command || '').trim();
  if (!cmd) return false;

  // Redirection to a file (exclude 2>&1 / >&2 style fd redirects alone)
  // Matches: > file, >> file, 1> file, tee file, etc.
  if (/(?:^|[^0-9])(?:>>?|[12]?>>?)\s*(?!&)\S+/.test(cmd)) {
    // Exclude pure fd redirects like 2>&1 or >&2 without a path target
    if (!/(?:>>?|[12]>>?)\s*&\d/.test(cmd.replace(/(?:^|[^0-9])(?:>>?|[12]?>>?)\s*(?!&)\S+/g, ''))) {
      // If any non-fd redirect target exists
      if (/(?:^|[\s;|&])(?:\d*)>>?\s*(?!&)\S+/.test(cmd) || /(?:^|[\s;|&])>>?\s*(?!&)\S+/.test(cmd)) {
        return true;
      }
    }
  }
  // Simpler catch-all for common write redirects
  if (/(?:^|[\s;|&(])(?:\d*)?>>?(?!\s*&)\s*["']?[^\s|&;]+/.test(cmd)) {
    return true;
  }

  // Heredoc written to a file: cat > file <<EOF / tee file <<
  if (/<<\s*['"]?\w+['"]?/.test(cmd) && /(?:cat|tee|dd)\b/.test(cmd)) {
    return true;
  }

  // Common file-mutating commands (word boundary)
  const mutators = [
    // editors / in-place
    /\bsed\b[\s\S]*\s-i\b/,
    /\bperl\b[\s\S]*\s-i\b/,
    /\bruby\b[\s\S]*\s-i\b/,
    // coreutils write/delete/move
    /\b(?:rm|rmdir|mv|cp|install|truncate|touch|mkdir|chmod|chown|chgrp|ln|unlink|rename)\b/,
    /\b(?:tee|dd|rsync|scp|sftp)\b/,
    // patch / apply
    /\b(?:patch|git\s+apply|git\s+checkout\s+--|git\s+restore\b|git\s+clean\b|git\s+reset\b)\b/,
    // package writers that often hit workspace
    /\bnpm\s+(?:install|uninstall|link|pkg)\b/,
    /\bpip(?:3)?\s+install\b/,
    // python one-liners that open for write
    /\bopen\s*\([^)]*['"]w/,
    /\bPath\s*\([^)]*\)\s*\.\s*write_/,
  ];
  for (const re of mutators) {
    if (re.test(cmd)) return true;
  }

  return false;
}

export function isShellFileModificationRequest(toolName, input) {
  if (!isShellToolName(toolName)) return false;
  const command = extractShellCommand(input);
  return looksLikeShellFileModification(command);
}

/** Default: shell file mods are blocked (AI Edit/Write only). */
export function isAllowShellFileModification(env = process.env, readConfig = readCodemossConfigFlag) {
  // Live config wins so Settings toggles apply without restarting the daemon.
  const fromConfig = readConfig();
  if (typeof fromConfig === 'boolean') return fromConfig;

  const envVal = env?.CODEMOSS_ALLOW_SHELL_FILE_MODIFICATION;
  if (envVal === '1' || envVal === 'true' || envVal === 'TRUE') return true;
  if (envVal === '0' || envVal === 'false' || envVal === 'FALSE') return false;
  return false;
}

function readCodemossConfigFlag() {
  try {
    const p = join(homedir(), '.codemoss', 'config.json');
    if (!existsSync(p)) return null;
    const cfg = JSON.parse(readFileSync(p, 'utf8'));
    if (typeof cfg.allowShellFileModification === 'boolean') {
      return cfg.allowShellFileModification;
    }
  } catch {
    // ignore
  }
  return null;
}

export const DENY_SHELL_FILE_MOD_MESSAGE =
  'This mode only allows file changes via AI Edit/Write tools (for visible diffs and edit stats). ' +
  'Shell/Bash commands that modify files are blocked. ' +
  'Please use the Edit or Write tool instead. ' +
  'To allow shell file modifications, enable Settings → Behavior → Allow shell to modify files.';

export const WARN_SHELL_FILE_MOD_NO_STATS =
  'Warning: this shell command modifies files outside Edit/Write, so StatusPanel edit stats / structured diffs will not track these changes. Prefer Edit or Write when possible.';

/**
 * @returns {{ action: 'deny'|'warn'|'pass', message?: string }}
 */
export function evaluateShellFileModificationPolicy(toolName, input, options = {}) {
  if (!isShellFileModificationRequest(toolName, input)) {
    return { action: 'pass' };
  }
  const allow = typeof options.allowShellFileModification === 'boolean'
    ? options.allowShellFileModification
    : isAllowShellFileModification();
  if (!allow) {
    return { action: 'deny', message: DENY_SHELL_FILE_MOD_MESSAGE };
  }
  return { action: 'warn', message: WARN_SHELL_FILE_MOD_NO_STATS };
}
