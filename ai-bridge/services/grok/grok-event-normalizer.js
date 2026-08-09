/**
 * Normalize Grok ACP events → Claude-compatible bridge protocol tags.
 *
 * Emits lines on stdout that GrokSDKBridge / ClaudeStreamAdapter-style parsers understand:
 *   [MESSAGE_START] [STREAM_START] [CONTENT_DELTA] [MESSAGE] [TOOL_RESULT]
 *   [THINKING_DELTA] [USAGE] [SESSION_ID] [STREAM_END] [MESSAGE_END] [SEND_ERROR]
 *
 * [USAGE] payloads are always snake_case (total_tokens/input_tokens/…) so Java
 * consumers can treat OpenAI shape as primary; camelCase ACP is normalized here.
 */

import { extractUsageFromAcpEnvelope, normalizeUsageToSnakeCase } from './grok-utils.js';

export class GrokEventNormalizer {
  constructor({ log = console.log, error = console.error } = {}) {
    this.log = log;
    this.error = error;
    this.assistantText = '';
    this.thinkingText = '';
    this.streamStarted = false;
    this.messageStarted = false;
    this.streamEnded = false;
    this.messageEnded = false;
    this.sessionId = null;
    this.toolCalls = new Map(); // toolCallId -> { name, args, status }
    /** Last normalized snake_case usage for this turn (attached to final [MESSAGE]). */
    this.lastUsage = null;
  }

  begin() {
    this.#emit('[MESSAGE_START]');
    this.messageStarted = true;
    this.#emit('[STREAM_START]');
    this.streamStarted = true;
  }

  handleAcpEvent(type, payload) {
    switch (type) {
      case 'session_id':
        this.sessionId = payload;
        this.#emit(`[SESSION_ID] ${payload}`);
        break;

      case 'notification':
        this.#handleNotification(payload?.method, payload?.params || {});
        break;

      case 'prompt_result':
        this.#handlePromptResult(payload);
        break;

      case 'server_request':
        // already handled by ACP client; optionally surface status
        if (payload?.method) {
          this.#emitStatus(`ACP request: ${payload.method}`);
        }
        break;

      default:
        break;
    }
  }

