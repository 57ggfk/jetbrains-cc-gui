import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CLI_ASK_PROVIDERS,
  isCliAskProvider,
  mergeAssistantTextSnapshot,
  askCliProvider,
} from './cli-ask.js';

test('CLI_ASK_PROVIDERS lists headless CLI providers', () => {
  assert.deepEqual(CLI_ASK_PROVIDERS, ['grok', 'kimi', 'opencode', 'pi']);
});

test('isCliAskProvider accepts only supported CLI ids', () => {
  assert.equal(isCliAskProvider('grok'), true);
  assert.equal(isCliAskProvider('kimi'), true);
  assert.equal(isCliAskProvider('opencode'), true);
  assert.equal(isCliAskProvider('pi'), true);
  assert.equal(isCliAskProvider('claude'), false);
  assert.equal(isCliAskProvider('codex'), false);
  assert.equal(isCliAskProvider(null), false);
});

test('mergeAssistantTextSnapshot returns delta for growing prefix snapshots', () => {
  assert.equal(mergeAssistantTextSnapshot('', 'Hello'), 'Hello');
  assert.equal(mergeAssistantTextSnapshot('Hello', 'Hello world'), ' world');
  assert.equal(mergeAssistantTextSnapshot('Hello', 'Hello'), null);
  assert.equal(mergeAssistantTextSnapshot('Hello world', 'Hello'), null);
  assert.equal(mergeAssistantTextSnapshot('Hi', 'Hello'), '\nHello');
});

test('askCliProvider rejects unsupported providers', async () => {
  await assert.rejects(
    () => askCliProvider({ provider: 'claude', prompt: 'x' }),
    /Unsupported CLI ask provider/
  );
});

test('askCliProvider returns empty string for empty prompt without spawning', async () => {
  const result = await askCliProvider({ provider: 'grok', prompt: '   ' });
  assert.equal(result, '');
});
