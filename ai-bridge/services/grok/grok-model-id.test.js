import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGrokModelId } from './grok-utils.js';

test('normalizeGrokModelId maps sentinel values to grok-4.5', () => {
  assert.equal(normalizeGrokModelId('grok'), 'grok-4.5');
  assert.equal(normalizeGrokModelId('Grok'), 'grok-4.5');
  assert.equal(normalizeGrokModelId('default'), 'grok-4.5');
  assert.equal(normalizeGrokModelId('(default)'), 'grok-4.5');
  assert.equal(normalizeGrokModelId(''), 'grok-4.5');
  assert.equal(normalizeGrokModelId('   '), 'grok-4.5');
  assert.equal(normalizeGrokModelId(null), 'grok-4.5');
  assert.equal(normalizeGrokModelId(undefined), 'grok-4.5');
});

test('normalizeGrokModelId passes through real model ids, trimmed', () => {
  assert.equal(normalizeGrokModelId('grok-4.5'), 'grok-4.5');
  assert.equal(normalizeGrokModelId('  grok-3  '), 'grok-3');
  assert.equal(normalizeGrokModelId('grok-beta'), 'grok-beta');
});