  finishSuccess(sessionId, resultText) {
    const finalSessionId = sessionId || this.sessionId || `grok-${Date.now()}`;
    if (!this.sessionId) {
      this.#emit(`[SESSION_ID] ${finalSessionId}`);
    }

    const text = (resultText != null && String(resultText).length > 0)
      ? String(resultText)
      : this.assistantText;

    // Final assistant message block for history (Claude-like).
    // Attach lastUsage so Java message.usage survives even if a mid-turn [USAGE]
    // was overwritten by a later MESSAGE without usage.
    const assistantMessage = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: this.#buildContentBlocks(text),
        ...(this.lastUsage ? { usage: this.lastUsage } : {}),
      },
    };
    // Ensure [USAGE] is emitted at least once before stream ends (prompt _meta path).
    if (this.lastUsage) {
      this.#emit(`[USAGE] ${JSON.stringify(this.lastUsage)}`);
    }
    this.#emit(`[MESSAGE] ${JSON.stringify(assistantMessage)}`);

    this.#emitStreamEndOnce();
    this.#emitMessageEndOnce();

    this.log(
      JSON.stringify({
        success: true,
        sessionId: finalSessionId,
        result: text,
      })
    );
  }

  finishError(error) {
    this.#emitStreamEndOnce();
    this.#emitMessageEndOnce();

    const payload = {
      success: false,
      error: formatGrokError(error),
    };
    this.error(`[SEND_ERROR] ${JSON.stringify(payload)}`);
    this.log(JSON.stringify(payload));
  }

  #emitUsage(raw) {
    if (!raw) return;
    const usage = normalizeUsageToSnakeCase(raw) || raw;
    // Avoid empty {} spam
    if (!usage || (typeof usage === 'object' && !Object.keys(usage).length)) return;
    this.lastUsage = usage;
    this.#emit(`[USAGE] ${JSON.stringify(usage)}`);
  }

  #handleNotification(method, params) {
    // Grok CLI 0.2.x: usage arrives on _x.ai/session_notification (turn_completed),
    // not on classic sessionUpdate=usage_update.
    const fromEnvelope = extractUsageFromAcpEnvelope(method, params);
    if (fromEnvelope) {
      this.#emitUsage(fromEnvelope);
    }

    if (method !== 'session/update') {
      return;
    }
    const update = params?.update || params;
    if (!update) return;

    const kind = update.sessionUpdate || update.type || '';

    switch (kind) {
      case 'agent_message_chunk': {
        const text = extractText(update.content);
        if (text) {
          this.assistantText += text;
          this.#emit(`[CONTENT_DELTA] ${JSON.stringify(text)}`);
        }
        break;
      }
      case 'agent_thought_chunk':
      case 'agent_thinking_chunk':
      case 'thought_chunk': {
        const text = extractText(update.content) || update.text || '';
        if (text) {
          this.thinkingText += text;
          this.#emit(`[THINKING_DELTA] ${JSON.stringify(text)}`);
        }
        break;
      }
      case 'tool_call':
      case 'tool_call_update': {
        this.#handleToolUpdate(update);
        break;
      }
      case 'usage_update':
      case 'usage':
      case 'turn_completed': {
        // usage already emitted via extractUsageFromAcpEnvelope above when present
        break;
      }
      case 'user_message_chunk':
      case 'available_commands_update':
      case 'current_mode_update':
      case 'plan':
        // ignore or future UI
        break;
      default: {
        // Try generic text fields
        const text = extractText(update.content) || update.text;
        if (text && kind.includes('message')) {
          this.assistantText += text;
          this.#emit(`[CONTENT_DELTA] ${JSON.stringify(text)}`);
        }
        break;
      }
    }
  }

  #handleToolUpdate(update) {
    const toolCallId =
      update.toolCallId ||
      update.tool_call_id ||
      update.id ||
      update.toolUseId ||
      `tool-${Date.now()}`;
    const name = update.title || update.name || update.toolName || 'tool';
    const status = update.status || update.kind || '';
    const rawInput = update.rawInput || update.input || update.arguments || {};
    const rawOutput = update.rawOutput || update.output || update.result;

    const prev = this.toolCalls.get(toolCallId) || {};
    this.toolCalls.set(toolCallId, { ...prev, name, status, rawInput, rawOutput });

    // Emit tool_use on first sight / in_progress
    if (!prev.emittedUse) {
      const toolUseMsg = {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: toolCallId,
              name,
              input: typeof rawInput === 'object' ? rawInput : { value: rawInput },
            },
          ],
        },
      };
      this.#emit(`[MESSAGE] ${JSON.stringify(toolUseMsg)}`);
      this.#emit('[BLOCK_RESET]');
      this.toolCalls.set(toolCallId, {
        ...this.toolCalls.get(toolCallId),
        emittedUse: true,
      });
    }

    // Emit tool_result when completed/failed with output
    const done =
      status === 'completed' ||
      status === 'failed' ||
      status === 'cancelled' ||
      rawOutput != null;
    if (done && !prev.emittedResult) {
      const content =
        typeof rawOutput === 'string'
          ? rawOutput
          : rawOutput != null
            ? JSON.stringify(rawOutput)
            : status || 'done';
      const toolResult = {
        type: 'tool_result',
        tool_use_id: toolCallId,
        content,
        is_error: status === 'failed',
      };
      this.#emit(`[TOOL_RESULT] ${JSON.stringify(toolResult)}`);
      this.toolCalls.set(toolCallId, {
        ...this.toolCalls.get(toolCallId),
        emittedResult: true,
      });
    }
  }

  #handlePromptResult(result) {
    // session/prompt result: usage is usually under result._meta.usage (Grok CLI 0.2.x),
    // sometimes result.usage, sometimes flat _meta.totalTokens.
    const raw = extractUsageFromAcpEnvelope(result);
    if (raw) {
      this.#emitUsage(raw);
    }
    if (result?.stopReason || result?.stop_reason) {
      // optional
    }
  }

  #buildContentBlocks(text) {
    const blocks = [];
    if (this.thinkingText) {
      blocks.push({ type: 'thinking', thinking: this.thinkingText });
    }
    if (text) {
      blocks.push({ type: 'text', text });
    }
    return blocks.length ? blocks : [{ type: 'text', text: '' }];
  }

  #emitStatus(text) {
    // Not a Claude tag; useful in logs only
    this.error(`[DEBUG] ${text}`);
  }

  #emit(line) {
    this.log(line);
  }

  #emitStreamEndOnce() {
    if (!this.streamStarted || this.streamEnded) return;
    this.streamEnded = true;
    this.#emit('[STREAM_END]');
  }

  #emitMessageEndOnce() {
    if (!this.messageStarted || this.messageEnded) return;
    this.messageEnded = true;
    this.#emit('[MESSAGE_END]');
  }
}

