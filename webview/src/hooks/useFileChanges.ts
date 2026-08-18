import { useMemo } from 'react';
import type { ClaudeMessage, ClaudeContentBlock, ToolResultBlock } from '../types';
import type { FileChangeSummary } from '../types/fileChanges';
import type { SubagentHistoryResponse } from '../types/subagent';
import {
  FILE_MODIFY_TOOL_NAMES,
  AGENT_TOOL_NAMES,
  isToolName,
  normalizeToolName,
} from '../utils/toolConstants';
import { normalizeToolInput } from '../utils/toolInputNormalization';
import { getToolLineInfo } from '../utils/toolPresentation';
import {
  buildSessionFileLedger,
  diffLineStats,
  ledgerEntriesToSummaries,
  type LedgerOp,
} from '../utils/sessionFileLedger';
import {
  isMultiActorPath,
  loadFileTouchMap,
  recordFileTouches,
  wasTouchedOutsideSession,
} from '../utils/fileTouchRegistry';

/** Cache for per-snippet diff calculations (EditToolBlock / op metadata) */
const diffCache = new Map<string, { additions: number; deletions: number }>();
const DIFF_CACHE_MAX_SIZE = 100;

/** Clear module-level diff cache (for tests). */
export function clearDiffCache(): void {
  diffCache.clear();
}

