import test from 'node:test';
import assert from 'node:assert/strict';
import { parseModelsCacheJson, parseGrokProfilesFromToml } from './models-service.js';

test('parseModelsCacheJson extracts models from models_cache.json payload', () => {
  const json = JSON.stringify({
    fetched_at: '2026-08-09T12:04:19Z',
    models: {
      'grok-4.5': {
        info: {
          id: 'grok-4.5',
          name: 'Grok 4.5',
          description: "SpaceXAI's new frontier model",
        },
      },
      'grok-3': {
        info: {
          id: 'grok-3',
          name: 'Grok 3',
          description: 'Grok 3 reasoning model',
          hidden: false,
        },
      },
      'hidden-model': {
        info: {
          id: 'hidden-model',
          name: 'Hidden Model',
          hidden: true,
        },
      },
    },
  });

  const { models, seen } = parseModelsCacheJson(json);
  assert.equal(models.length, 2);
  assert.deepEqual(models[0], { id: 'grok-4.5', label: 'Grok 4.5', description: "SpaceXAI's new frontier model" });
  assert.deepEqual(models[1], { id: 'grok-3', label: 'Grok 3', description: 'Grok 3 reasoning model' });
  assert.ok(seen.has('grok-4.5'));
  assert.ok(seen.has('grok-3'));
});

test('parseModelsCacheJson skips scalar metadata keys in root-map layout', () => {
  const json = JSON.stringify({
    fetched_at: '2026-08-09T12:04:19Z',
    'grok-4.5': {
      id: 'grok-4.5',
      name: 'Grok 4.5',
    },
  });

  const { models } = parseModelsCacheJson(json);
  assert.equal(models.length, 1);
  assert.deepEqual(models[0], { id: 'grok-4.5', label: 'Grok 4.5', description: 'grok-4.5' });
});

test('parseGrokProfilesFromToml extracts custom profiles from config.toml', () => {
  const toml = `
[models]
default = "grok-custom"

[model."grok-custom"]
model = "grok-4.5"
base_url = "https://example.com/v1"
`;

  const { models, defaultModel } = parseGrokProfilesFromToml(toml);
  assert.equal(defaultModel, 'grok-custom');
  assert.equal(models.length, 1);
  assert.deepEqual(models[0], { id: 'grok-custom', label: 'grok-custom', description: 'grok-4.5' });
});
