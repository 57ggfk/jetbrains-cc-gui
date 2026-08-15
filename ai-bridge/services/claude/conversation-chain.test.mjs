import test from 'node:test';
import assert from 'node:assert/strict';

import { selectConversationChain } from './conversation-chain.js';

let uuidCounter = 0;
function uuid(prefix) {
  uuidCounter += 1;
  return `${prefix}-${String(uuidCounter).padStart(4, '0')}`;
}

function userEntry(parentUuid, text, timestamp) {
  return {
    type: 'user',
    uuid: uuid('u'),
    parentUuid,
    timestamp,
    message: { role: 'user', content: text },
  };
}

function assistantEntry(parentUuid, text, timestamp, messageId) {
  return {
    type: 'assistant',
    uuid: uuid('a'),
    parentUuid,
    timestamp,
    message: { id: messageId, role: 'assistant', content: [{ type: 'text', text }] },
  };
}

function chainTexts(chain) {
  return chain.map((entry) => {
    const content = entry.message.content;
    if (typeof content === 'string') {
      return content;
    }
    return content[0].type === 'tool_result' ? 'tool_result' : content[0].text;
  });
}

test('drops the rewound branch and keeps the forked continuation', () => {
  // Rewind forks in place: after rewinding to u1's answer, the next user
  // message parents onto a1, leaving the old u2/a2 branch dead on disk.
  const first = userEntry(null, 'first', '2026-01-01T10:00:00Z');
  const answerOne = assistantEntry(first.uuid, 'answer one', '2026-01-01T10:00:05Z', 'm1');
  const rewoundQuestion = userEntry(answerOne.uuid, 'second (rewound)', '2026-01-01T10:01:00Z');
  const rewoundAnswer = assistantEntry(rewoundQuestion.uuid, 'answer two (rewound)', '2026-01-01T10:01:05Z', 'm2');
  const retry = userEntry(answerOne.uuid, 'second retry', '2026-01-01T10:02:00Z');
  const retryAnswer = assistantEntry(retry.uuid, 'answer retry', '2026-01-01T10:02:05Z', 'm3');

  const chain = selectConversationChain([
    first, answerOne, rewoundQuestion, rewoundAnswer, retry, retryAnswer,
  ]);
  assert.deepEqual(chainTexts(chain), ['first', 'answer one', 'second retry', 'answer retry']);
});

test('keeps attachments that hang off the live chain and drops rewound ones', () => {
  const first = userEntry(null, 'first', '2026-01-01T10:00:00Z');
  const liveAttachment = {
    type: 'attachment',
    uuid: uuid('att'),
    parentUuid: first.uuid,
    timestamp: '2026-01-01T10:00:01Z',
    attachment: { type: 'file' },
  };
  const answerOne = assistantEntry(liveAttachment.uuid, 'answer one', '2026-01-01T10:00:05Z', 'm1');
  const rewound = userEntry(answerOne.uuid, 'rewound', '2026-01-01T10:01:00Z');
  const rewoundAttachment = {
    type: 'attachment',
    uuid: uuid('att'),
    parentUuid: rewound.uuid,
    timestamp: '2026-01-01T10:01:01Z',
    attachment: { type: 'file' },
  };
  const retry = userEntry(answerOne.uuid, 'retry', '2026-01-01T10:02:00Z');

  const chain = selectConversationChain([
    first, liveAttachment, answerOne, rewound, rewoundAttachment, retry,
  ]);
  assert.deepEqual(chain.map((entry) => entry.type), [
    'user',
    'attachment',
    'assistant',
    'user',
  ]);
});

test('recovers parallel tool_use siblings and their tool results', () => {
  // N parallel tool_uses stream as N assistant rows sharing one message.id;
  // the parentUuid chain keeps only one, the recovery pass must splice the
  // siblings and their tool results back in after the on-chain anchor.
  const question = userEntry(null, 'run both', '2026-01-01T10:00:00Z');
  const toolA = assistantEntry(question.uuid, 'tool A', '2026-01-01T10:00:01Z', 'msg-shared');
  const toolB = {
    type: 'assistant',
    uuid: uuid('a'),
    parentUuid: toolA.uuid,
    timestamp: '2026-01-01T10:00:01Z',
    message: { id: 'msg-shared', role: 'assistant', content: [{ type: 'text', text: 'tool B' }] },
  };
  const resultA = {
    type: 'user',
    uuid: uuid('u'),
    parentUuid: toolB.uuid,
    timestamp: '2026-01-01T10:00:02Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1' }] },
  };
  const resultB = {
    type: 'user',
    uuid: uuid('u'),
    parentUuid: toolA.uuid,
    timestamp: '2026-01-01T10:00:02Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2' }] },
  };
  const done = assistantEntry(resultA.uuid, 'done', '2026-01-01T10:00:05Z', 'm-final');

  const chain = selectConversationChain([
    question, toolA, toolB, resultA, resultB, done,
  ]);
  assert.deepEqual(chainTexts(chain), [
    'run both',
    'tool A',
    'tool B',
    'tool_result',
    'tool_result',
    'done',
  ]);
});

