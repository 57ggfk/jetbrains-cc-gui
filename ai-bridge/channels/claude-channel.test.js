import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseOptionalTurnCursor } from './claude-channel.js';
import { buildSessionMessagesPagePayload } from '../services/claude/session-service.js';

test('parseOptionalTurnCursor treats absent cursors as the latest page', () => {
  for (const raw of [undefined, null, '', '   ', '\t\n']) {
    assert.equal(parseOptionalTurnCursor(raw), null, `expected null for ${JSON.stringify(raw)}`);
  }
});

test('parseOptionalTurnCursor keeps an explicit turn zero', () => {
  // Zero is a valid cursor ("the page before the first turn"), and it is exactly
  // the value Number(null) and Number('') would produce, so it must be preserved
  // only when the caller supplied it explicitly.
  for (const raw of [0, '0', ' 0 ', '00']) {
    assert.equal(parseOptionalTurnCursor(raw), 0, `expected 0 for ${JSON.stringify(raw)}`);
  }
});

test('parseOptionalTurnCursor accepts non-negative safe-integer cursors', () => {
  assert.equal(parseOptionalTurnCursor(1), 1);
  assert.equal(parseOptionalTurnCursor(42), 42);
  assert.equal(parseOptionalTurnCursor(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
  assert.equal(parseOptionalTurnCursor('42'), 42);
  assert.equal(parseOptionalTurnCursor(' 42 '), 42);
  assert.equal(parseOptionalTurnCursor('0012'), 12);
});

test('parseOptionalTurnCursor rejects negative, fractional and non-numeric cursors', () => {
  for (const raw of [-1, '-1', 1.5, '1.5', NaN, 'abc', 'NaN', 'twelve']) {
    assert.equal(parseOptionalTurnCursor(raw), null, `expected null for ${JSON.stringify(raw)}`);
  }
});

test('parseOptionalTurnCursor rejects values that are neither strings nor numbers', () => {
  // A JSON request can carry any type for beforeTurn; booleans and containers
  // must not be coerced through Number.
  for (const raw of [true, false, {}, [], [42], { turn: 4 }]) {
    assert.equal(parseOptionalTurnCursor(raw), null, `expected null for ${JSON.stringify(raw)}`);
  }
});

test('parseOptionalTurnCursor rejects integers outside the safe range', () => {
  // These pass Number.isInteger, but buildSessionMessagesPagePayload reads them
  // as a cursor beyond the history length and raises cursorReset, which makes the
  // client discard its cached history for a value that was never a real cursor.
  for (const raw of [1e21, Number.MAX_SAFE_INTEGER + 1, '1e21', '9007199254740993', Infinity, -Infinity, 'Infinity']) {
    assert.equal(parseOptionalTurnCursor(raw), null, `expected null for ${JSON.stringify(raw)}`);
  }
});

/**
 * Helper: write a JSONL session with `turnCount` user/assistant pairs.
 * Each user message gets a uuid so it counts as a turn start.
 */
function writeTurnFixture(turnCount) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gui-claude-channel-'));
  const file = path.join(tempDir, 'session.jsonl');
  const lines = [];
  for (let i = 0; i < turnCount; i++) {
    lines.push(JSON.stringify({ type: 'user', uuid: `u${i}`, message: { role: 'user', content: `q${i}` } }));
    lines.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: `a${i}` } }));
  }
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return { tempDir, file };
}

test('an unsafe cursor yields the latest page without asking the client to reset', () => {
  const { tempDir, file } = writeTurnFixture(5);
  try {
    // Documents why the tightening lives in the channel: handed to the payload
    // builder unchanged, an unsafe integer reports cursorReset and forces a full
    // reload. Parsed by the channel it degrades to "latest page", which is what
    // a malformed cursor should do.
    assert.equal(buildSessionMessagesPagePayload(file, 1e21, 30).cursorReset, true);

    const page = buildSessionMessagesPagePayload(file, parseOptionalTurnCursor('1e21'), 30);
    assert.equal(page.cursorReset, false);
    assert.equal(page.fromTurn, 0);
    assert.equal(page.toTurn, 5);
    assert.equal(page.messages[0].message.content, 'q0');
    assert.equal(page.messages[page.messages.length - 1].message.content, 'a4');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
