/**
 * Discover Grok models from ~/.grok/models_cache.json and ~/.grok/config.toml.
 * Grok CLI auto-fetches API models to models_cache.json and allows custom profiles in config.toml.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function resolveGrokDir() {
  const env = process.env.GROK_HOME;
  if (env && String(env).trim()) return String(env).trim();
  return join(homedir(), '.grok');
}

export function parseModelsCacheJson(jsonText) {
  const models = [];
  const seen = new Set();
  try {
    const data = JSON.parse(jsonText);
    const modelsObj = data?.models || (typeof data === 'object' && !Array.isArray(data) ? data : null);
    if (modelsObj && typeof modelsObj === 'object') {
      for (const [id, entry] of Object.entries(modelsObj)) {
        if (!id || seen.has(id)) continue;
        // Skip scalar metadata keys (e.g. `fetched_at`) that appear in
        // root-map layouts without a `models` wrapper.
        if (!entry || typeof entry !== 'object') continue;
        const raw = entry.info && typeof entry.info === 'object' ? entry.info : entry;
        if (raw.hidden === true) continue;
        seen.add(id);
        models.push({
          id,
          label: raw.name || raw.id || id,
          description: raw.description || raw.model || id,
        });
      }
    }
  } catch {
    // Ignore JSON parse errors
  }
  return { models, seen };
}

export function parseGrokProfilesFromToml(tomlText, seenSet = new Set()) {
  const models = [];
  let defaultModel = null;
  const src = String(tomlText || '');

  // Grok keeps `default` inside the `[models]` section (not at TOML top level),
  // so this intentionally matches anywhere in the file, first occurrence wins.
  const defaultMatch = src.match(/^\s*default\s*=\s*"([^"]+)"/m);
  if (defaultMatch) {
    defaultModel = defaultMatch[1].trim();
  }

  const sectionRe = /\[model\.(?:"([^"]+)"|([a-zA-Z0-9_-]+))\]([\s\S]*?)(?=\n\[|\s*$)/g;
  let match;
  while ((match = sectionRe.exec(src)) !== null) {
    const id = (match[1] || match[2] || '').trim();
    if (!id || seenSet.has(id)) continue;
    seenSet.add(id);
    const body = match[3] || '';
    const nestedModel = body.match(/^\s*model\s*=\s*"([^"]+)"/m);
    models.push({
      id,
      label: id,
      description: nestedModel ? nestedModel[1].trim() : id,
    });
  }

  return { models, defaultModel };
}

export function listModels() {
  const grokDir = resolveGrokDir();
  const cachePath = join(grokDir, 'models_cache.json');
  const configPath = join(grokDir, 'config.toml');

  let allModels = [];
  const seen = new Set();
  let defaultModel = 'grok-4.5';

  if (existsSync(cachePath)) {
    try {
      const raw = readFileSync(cachePath, 'utf8');
      const { models: cacheModels, seen: cacheSeen } = parseModelsCacheJson(raw);
      allModels.push(...cacheModels);
      cacheSeen.forEach((id) => seen.add(id));
    } catch (e) {
      console.error('[Grok Models] Failed to read models_cache.json:', e?.message || e);
    }
  }

  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, 'utf8');
      const { models: profileModels, defaultModel: def } = parseGrokProfilesFromToml(raw, seen);
      allModels.push(...profileModels);
      if (def) defaultModel = def;
    } catch (e) {
      console.error('[Grok Models] Failed to read config.toml:', e?.message || e);
    }
  }

  if (allModels.length === 0) {
    // Last-resort static list, used only when neither the CLI's models cache
    // nor config.toml profiles exist (e.g. grok CLI never ran).
    allModels = [
      { id: 'grok-4.5', label: 'Grok 4.5', description: "SpaceXAI's new frontier model" },
      { id: 'grok-3', label: 'Grok 3', description: 'xAI Grok 3' },
      { id: 'grok-2', label: 'Grok 2', description: 'xAI Grok 2' },
      { id: 'grok-beta', label: 'Grok Beta', description: 'xAI Grok Beta' },
    ];
  }

  const payload = {
    success: true,
    models: allModels,
    defaultModel,
  };

  console.log(JSON.stringify(payload));
  return payload;
}
