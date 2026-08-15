/**
 * Effective-chain selection for Claude session JSONL transcripts.
 *
 * The CLI never deletes rewound messages from the transcript. Rewinding
 * forks the conversation in place: subsequent messages get parentUuid
 * pointing past the rewound span, so the discarded branch stays on disk
 * as a dead chain. Reading the file line-by-line renders those dead
 * branches as if they were live conversation.
 *
 * Mirrors Claude Code's loadMessagesFromJsonlPath + buildConversationChain:
 * pick the newest non-sidechain leaf, walk parentUuid back to the root,
 * then recover parallel-tool siblings the single-parent walk orphans
 * (N parallel tool_uses stream as N assistant rows sharing one message.id;
 * the parentUuid chain keeps only one branch of that DAG).
 */

/**
 * Select the messages that form the effective conversation.
 * @param {Array<any>} entries parsed JSONL entries in file order
 * @returns {Array<any>} chain messages in conversation order; line order
 *   when the transcript carries no parentUuid fields at all (the plugin's
 *   direct-API fallback writer omits them, and chain-walking such a file
 *   would collapse every message into isolated leaves)
 */
export function selectConversationChain(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return entries ?? [];
  }

  const byUuid = new Map();
  for (const entry of entries) {
    if (entry && typeof entry.uuid === 'string') {
      byUuid.set(entry.uuid, entry);
    }
  }
  if (byUuid.size === 0) {
    return entries;
  }

  // The CLI writes parentUuid on every row (null for the root). If no row
  // carries the field, this transcript was not written by the chain model
  // and line order is the only meaningful order.
  let hasParentField = false;
  for (const entry of byUuid.values()) {
    if ('parentUuid' in entry) {
      hasParentField = true;
      break;
    }
  }
  if (!hasParentField) {
    return entries;
  }

  // A row can lack the parentUuid KEY entirely: SDK-written roots, and rows
  // the plugin's direct-API fallback appends to a CLI-written file. An
  // explicit null stays a root (session start, compact boundary); a missing
  // key inherits the previous uuid-carrying row as its parent so a hybrid
  // transcript keeps its line-order continuity instead of collapsing the
  // walk at the first such row.
  let prevUuid = null;
  for (const entry of byUuid.values()) {
    if (!('parentUuid' in entry) && prevUuid !== null) {
      byUuid.set(entry.uuid, { ...entry, parentUuid: prevUuid });
    }
    prevUuid = entry.uuid;
  }

  const leaf = selectNewestLeaf(byUuid);
  if (!leaf) {
    return entries;
  }

  const chain = walkParentChain(byUuid, leaf);
  if (chain.length === 0) {
    return entries;
  }
  return recoverOrphanedParallelToolResults(byUuid, chain);
}

/**
 * A leaf is the nearest user/assistant ancestor of any childless message
 * (attachments can trail a user/assistant message without continuing the
 * chain). The newest non-sidechain leaf is the tip of the live branch;
 * leaves of rewound branches are older by timestamp.
 *
 * When every leaf is a sidechain tail (the main branch ended in a
 * subagent call), sidechain rows are excluded and leaves are recomputed
 * so the main branch still resolves instead of degrading to line order.
 */
function selectNewestLeaf(byUuid) {
  let tip = newestNonSidechainLeaf(byUuid, byUuid);
  if (!tip) {
    const mainThread = new Map();
    for (const entry of byUuid.values()) {
      if (!entry.isSidechain) {
        mainThread.set(entry.uuid, entry);
      }
    }
    if (mainThread.size > 0 && mainThread.size < byUuid.size) {
      tip = newestNonSidechainLeaf(byUuid, mainThread);
    }
  }
  return tip;
}

function newestNonSidechainLeaf(byUuid, graph) {
  const parentUuids = new Set();
  for (const entry of graph.values()) {
    if (entry.parentUuid) {
      parentUuids.add(entry.parentUuid);
    }
  }

  const leafUuids = new Set();
  for (const entry of graph.values()) {
    if (parentUuids.has(entry.uuid)) {
      continue;
    }
    let current = entry;
    const seen = new Set();
    while (current) {
      if (seen.has(current.uuid)) {
        break;
      }
      seen.add(current.uuid);
      if (current.type === 'user' || current.type === 'assistant') {
        leafUuids.add(current.uuid);
        break;
      }
      current = current.parentUuid ? byUuid.get(current.parentUuid) : null;
    }
  }

  let tip = null;
  let tipTime = 0;
  for (const uuid of leafUuids) {
    const entry = byUuid.get(uuid);
    if (entry.isSidechain) {
      continue;
    }
    const time = Date.parse(entry.timestamp ?? '') || 0;
    if (time > tipTime) {
      tipTime = time;
      tip = entry;
    }
  }
  return tip;
}