test('falls back to line order when no row carries parentUuid', () => {
  // The plugin's direct-API fallback writer omits parentUuid entirely;
  // chain-walking such a file would collapse every message into isolated
  // leaves, so line order must win.
  const entries = [
    { type: 'user', uuid: uuid('u'), timestamp: '2026-01-01T10:00:00Z', message: { role: 'user', content: 'one' } },
    { type: 'assistant', uuid: uuid('a'), timestamp: '2026-01-01T10:00:05Z', message: { role: 'assistant', content: 'two' } },
    { type: 'user', uuid: uuid('u'), timestamp: '2026-01-01T10:01:00Z', message: { role: 'user', content: 'three' } },
  ];

  const chain = selectConversationChain(entries);
  assert.equal(chain.length, 3);
  assert.deepEqual(chainTexts(chain), ['one', 'two', 'three']);
});

test('chains through rows appended without the parentUuid key', () => {
  // A hybrid transcript: CLI rows carry parentUuid, then the plugin's
  // direct-API fallback appends rows with uuid but no parentUuid key. The
  // walk must inherit the previous row as the implicit parent instead of
  // stopping at the first such row and dropping all prior history. An
  // explicit null (compact boundary / true root written by the CLI) stays
  // a root.
  const root = userEntry(null, 'root', '2026-01-01T10:00:00Z');
  const answer = assistantEntry(root.uuid, 'answer', '2026-01-01T10:00:05Z', 'm1');
  const fallbackUser = {
    type: 'user',
    uuid: uuid('u'),
    timestamp: '2026-01-01T10:01:00Z',
    message: { role: 'user', content: 'appended without the key' },
  };
  const fallbackAssistant = {
    type: 'assistant',
    uuid: uuid('a'),
    timestamp: '2026-01-01T10:01:05Z',
    message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'fallback answer' }] },
  };

  const chain = selectConversationChain([root, answer, fallbackUser, fallbackAssistant]);
  assert.deepEqual(chainTexts(chain), ['root', 'answer', 'appended without the key', 'fallback answer']);
});

test('stops at a compact boundary root despite pre-compact rows above it', () => {
  // Compaction writes a system compact_boundary row with parentUuid null;
  // post-compact rows chain to it. The walk must stop at the boundary so
  // the stale pre-compact span stays excluded.
  const staleUser = userEntry(null, 'stale pre-compact', '2026-01-01T09:00:00Z');
  const boundary = {
    type: 'system',
    subtype: 'compact_boundary',
    uuid: uuid('sys'),
    parentUuid: null,
    timestamp: '2026-01-01T10:00:00Z',
  };
  const freshUser = userEntry(boundary.uuid, 'post-compact', '2026-01-01T10:01:00Z');

  const chain = selectConversationChain([staleUser, boundary, freshUser]);
  // The boundary row itself stays on the chain (system rows are filtered
  // downstream); the stale pre-compact span must not.
  assert.deepEqual(chain.map((entry) => entry.uuid), [boundary.uuid, freshUser.uuid]);
});

test('ignores sidechain leaves when picking the chain tip', () => {
  const question = userEntry(null, 'main', '2026-01-01T10:00:00Z');
  const answer = assistantEntry(question.uuid, 'main answer', '2026-01-01T10:00:05Z', 'm1');
  const sidechainTail = {
    type: 'assistant',
    uuid: uuid('a'),
    parentUuid: answer.uuid,
    isSidechain: true,
    timestamp: '2026-01-01T11:00:00Z',
    message: { id: 'm-side', role: 'assistant', content: [{ type: 'text', text: 'sidechain tail' }] },
  };

  const chain = selectConversationChain([question, answer, sidechainTail]);
  assert.deepEqual(chainTexts(chain), ['main', 'main answer']);
});

test('stops walking at a parentUuid cycle instead of looping forever', () => {
  const question = userEntry(null, 'first', '2026-01-01T10:00:00Z');
  const answer = assistantEntry(question.uuid, 'answer', '2026-01-01T10:00:05Z', 'm1');
  // Self-referencing parentUuid: the walk must terminate, not hang.
  answer.parentUuid = answer.uuid;

  const chain = selectConversationChain([question, answer]);
  assert.ok(chain.length > 0);
  assert.ok(chain.length <= 2);
});

test('returns line order for empty or uuid-less input', () => {
  assert.deepEqual(selectConversationChain([]), []);
  const entries = [
    { type: 'user', message: { role: 'user', content: 'no uuid here' } },
    { type: 'file-history-snapshot', snapshot: {} },
  ];
  assert.equal(selectConversationChain(entries).length, 2);
});
