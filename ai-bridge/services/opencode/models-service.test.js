import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOpenCodeModelsOutput } from './models-service.js';

test('parses provider/model lines and dedups', () => {
  const out = 'opencode/big-pickle\nanthropic/claude-fable-5\nopencode/big-pickle\n';
  const models = parseOpenCodeModelsOutput(out);
  assert.deepEqual(models.map((m) => m.id), ['opencode/big-pickle', 'anthropic/claude-fable-5']);
  assert.equal(models[0].label, 'opencode/Big-Pickle');
});

test('handles CRLF and ANSI escape sequences (Windows terminals)', () => {
  const out = '[32mopencode/big-pickle[0m\r\n[2manthropic/claude-fable-5[0m\r\n';
  const models = parseOpenCodeModelsOutput(out);
  assert.deepEqual(models.map((m) => m.id), ['opencode/big-pickle', 'anthropic/claude-fable-5']);
});

test('picks the model token even when the line has extra columns', () => {
  const out = 'default  anthropic/claude-fable-5  200k context\n';
  const models = parseOpenCodeModelsOutput(out);
  assert.deepEqual(models.map((m) => m.id), ['anthropic/claude-fable-5']);
});

test('rejects Windows paths, URLs and UNC-ish tokens', () => {
  const out = [
    'Config loaded from C:/Users/x/.config/opencode/config.json',
    'Docs: https://opencode.ai/docs/models',
    'Share \\\\server\\share\\dir',
    'D:\\tools\\opencode.cmd run',
    'anthropic/claude-fable-5',
  ].join('\r\n');
  const models = parseOpenCodeModelsOutput(out);
  assert.deepEqual(models.map((m) => m.id), ['anthropic/claude-fable-5']);
});

test('returns empty list for empty or unparseable output', () => {
  assert.deepEqual(parseOpenCodeModelsOutput(''), []);
  assert.deepEqual(parseOpenCodeModelsOutput('No providers configured.\nRun `opencode auth login`.'), []);
});