function walkParentChain(byUuid, tip) {
  const chain = [];
  const seen = new Set();
  let current = tip;
  while (current) {
    if (seen.has(current.uuid)) {
      break;
    }
    seen.add(current.uuid);
    chain.push(current);
    current = current.parentUuid ? byUuid.get(current.parentUuid) : null;
  }
  chain.reverse();
  return chain;
}

/**
 * Post-pass for walkParentChain: recover sibling assistant rows and tool
 * results that the single-parent walk orphaned. Siblings share message.id
 * with an on-chain assistant; tool results attach to their source
 * assistant via parentUuid. Both are spliced right after the last
 * on-chain member of their sibling group so the group stays contiguous.
 */
function recoverOrphanedParallelToolResults(byUuid, chain) {
  const onChain = new Set(chain.map((entry) => entry.uuid));
  const chainAssistants = chain.filter(
    (entry) => entry.type === 'assistant' && entry.message && entry.message.id
  );
  if (chainAssistants.length === 0) {
    return chain;
  }

  const siblingsByMsgId = new Map();
  const toolResultsByAsst = new Map();
  for (const entry of byUuid.values()) {
    if (entry.type === 'assistant' && entry.message && entry.message.id) {
      const group = siblingsByMsgId.get(entry.message.id);
      if (group) {
        group.push(entry);
      } else {
        siblingsByMsgId.set(entry.message.id, [entry]);
      }
    } else if (
      entry.type === 'user' &&
      entry.parentUuid &&
      Array.isArray(entry.message && entry.message.content) &&
      entry.message.content.some((block) => block && block.type === 'tool_result')
    ) {
      const group = toolResultsByAsst.get(entry.parentUuid);
      if (group) {
        group.push(entry);
      } else {
        toolResultsByAsst.set(entry.parentUuid, [entry]);
      }
    }
  }

  // Anchor = last on-chain member of each sibling group, so the group stays
  // contiguous and every recovered tool result lands after its tool_use.
  const anchorByMsgId = new Map();
  for (const assistant of chainAssistants) {
    anchorByMsgId.set(assistant.message.id, assistant);
  }

  const inserts = new Map();
  for (const assistant of chainAssistants) {
    const msgId = assistant.message.id;
    const anchor = anchorByMsgId.get(msgId);
    if (anchor !== assistant) {
      continue;
    }

    const group = siblingsByMsgId.get(msgId) ?? [assistant];
    const orphanedSiblings = group.filter((sibling) => !onChain.has(sibling.uuid));
    const orphanedToolResults = [];
    for (const member of group) {
      for (const toolResult of toolResultsByAsst.get(member.uuid) ?? []) {
        if (!onChain.has(toolResult.uuid)) {
          orphanedToolResults.push(toolResult);
        }
      }
    }
    if (orphanedSiblings.length === 0 && orphanedToolResults.length === 0) {
      continue;
    }

    byTimestamp(orphanedSiblings);
    byTimestamp(orphanedToolResults);
    inserts.set(assistant.uuid, [...orphanedSiblings, ...orphanedToolResults]);
  }

  if (inserts.size === 0) {
    return chain;
  }

  const result = [];
  for (const entry of chain) {
    result.push(entry);
    const toInsert = inserts.get(entry.uuid);
    if (toInsert) {
      result.push(...toInsert);
    }
  }
  return result;
}

// Stable timestamp sort keeps content-block order; equal timestamps (same
// streamed second) fall back to file order because byUuid preserves it.
function byTimestamp(entries) {
  entries.sort((a, b) => {
    const ta = Date.parse(a.timestamp ?? '') || 0;
    const tb = Date.parse(b.timestamp ?? '') || 0;
    return ta - tb;
  });
}
