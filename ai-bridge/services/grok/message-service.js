/**
 * Grok Message Service — Claude-shaped contract, ACP primary transport.
 *
 * Input (from Java GrokSDKBridge / Claude-like send):
 *   message, sessionId, cwd, permissionMode, model, baseUrl, apiKey,
 *   attachments, openedFiles, agentPrompt, streaming, reasoningEffort
 *
 * Output protocol (Claude-compatible tags for UI):
 *   [MESSAGE_START] [STREAM_START] [CONTENT_DELTA] [MESSAGE]
 *   [THINKING_DELTA] [TOOL_RESULT] [USAGE] [SESSION_ID]
 *   [STREAM_END] [MESSAGE_END]
 *   final { success, sessionId, result } or [SEND_ERROR]
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildGrokEnv, buildErrorPayload } from './grok-utils.js';
import { runAcpTurn } from './grok-acp-client.js';
import { GrokEventNormalizer } from './grok-event-normalizer.js';

/**
 * @param {object} options Claude-shaped options bag (preferred) OR legacy positional via channel
 */
export async function sendMessage(
  messageOrOptions,
  sessionId = '',
  cwd = '',
  permissionMode = '',
  model = '',
  baseUrl = '',
  apiKey = '',
  attachments = []
) {
  const opts =
    messageOrOptions && typeof messageOrOptions === 'object' && !Array.isArray(messageOrOptions)
      ? messageOrOptions
      : {
          message: messageOrOptions,
          sessionId,
          cwd,
          permissionMode,
          model,
          baseUrl,
          apiKey,
          attachments,
        };

  const {
    message = '',
    sessionId: sid = '',
    cwd: workCwd = '',
    permissionMode: perm = '',
    model: modelId = '',
    baseUrl: url = '',
    apiKey: key = '',
    authMethod: authMethodOpt = '',
    attachments: atts = [],
    openedFiles = null,
    agentPrompt = '',
    streaming = true,
    reasoningEffort = '',
  } = opts;

  const normalizer = new GrokEventNormalizer({
    log: (...args) => console.log(...args),
    error: (...args) => console.error(...args),
  });

  try {
    console.error('[DEBUG] Grok sendMessage (ACP primary):', {
      hasSessionId: !!sid,
      cwd: workCwd || '(current)',
      model: modelId || '(default)',
      hasApiKey: !!(key || process.env.XAI_API_KEY),
      authMethod: authMethodOpt || process.env.GROK_AUTH_METHOD || '(default)',
      hasOAuthAuthFile: existsSync(join(homedir(), '.grok', 'auth.json')),
      hasOpenedFiles: !!openedFiles,
      hasAgentPrompt: !!agentPrompt,
      permissionMode: perm || '(default)',
      streaming,
      attachments: Array.isArray(atts) ? atts.length : 0,
      reasoningEffort: reasoningEffort || '(none)',
    });

    normalizer.begin();

    const env = buildGrokEnv(process.env, key, url, authMethodOpt || process.env.GROK_AUTH_METHOD || '');
    if (reasoningEffort) {
      env.GROK_REASONING_EFFORT = String(reasoningEffort);
    }

    const result = await runAcpTurn({
      message,
      sessionId: sid,
      cwd: workCwd,
      model: modelId,
      apiKey: key,
      baseUrl: url,
      authMethod: authMethodOpt || env.GROK_AUTH_METHOD || '',
      permissionMode: perm,
      agentPrompt,
      openedFiles,
      attachments: atts,
      env,
      onEvent: (type, payload) => normalizer.handleAcpEvent(type, payload),
      onStderr: (chunk) => {
        // Keep stderr for diagnostics only — never pollute JSON-RPC stdout
        const s = String(chunk || '').trim();
        if (s) {
          console.error('[GROK-ACP]', s.slice(0, 500));
        }
      },
    });

    normalizer.finishSuccess(result.sessionId, normalizer.assistantText);
  } catch (error) {
    console.error('[DEBUG] Grok ACP error:', error?.message || error);
    normalizer.finishError(error);
  }
}

// Re-export for tests / channel
export { buildErrorPayload };
