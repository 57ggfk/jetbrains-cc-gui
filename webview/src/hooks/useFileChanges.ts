import { useMemo } from 'react';
import type { ClaudeMessage, ClaudeContentBlock, ToolResultBlock } from '../types';
import type { FileChangeSummary, EditOperation, FileChangeStatus } from '../types/fileChanges';
import type { SubagentHistoryResponse } from '../types/subagent';
import { getFileName } from '../utils/helpers';
import {
  FILE_MODIFY_TOOL_NAMES,
  AGENT_TOOL_NAMES,
  isToolName,
  normalizeToolName,
} from '../utils/toolConstants';
import { normalizeToolInput } from '../utils/toolInputNormalization';
import { getToolLineInfo } from '../utils/toolPresentation';

/** Write tool names that indicate a new file */
const WRITE_TOOL_NAMES = new Set(['write', 'write_file', 'create_file']);

/**
 * Maximum lines to use full LCS algorithm.
 * LCS is O(n*m); above this threshold use multiset estimation (O(n+m)).
 */
const LCS_MAX_LINES = 100;

/** Cache for diff calculations to avoid redundant computations */
const diffCache = new Map<string, { additions: number; deletions: number }>();
const DIFF_CACHE_MAX_SIZE = 100;

/** Clear module-level diff cache (for tests). */
export function clearDiffCache(): void {
  diffCache.clear();
}

/**
 * djb2-style hash so cache keys cover full content, not just prefixes.
 */
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
 * Multiset line comparison: counts how many lines are shared (order-insensitive),
 * then treats the rest as additions/deletions. Correct for full equal-line
 * replacements (unlike net line-count), and O(n) for large snippets.
 */
function computeMultisetDiff(
  oldLines: string[],
  newLines: string[],
): { additions: number; deletions: number } {
  const remaining = new Map<string, number>();
  for (const line of oldLines) {
    remaining.set(line, (remaining.get(line) ?? 0) + 1);
  }

  let common = 0;
  for (const line of newLines) {
    const count = remaining.get(line) ?? 0;
    if (count > 0) {
      common += 1;
      remaining.set(line, count - 1);
    }
  }

  return {
    additions: newLines.length - common,
    deletions: oldLines.length - common,
  };
}

/**
 * LCS-based diff count for moderate-sized snippets.
 */
function computeLcsDiff(
  oldLines: string[],
  newLines: string[],
  m: number,
  n: number,
): { additions: number; deletions: number } {
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  let additions = 0;
  let deletions = 0;
  let i = m;
  let j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      i -= 1;
      j -= 1;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      additions += 1;
      j -= 1;
    } else {
      deletions += 1;
      i -= 1;
    }
  }

  return { additions, deletions };
}

/**
 * Compute diff statistics (additions and deletions count).
 * Small snippets use LCS; large ones use multiset estimation so equal-line
 * replacements still report both +N and -M instead of +0/-0.
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

  const oldLines = oldString ? oldString.split('\n') : [];
  const newLines = newString ? newString.split('\n') : [];

  let result: { additions: number; deletions: number };

  if (oldLines.length === 0 && newLines.length === 0) {
    result = { additions: 0, deletions: 0 };
  } else if (oldLines.length === 0) {
    result = { additions: newLines.length, deletions: 0 };
  } else if (newLines.length === 0) {
    result = { additions: 0, deletions: oldLines.length };
  } else {
    const m = oldLines.length;
    const n = newLines.length;
    result = (m > LCS_MAX_LINES || n > LCS_MAX_LINES)
      ? computeMultisetDiff(oldLines, newLines)
      : computeLcsDiff(oldLines, newLines, m, n);
  }

  if (diffCache.size >= DIFF_CACHE_MAX_SIZE) {
    const firstKey = diffCache.keys().next().value;
    if (firstKey) {
      diffCache.delete(firstKey);
    }
  }
  diffCache.set(cacheKey, result);

  return result;
}

/**
 * Extract file path from tool input (handles various naming conventions).
 */
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

/**
 * Expand tool input into one or more edit pairs.
 * MultiEdit / edit_file may carry an edits[] array; plain Edit/Write use top-level fields.
 */
function extractEditPairs(input: Record<string, unknown>): StringPair[] {
  const edits = input.edits;
  if (Array.isArray(edits) && edits.length > 0) {
    const pairs: StringPair[] = [];
    for (const item of edits) {
      if (!item || typeof item !== 'object') continue;
      const pair = pairFromRecord(item as Record<string, unknown>);
      // Skip empty no-op entries
      if (pair.oldString === '' && pair.newString === '') continue;
      pairs.push(pair);
    }
    if (pairs.length > 0) return pairs;
  }

  return [pairFromRecord(input)];
}

function determineFileStatus(operations: EditOperation[]): FileChangeStatus {
  if (operations.length === 0) return 'M';

  const firstOp = operations[0];
  if (WRITE_TOOL_NAMES.has(normalizeToolName(firstOp.toolName))) {
    return 'A';
  }
  if (firstOp.oldString === '' && firstOp.newString !== '') {
    return 'A';
  }
  return 'M';
}

function isSuccessfulResult(result?: ToolResultBlock | null): boolean {
  return result !== undefined && result !== null && result.is_error !== true;
}

function pushOperation(
  map: Map<string, EditOperation[]>,
  filePath: string,
  operation: EditOperation,
): void {
  const existing = map.get(filePath) ?? [];
  existing.push(operation);
  map.set(filePath, existing);
}

