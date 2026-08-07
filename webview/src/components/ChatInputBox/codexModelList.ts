import type { ModelInfo } from './types';

/**
 * Merge the dynamic codex catalog (from ~/.codex/config.toml `model` +
 * `model_catalog_json`, fetched via get_cli_models) with user-added custom
 * models. Catalog entries come first — the backend already pins the config
 * default model at the top — customs follow, deduped by id.
 */
export function buildCodexModelList(catalogModels: ModelInfo[], customModels: ModelInfo[]): ModelInfo[] {
  const seen = new Set<string>();
  const out: ModelInfo[] = [];
  for (const model of [...catalogModels, ...customModels]) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    out.push(model);
  }
  return out;
}
