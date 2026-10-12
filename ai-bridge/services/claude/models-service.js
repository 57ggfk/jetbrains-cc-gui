import { loadClaudeSettings } from '../../config/api-config.js';

const baseId = (id) => id.trim().replace(/\[1m\]$/i, '');

/** Read the same settings.json model picker used by Claude Code / cc-switch. */
export function parseClaudeModelPicker(settings) {
  const picker = settings?.modelPicker;
  const models = [];
  const seen = new Set();
  if (Array.isArray(picker?.options)) {
    for (const option of picker.options) {
      if (typeof option?.model !== 'string') continue;
      // The webview stores the base id and applies its 1M toggle on send.
      const id = baseId(option.model);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      models.push({
        id,
        label: typeof option.label === 'string' && option.label.trim() ? option.label.trim() : id,
        ...(typeof option.description === 'string' ? { description: option.description } : {}),
      });
    }
  }
  const env = settings?.env;
  const configuredDefault = [settings?.model, env?.ANTHROPIC_MODEL, env?.ANTHROPIC_DEFAULT_SONNET_MODEL]
    .find((value) => typeof value === 'string' && value.trim());
  const defaultId = configuredDefault ? baseId(configuredDefault) : null;
  return {
    models,
    replaceBuiltInOptions: Array.isArray(picker?.options) && picker.replaceBuiltInOptions === true,
    defaultModel: models.some((model) => model.id === defaultId) ? defaultId : models[0]?.id ?? null,
  };
}

export function listModels() {
  console.log(JSON.stringify({ success: true, provider: 'claude', ...parseClaudeModelPicker(loadClaudeSettings()) }));
}