function collectFromToolUse(params: {
  toolName: string;
  rawName?: string;
  input: Record<string, unknown>;
  result: ToolResultBlock | null | undefined;
  map: Map<string, EditOperation[]>;
}): void {
  const { toolName, rawName, input, result, map } = params;
  if (!isToolName(toolName, FILE_MODIFY_TOOL_NAMES)) return;
  if (!isSuccessfulResult(result)) return;

  const normalized = normalizeToolInput(rawName ?? toolName, input) as Record<string, unknown>;
  const defaultPath = extractFilePath(normalized);
  const pairs = extractEditPairs(normalized);
  const lineInfo = getToolLineInfo(normalized, undefined, result);

  for (const pair of pairs) {
    const filePath = pair.filePath || defaultPath;
    if (!filePath) continue;

    // Skip completely empty pairs (no path-only noise)
    if (pair.oldString === '' && pair.newString === '') continue;

    const { additions, deletions } = computeDiffStats(pair.oldString, pair.newString);
    pushOperation(map, filePath, {
      toolName,
      oldString: pair.oldString,
      newString: pair.newString,
      additions,
      deletions,
      replaceAll: pair.replaceAll,
      lineStart: lineInfo.start,
      lineEnd: lineInfo.end,
    });
  }
}

/**
 * Read content blocks from either a ClaudeMessage-shaped object or a raw
 * subagent transcript message (`message.content` or top-level `content`).
 */
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
  map: Map<string, EditOperation[]>,
  subagentHistories: Record<string, SubagentHistoryResponse>,
  allowedKeys: Set<string> | null,
): void {
  for (const [key, history] of Object.entries(subagentHistories)) {
    if (!history?.success || !Array.isArray(history.messages)) continue;
    if (allowedKeys && !allowedKeys.has(key)) {
      // Also allow match by agentId field on the history payload
      if (!history.agentId || !allowedKeys.has(history.agentId)) {
        if (!history.toolUseId || !allowedKeys.has(history.toolUseId)) {
          continue;
        }
      }
    }

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

        collectFromToolUse({
          toolName,
          rawName: name,
          input: rawInput as Record<string, unknown>,
          result,
          map,
        });
      }
    }
  }
}

function buildSummaries(map: Map<string, EditOperation[]>): FileChangeSummary[] {
  const summaries: FileChangeSummary[] = [];

  map.forEach((operations, filePath) => {
    const totalAdditions = operations.reduce((sum, op) => sum + (op.additions || 0), 0);
    const totalDeletions = operations.reduce((sum, op) => sum + (op.deletions || 0), 0);
    const rawStatus = determineFileStatus(operations);
    const status: FileChangeStatus = rawStatus === 'A' ? 'A' : 'M';
    const firstLineOperation = operations.find((op) => typeof op.lineStart === 'number');

    summaries.push({
      filePath: String(filePath || ''),
      fileName: String(getFileName(filePath) || filePath || 'unknown'),
      status,
      additions: totalAdditions,
      deletions: totalDeletions,
      lineStart: firstLineOperation?.lineStart,
      lineEnd: firstLineOperation?.lineEnd,
      operations,
    });
  });

  summaries.sort((a, b) => {
    if (a.status !== b.status) {
      return a.status === 'A' ? -1 : 1;
    }
    return a.filePath.localeCompare(b.filePath);
  });

  return summaries;
}

interface UseFileChangesParams {
  messages: ClaudeMessage[];
  getContentBlocks: (message: ClaudeMessage) => ClaudeContentBlock[];
  findToolResult: (toolUseId?: string, messageIndex?: number) => ToolResultBlock | null;
  /** Start processing messages from this index (for Keep All feature) */
  startFromIndex?: number;
  /** Background agent sidechain transcripts — their Edit/Write tools must also count */
  subagentHistories?: Record<string, SubagentHistoryResponse>;
}

/**
 * Hook to extract and aggregate file changes from messages (and optional subagent histories).
 */
export function useFileChanges({
  messages,
  getContentBlocks,
  findToolResult,
  startFromIndex = 0,
  subagentHistories,
}: UseFileChangesParams): FileChangeSummary[] {
  return useMemo(() => {
    const fileOperationsMap = new Map<string, EditOperation[]>();
    const agentKeysAfterBase = new Set<string>();

    messages.forEach((message, messageIndex) => {
      if (messageIndex < startFromIndex) return;
      if (message.type !== 'assistant') return;

      const blocks = getContentBlocks(message);

      blocks.forEach((block) => {
        if (block.type !== 'tool_use') return;

        const rawName = block.name ?? '';
        const toolName = normalizeToolName(rawName);

        // Track Agent/Task invocations so we only pull matching sidechain edits
        // after the Keep All baseline.
        if (isToolName(toolName, AGENT_TOOL_NAMES) && block.id) {
          agentKeysAfterBase.add(block.id);
        }

        if (!isToolName(toolName, FILE_MODIFY_TOOL_NAMES)) return;

        const rawInput = block.input as Record<string, unknown> | undefined;
        if (!rawInput) return;

        const result = findToolResult(block.id, messageIndex);
        collectFromToolUse({
          toolName,
          rawName,
          input: rawInput,
          result,
          map: fileOperationsMap,
        });
      });
    });

    if (subagentHistories && Object.keys(subagentHistories).length > 0) {
      // When startFromIndex is 0, include every history; otherwise only agents
      // launched after the Keep All baseline.
      const allowedKeys = startFromIndex > 0 ? agentKeysAfterBase : null;
      // Always also allow keys that appear in agentKeysAfterBase even when base is 0
      // (null means unrestricted).
      collectFromSubagentHistories(
        fileOperationsMap,
        subagentHistories,
        allowedKeys && allowedKeys.size > 0 ? allowedKeys : (startFromIndex > 0 ? agentKeysAfterBase : null),
      );
    }

    return buildSummaries(fileOperationsMap);
  }, [messages, getContentBlocks, findToolResult, startFromIndex, subagentHistories]);
}
