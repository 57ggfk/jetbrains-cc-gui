/**
 * Shared CLI binary path resolution for headless CLI providers (Grok / Kimi / OpenCode / PI).
 *
 * Priority:
 * 1. Explicit env overrides
 * 2. PATH lookup (`which` / `where`)
 * 3. Common home install candidates
 * 4. Bare binary name fallback
 */

import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { execSync } from 'child_process';

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
  }
  return null;
}

function pathExists(candidate) {
  try {
    return typeof candidate === 'string' && candidate.length > 0 && existsSync(candidate);
  } catch {
    return false;
  }
}

function whichOnPath(binaryName) {
  try {
    const command = process.platform === 'win32' ? `where ${binaryName}` : `which ${binaryName}`;
    const output = execSync(command, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: process.env,
    });
    const first = String(output || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    return first || null;
  } catch {
    return null;
  }
}

/**
 * @param {object} options
 * @param {string} options.binaryName - e.g. "grok" | "kimi" | "opencode"
 * @param {string[]} [options.envKeys] - env var names for path override
 * @param {string[]} [options.homeCandidates] - absolute-ish candidates under $HOME
 *   (use `{home}` placeholder or pass full relative segments)
 * @returns {string}
 */
export function resolveCliPath({ binaryName, envKeys = [], homeCandidates = [] }) {
  const win = process.platform === 'win32';
  const exeName = win ? `${binaryName}.exe` : binaryName;

  const envOverride = firstNonEmpty(...envKeys.map((key) => process.env[key]));
  if (envOverride) {
    return envOverride;
  }

  const fromPath = whichOnPath(exeName);
  if (fromPath) return fromPath;

  const home = homedir();
  for (const template of homeCandidates) {
    const resolved = template
      .replace('{home}', home)
      .replace('{bin}', exeName)
      .replace('{name}', binaryName);
    if (pathExists(resolved)) return resolved;
  }

  return binaryName;
}

/**
 * Prepend extra bin dirs to PATH when missing (IDE PATH is often sparse).
 * @param {NodeJS.ProcessEnv} env
 * @param {string[]} binDirs
 */
export function enrichPathWithBinDirs(env, binDirs = []) {
  const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
  const sep = process.platform === 'win32' ? ';' : ':';
  let current = env[pathKey] || env.PATH || '';
  const parts = current ? current.split(sep) : [];
  for (const dir of binDirs) {
    if (dir && !parts.includes(dir)) {
      parts.unshift(dir);
    }
  }
  env[pathKey] = parts.join(sep);
  if (pathKey !== 'PATH') {
    env.PATH = env[pathKey];
  }
}

export function resolveGrokCliPath() {
  return resolveCliPath({
    binaryName: 'grok',
    envKeys: ['GROK_BIN', 'GROK_PATH', 'GROK_CLI_PATH'],
    homeCandidates: [
      '{home}/.grok/bin/{bin}',
      '{home}/.local/bin/{bin}',
    ],
  });
}

/**
 * Common user-level CLI install dirs (IDE PATH is often sparse / no login shell).
 * Used both for binary resolution and spawn PATH enrichment.
 */
export function commonCliBinDirs(home = homedir()) {
  if (!home) return [];
  return [
    join(home, '.kimi-code', 'bin'),
    join(home, '.kimi', 'bin'),
    join(home, '.moonshot', 'bin'),
    join(home, '.opencode', 'bin'),
    join(home, '.local', 'share', 'opencode', 'bin'),
    join(home, '.grok', 'bin'),
    join(home, '.pi', 'bin'),
    join(home, '.claude', 'bin'),
    join(home, '.local', 'bin'),
    join(home, '.cargo', 'bin'),
  ];
}

export function resolveKimiCliPath() {
  return resolveCliPath({
    binaryName: 'kimi',
    envKeys: ['KIMI_BIN', 'KIMI_PATH', 'KIMI_CLI_PATH', 'KIMI_CODE_BIN'],
    homeCandidates: [
      // Official kimi-code install location (current)
      '{home}/.kimi-code/bin/{bin}',
      '{home}/.local/bin/{bin}',
      // Legacy install paths
      '{home}/.kimi/bin/{bin}',
      '{home}/.moonshot/bin/{bin}',
    ],
  });
}

export function resolveOpenCodeCliPath() {
  return resolveCliPath({
    binaryName: 'opencode',
    envKeys: ['OPENCODE_BIN', 'OPENCODE_PATH', 'OPENCODE_CLI_PATH'],
    homeCandidates: [
      '{home}/.opencode/bin/{bin}',
      '{home}/.local/bin/{bin}',
      '{home}/.local/share/opencode/bin/{bin}',
    ],
  });
}

export function resolvePiCliPath() {
  return resolveCliPath({
    binaryName: 'pi',
    envKeys: ['PI_BIN', 'PI_PATH', 'PI_CLI_PATH'],
    homeCandidates: [
      '{home}/.pi/bin/{bin}',
      '{home}/.local/bin/{bin}',
    ],
  });
}
