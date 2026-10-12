import test from 'node:test';
import assert from 'node:assert/strict';
import { parseClaudeModelPicker } from './models-service.js';

test('reads cc-switch routes, labels, descriptions and the configured default', () => {
  const result = parseClaudeModelPicker({
    env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'ccs-claude-provider-b--glm-5.3[1M]', ANTHROPIC_AUTH_TOKEN: 'secret' },
    modelPicker: {
      replaceBuiltInOptions: true,
      options: [
        { model: 'ccs-claude-provider-a--grok-4.7[1M]', label: 'grok-4.7（供应商 A）', description: 'grok-4.7 · 1M' },
        { model: 'ccs-claude-provider-b--glm-5.3[1M]', label: 'glm-5.3（供应商 B）', description: 'glm-5.3 · 1M' },
        { model: 'ccs-claude-provider-b--glm-5.3-flash[1M]', label: 'glm-5.3-flash（供应商 B）' },
      ],
    },
  });
  assert.equal(result.replaceBuiltInOptions, true);
  assert.equal(result.defaultModel, 'ccs-claude-provider-b--glm-5.3');
  assert.deepEqual(result.models[0], { id: 'ccs-claude-provider-a--grok-4.7', label: 'grok-4.7（供应商 A）', description: 'grok-4.7 · 1M' });
  assert.equal(result.models.length, 3);
  assert.ok(!JSON.stringify(result).includes('secret'));
});

test('keeps different provider routes for the same upstream, dedupes context variants', () => {
  const result = parseClaudeModelPicker({ modelPicker: { options: [
    null, {}, { model: 123 }, { model: ' ' },
    { model: ' ccs-claude-a--opus[1M] ', label: 'A' },
    { model: 'ccs-claude-a--opus', label: 'duplicate' },
    { model: 'ccs-claude-b--opus', label: '' },
  ] } });
  assert.deepEqual(result.models, [
    { id: 'ccs-claude-a--opus', label: 'A' },
    { id: 'ccs-claude-b--opus', label: 'ccs-claude-b--opus' },
  ]);
  assert.equal(result.replaceBuiltInOptions, false);
});

test('missing or malformed picker keeps built-ins; explicit empty replacement is honored', () => {
  for (const settings of [null, {}, { modelPicker: { replaceBuiltInOptions: true, options: {} } }]) {
    assert.deepEqual(parseClaudeModelPicker(settings), { models: [], replaceBuiltInOptions: false, defaultModel: null });
  }
  assert.deepEqual(parseClaudeModelPicker({ modelPicker: { replaceBuiltInOptions: true, options: [] } }),
    { models: [], replaceBuiltInOptions: true, defaultModel: null });
});