function hashString(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

function getDiffCacheKey(oldString: string, newString: string): string {
  return `${oldString.length}:${newString.length}:${hashString(oldString)}:${hashString(newString)}`;
}

/**
 * Compute diff statistics (additions and deletions count).
 * Small snippets use LCS; large ones use multiset estimation.
 * Used for per-operation metadata; file-level StatusPanel stats use the session ledger.
 */
export function computeDiffStats(
  oldString: string,
  newString: string,
): { additions: number; deletions: number } {
  const cacheKey = getDiffCacheKey(oldString, newString);
  const cached = diffCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const result = diffLineStats(oldString, newString);

  if (diffCache.size >= DIFF_CACHE_MAX_SIZE) {
    const firstKey = diffCache.keys().next().value;
    if (firstKey) {
      diffCache.delete(firstKey);
    }
  }
  diffCache.set(cacheKey, result);
  return result;
}

function extractFilePath(input: Record<string, unknown>): string | null {
  const pathValue = input.path;
  const filePathValue = input.file_path;
  const targetFileValue = input.target_file;
  const targetFileValue2 = input.targetFile;
  const notebookPathValue = input.notebook_path;

  return (
    (typeof input.filePath === 'string' ? input.filePath : undefined)
    ?? (typeof filePathValue === 'string' ? filePathValue : undefined)
    ?? (typeof pathValue === 'string' ? pathValue : undefined)
    ?? (typeof targetFileValue === 'string' ? targetFileValue : undefined)
    ?? (typeof targetFileValue2 === 'string' ? targetFileValue2 : undefined)
    ?? (typeof notebookPathValue === 'string' ? notebookPathValue : undefined)
    ?? null
  );
}

interface StringPair {
  oldString: string;
  newString: string;
  replaceAll?: boolean;
  filePath?: string | null;
}

function pairFromRecord(record: Record<string, unknown>): StringPair {
  const oldString =
    (typeof record.old_string === 'string' ? record.old_string : undefined)
    ?? (typeof record.oldString === 'string' ? record.oldString : undefined)
    ?? (typeof record.oldText === 'string' ? record.oldText : undefined)
    ?? '';
  const newString =
    (typeof record.new_string === 'string' ? record.new_string : undefined)
    ?? (typeof record.newString === 'string' ? record.newString : undefined)
    ?? (typeof record.newText === 'string' ? record.newText : undefined)
    ?? (typeof record.content === 'string' ? record.content : undefined)
    ?? '';
  const replaceAll =
    typeof record.replace_all === 'boolean'
      ? record.replace_all
      : (typeof record.replaceAll === 'boolean' ? record.replaceAll : undefined);

  return {
    oldString,
    newString,
    replaceAll,
    filePath: extractFilePath(record),
  };
}

function extractEditPairs(input: Record<string, unknown>): StringPair[] {
  const edits = input.edits;
  if (Array.isArray(edits) && edits.length > 0) {
    const pairs: StringPair[] = [];
    for (const item of edits) {
      if (!item || typeof item !== 'object') continue;
      const pair = pairFromRecord(item as Record<string, unknown>);
      if (pair.oldString === '' && pair.newString === '') continue;
      pairs.push(pair);
    }
    if (pairs.length > 0) return pairs;
  }

  return [pairFromRecord(input)];
}

function isSuccessfulResult(result?: ToolResultBlock | null): boolean {
  return result !== undefined && result !== null && result.is_error !== true;
}

function collectLedgerOpsFromToolUse(params: {
  toolName: string;
  rawName?: string;
  input: Record<string, unknown>;
  result: ToolResultBlock | null | undefined;
  agentId: string;
  out: LedgerOp[];
}): void {
  const { toolName, rawName, input, result, agentId, out } = params;
  if (!isToolName(toolName, FILE_MODIFY_TOOL_NAMES)) return;
  if (!isSuccessfulResult(result)) return;

  const normalized = normalizeToolInput(rawName ?? toolName, input) as Record<string, unknown>;
  const defaultPath = extractFilePath(normalized);
  const pairs = extractEditPairs(normalized);
  const lineInfo = getToolLineInfo(normalized, undefined, result);

  for (const pair of pairs) {
    const filePath = pair.filePath || defaultPath;
    if (!filePath) continue;
    if (pair.oldString === '' && pair.newString === '') continue;

    out.push({
      filePath,
      toolName,
      oldString: pair.oldString,
      newString: pair.newString,
      replaceAll: pair.replaceAll,
      agentId,
      lineStart: lineInfo.start,
      lineEnd: lineInfo.end,
    });
  }
}

function getRawContentBlocks(message: unknown): unknown[] {
  if (!message || typeof message !== 'object') return [];
  const record = message as Record<string, unknown>;
  const nested = record.message;
  if (nested && typeof nested === 'object') {
    const nestedContent = (nested as Record<string, unknown>).content;
    if (Array.isArray(nestedContent)) return nestedContent;
  }
  if (Array.isArray(record.content)) return record.content;
  return [];
}

function isAssistantLike(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false;
  const record = message as Record<string, unknown>;
  if (record.type === 'assistant' || record.role === 'assistant') return true;
  const nested = record.message;
  if (nested && typeof nested === 'object') {
    const role = (nested as Record<string, unknown>).role;
    if (role === 'assistant') return true;
  }
  return false;
}

function findToolResultInRawMessages(
  messages: unknown[],
  toolUseId: string,
): ToolResultBlock | null {
  for (const message of messages) {
    for (const block of getRawContentBlocks(message)) {
      if (!block || typeof block !== 'object') continue;
      const item = block as Record<string, unknown>;
      if (item.type === 'tool_result' && item.tool_use_id === toolUseId) {
        return item as unknown as ToolResultBlock;
      }
    }
  }
  return null;
}

function collectFromSubagentHistories(
  out: LedgerOp[],
  subagentHistories: Record<string, SubagentHistoryResponse>,
  allowedKeys: Set<string> | null,
): void {
  for (const [key, history] of Object.entries(subagentHistories)) {
    if (!history?.success || !Array.isArray(history.messages)) continue;
    if (allowedKeys && !allowedKeys.has(key)) {
      if (!history.agentId || !allowedKeys.has(history.agentId)) {
        if (!history.toolUseId || !allowedKeys.has(history.toolUseId)) {
          continue;
        }
      }
    }

    const agentId =
      (typeof history.agentId === 'string' && history.agentId)
      || (typeof history.toolUseId === 'string' && history.toolUseId)
      || key;

    const rawMessages = history.messages;
    for (const message of rawMessages) {
      if (!isAssistantLike(message)) continue;
      for (const block of getRawContentBlocks(message)) {
        if (!block || typeof block !== 'object') continue;
        const item = block as Record<string, unknown>;
        if (item.type !== 'tool_use') continue;

        const name = typeof item.name === 'string' ? item.name : '';
        const toolName = normalizeToolName(name);
        if (!isToolName(toolName, FILE_MODIFY_TOOL_NAMES)) continue;

        const toolUseId = typeof item.id === 'string' ? item.id : undefined;
        if (!toolUseId) continue;

        const result = findToolResultInRawMessages(rawMessages, toolUseId);
        const rawInput = item.input;
        if (!rawInput || typeof rawInput !== 'object') continue;

        collectLedgerOpsFromToolUse({
          toolName,
          rawName: name,
          input: rawInput as Record<string, unknown>,
          result,
          agentId,
          out,
        });
      }
    }
  }
}

interface UseFileChangesParams {
  messages: ClaudeMessage[];
  getContentBlocks: (message: ClaudeMessage) => ClaudeContentBlock[];
  findToolResult: (toolUseId?: string, messageIndex?: number) => ToolResultBlock | null;
  /** Start processing messages from this index (for Keep All feature) */
  startFromIndex?: number;
  /** Background agent sidechain transcripts — their Edit/Write tools must also count */
  subagentHistories?: Record<string, SubagentHistoryResponse>;
  /** Current chat tab session id — for cross-tab multi-agent marks */
  currentSessionId?: string | null;
}

/**
 * Attribute main-stream tool_use blocks the same way groupBlocks absorbs them
 * into Agent/Task groups: after an Agent/Task id, following tool_use blocks belong
 * to that agent until a non-tool boundary (text/thinking/…). Without this, every
 * Edit is labeled "main" and multi-agent badges never appear when two agents
 * both write via the main transcript (or absorbed tools after Task).
 */
function resolveAgentIdForMainStreamBlocks(
  blocks: ClaudeContentBlock[],
): Map<string, string> {
  /** tool_use id → agent key ("main" or Agent/Task tool_use id) */
  const ownerByToolId = new Map<string, string>();
  let activeAgentId = 'main';

  for (const block of blocks) {
    if (block.type !== 'tool_use') {
      // Same boundary as groupBlocks: non-tool ends agent absorption
      activeAgentId = 'main';
      continue;
    }

    const rawName = block.name ?? '';
    const toolName = normalizeToolName(rawName);
    const toolId = typeof block.id === 'string' ? block.id : undefined;

    if (isToolName(toolName, AGENT_TOOL_NAMES) && toolId) {
      activeAgentId = toolId;
      ownerByToolId.set(toolId, toolId);
      continue;
    }

    if (toolId) {
      ownerByToolId.set(toolId, activeAgentId);
    }
  }

  return ownerByToolId;
}

/**
 * Extract file changes from messages using a session ledger:
 * net diff(baseline, current) per file, multi-agent flag when ≥2 agents touch a file.
 * Rebuilds from messages so switching back from history keeps stats.
 */
export function useFileChanges({
  messages,
  getContentBlocks,
  findToolResult,
  startFromIndex = 0,
  subagentHistories,
  currentSessionId = null,
}: UseFileChangesParams): FileChangeSummary[] {
  return useMemo(() => {
    const ops: LedgerOp[] = [];
    const agentKeysAfterBase = new Set<string>();

    messages.forEach((message, messageIndex) => {
      if (messageIndex < startFromIndex) return;
      if (message.type !== 'assistant') return;

      const blocks = getContentBlocks(message);
      const ownerByToolId = resolveAgentIdForMainStreamBlocks(blocks);

      blocks.forEach((block) => {
        if (block.type !== 'tool_use') return;

        const rawName = block.name ?? '';
        const toolName = normalizeToolName(rawName);

        if (isToolName(toolName, AGENT_TOOL_NAMES) && block.id) {
          agentKeysAfterBase.add(block.id);
        }

        if (!isToolName(toolName, FILE_MODIFY_TOOL_NAMES)) return;

        const rawInput = block.input as Record<string, unknown> | undefined;
        if (!rawInput) return;

        const toolId = typeof block.id === 'string' ? block.id : undefined;
        const agentId = (toolId && ownerByToolId.get(toolId)) || 'main';

        const result = findToolResult(block.id, messageIndex);
        collectLedgerOpsFromToolUse({
          toolName,
          rawName,
          input: rawInput,
          result,
          agentId,
          out: ops,
        });
      });
    });

    if (subagentHistories && Object.keys(subagentHistories).length > 0) {
      const allowedKeys = startFromIndex > 0 ? agentKeysAfterBase : null;
      collectFromSubagentHistories(
        ops,
        subagentHistories,
        allowedKeys && allowedKeys.size > 0
          ? allowedKeys
          : (startFromIndex > 0 ? agentKeysAfterBase : null),
      );
    }

    const entries = buildSessionFileLedger(ops);
    let summaries = ledgerEntriesToSummaries(entries);

    // Cross-tab / multi-agent: persist who touched each path, then enrich badges.
    if (currentSessionId && summaries.length > 0) {
      const agentsByPath = new Map<string, string[]>();
      for (const e of entries) {
        agentsByPath.set(e.filePath, e.agentIds.length > 0 ? e.agentIds : ['main']);
      }
      // Snapshot BEFORE recording this session so "outside session" still sees others
      const priorMap = loadFileTouchMap();
      recordFileTouches(
        summaries.map((s) => s.filePath),
        currentSessionId,
        agentsByPath,
      );
      const mapAfter = loadFileTouchMap();

      summaries = summaries.map((s) => {
        const crossMulti = isMultiActorPath(s.filePath, mapAfter);
        const outside = wasTouchedOutsideSession(s.filePath, currentSessionId, priorMap);
        return {
          ...s,
          multiAgent: s.multiAgent === true || crossMulti,
          // Write overwrote a file another tab already touched → show M not A
          status: outside && s.status === 'A' ? 'M' : s.status,
          agentIds: s.agentIds,
        };
      });
    }

    return summaries;
  }, [messages, getContentBlocks, findToolResult, startFromIndex, subagentHistories, currentSessionId]);
}