function extractText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    if (typeof content.content === 'string') return content.content;
  }
  return '';
}

export function formatGrokError(error) {
  if (!error) return 'Unknown Grok error';
  const msg = error.message || String(error);
  const stderr = error.stderr || '';
  const combined = `${msg}\n${stderr}`;

  // Already formatted?
  if (msg.startsWith('Grok API denied the request') || msg.startsWith('Grok authentication failed')
      || msg.startsWith('Grok gateway') || msg.startsWith('Grok chat endpoint denied')) {
    return msg;
  }

  // ai-proxy gateway: root POST /v1/chat/completions is locked
  if (/chat\/completions is not routed|billing leak prevention/i.test(combined)
      || (/gateway:/i.test(combined) && /\/v1\/chat\/completions/i.test(combined))) {
    return (
      'Grok gateway rejected the path (403): POST /v1/chat/completions is not routed.\n' +
      'Use a namespaced base URL:\n' +
      '  • API key → …/xai/v1\n' +
      '  • OAuth   → …/grok/v1\n' +
      'Settings → Grok → set API Base URL / OAuth Base URL (not bare …/v1).\n\n' +
      msg
    );
  }

  // ai-proxy gateway: missing x-gateway-token
  if (/unknown or missing x-gateway-token|x-gateway-token/i.test(combined)
      && (/gateway:/i.test(combined) || /401/i.test(combined))) {
    return (
      'Grok gateway auth failed (401): missing or invalid x-gateway-token.\n' +
      'Grok CLI cannot send custom headers. Point base URL at local-agent\n' +
      '(e.g. http://127.0.0.1:18789/xai/v1 or …/grok/v1) which injects the token.\n\n' +
      msg
    );
  }


  // SuperGrok OAuth chat endpoint denial (cli-chat-proxy) — not the same as API-key credits.
  if (/cli-chat-proxy\.grok\.com|Access to the chat endpoint is denied/i.test(combined)) {
    return (
      'Grok chat endpoint denied (403) for this account/session.\n' +
      'OAuth login succeeded, but xAI rejected cli-chat-proxy access.\n' +
      'This is usually an xAI account/subscription entitlement issue (not the JetBrains plugin).\n' +
      'Try:\n' +
      '  1) `grok login --oauth` (or `--device-auth`) again with the SuperGrok account\n' +
      '  2) Confirm SuperGrok/Heavy is active for that account on grok.com / console.x.ai\n' +
      '  3) `grok update` then re-test with: `grok "hi"` in a terminal\n' +
      '  4) If API billing is intended: Settings → Grok → Auth = API key + valid XAI_API_KEY\n\n' +
      msg
    );
  }

  // API-key / team credits denial
  if (/credits|licenses|no credits/i.test(combined) ||
      (/403|permission-denied/i.test(combined) && /console\.x\.ai|XAI_API_KEY|api key/i.test(combined))) {
    const teamUrlMatch = combined.match(/https:\/\/console\.x\.ai\/team\/[a-f0-9-]+/i);
    const teamUrl = teamUrlMatch ? teamUrlMatch[0] : 'https://console.x.ai';
    return (
      `Grok API denied the request (403): no credits/licenses on the team.\n` +
      `Purchase credits: ${teamUrl}\n` +
      `Or switch Settings → Grok → Auth to OAuth if you use SuperGrok.`
    );
  }
  if (/403|permission-denied/i.test(combined)) {
    return (
      'Grok denied the request (403).\n' +
      'If using OAuth/SuperGrok: re-run `grok login` and confirm subscription access to Grok CLI.\n' +
      'If using API key: check credits on console.x.ai and Settings → Grok Auth mode.\n\n' +
      msg
    );
  }
  if (/auth|XAI_API_KEY|authenticate/i.test(combined)) {
    return (
      'Grok authentication failed. Use Settings → Grok Auth (OAuth or API key).\n\n' + msg
    );
  }
  return msg;
}
