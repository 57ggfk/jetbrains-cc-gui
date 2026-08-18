/**
 * DSH message service — sends one user turn through a persistent `dsh web`
 * host and maps the mux stream onto the shared bridge marker protocol.
 *
 * Flow (aligned with desktop-cc-gui engine/dsh/mod.rs send_user_turn):
 *   ensure host (adopt or spawn) → workspace.create(cwd) → session.create or
 *   reuse → session.selectModel (when changed) → subscribe mux →
 *   session.prompt(queue) → stream until Goal-aware turn settlement.
 *
 * Marker output is consumed by Java MarkerCliBridge / CodexMessageHandler.
 */

import {
  beginStream,
  emitJsonStringMarker,
  emitSendError,
  emitSessionId,
  emitToolResultMessage,
  emitToolUseMessage,
  emitUsage,
  endStream,
} from '../../utils/marker-protocol.js';
import {
  bridgeDshApproval,
  bridgeDshQuestion,
  DshGoalSettlement,
  DshMuxConnection,
  peekMuxSessionId,
  projectMuxFrame,
} from './events.js';
import { ensureHost, runtimeSettingsFromEnv } from './supervisor.js';
import * as dshSession from './session.js';

function logDebug(...args) {
  console.error('[DEBUG][DSH]', ...args);
}

const MUX_OPEN_TIMEOUT_MS = 15_000;

function isImageAttachment(attachment) {
  const mediaType = attachment && typeof attachment.mediaType === 'string'
    ? attachment.mediaType.toLowerCase()
    : '';
  return mediaType.startsWith('image/');
}

function splitModelTuple(model) {
  const trimmed = String(model || '').trim();
  if (!trimmed || trimmed === 'auto' || trimmed === 'default' || trimmed === 'dsh-default') {
    return null;
  }
  const slash = trimmed.indexOf('/');
  if (slash === -1) {
    return { provider: '', model: trimmed };
  }
  return {
    provider: trimmed.slice(0, slash),
    model: trimmed.slice(slash + 1),
  };
}

/**
 * @param {object} options
 * @param {string} options.message
 * @param {string} [options.sessionId]
 * @param {string} [options.cwd]
 * @param {string} [options.model] "<provider>/<model>" or empty for host default
 * @param {string} [options.reasoningEffort]
 * @param {Array} [options.attachments] base64 {fileName, mediaType, data}
 */
export async function sendMessage(options = {}) {
  const {
    message = '',
    sessionId: incomingSessionId = '',
    cwd = '',
    model = '',
    reasoningEffort = '',
    attachments = [],
  } = options;

  const settings = runtimeSettingsFromEnv();
  const workCwd = cwd && cwd !== 'undefined' && cwd !== 'null' ? cwd : process.cwd();

  let hostHandle;
  try {
    hostHandle = await ensureHost(settings);
  } catch (error) {
    emitSendError(error.message, 'DSH');
    return;
  }
  const { client } = hostHandle;
  logDebug(`host ${hostHandle.origin} (${hostHandle.ownership})`);

  // Workspace binding — never let the session fall into the host cwd.
  let workspaceId;
  try {
    const workspace = await dshSession.createWorkspace(client, workCwd);
    workspaceId = dshSession.workspaceIdFromCreate(workspace);
  } catch (error) {
    emitSendError(`dsh workspace.create failed: ${error.message}`, 'DSH');
    return;
  }

  // Session identity: DSH returns the real id immediately; never mint a local UUID.
  let sessionId = dshSession.sessionIdFromThread(incomingSessionId);
  if (!sessionId) {
    try {
      sessionId = await dshSession.createSession(client, workspaceId);
    } catch (error) {
      emitSendError(`dsh session.create failed: ${error.message}`, 'DSH');
      return;
    }
  }
  emitSessionId(sessionId);

  // Model selection — only when the composer picked an explicit tuple.
  const tuple = splitModelTuple(model);
  if (tuple && tuple.provider && tuple.model) {
    try {
      await dshSession.selectModel(
        client,
        sessionId,
        tuple.provider,
        tuple.model,
        reasoningEffort || undefined
      );
    } catch (error) {
      logDebug(`selectModel failed (continuing with session model): ${error.message}`);
    }
  }

  // Attachments: images become DSH image parts; everything else degrades to a
  // path note so the model still knows the file exists.
  const images = [];
  const nonImageNotes = [];
  for (const attachment of Array.isArray(attachments) ? attachments : []) {
    if (!attachment || !attachment.data) {
      continue;
    }
    if (isImageAttachment(attachment)) {
      images.push({
        mediaType: attachment.mediaType,
        data: attachment.data,
        name: attachment.fileName || undefined,
      });
    } else if (attachment.fileName) {
      nonImageNotes.push(attachment.fileName);
    }
  }
  let text = String(message ?? '');
  if (nonImageNotes.length > 0) {
    text += `\n\n[Attached non-image files not sent inline: ${nonImageNotes.join(', ')}]`;
  }

  // Mux subscription must be live before prompt, or early frames are lost.
  const settlement = new DshGoalSettlement();
  let settled = false;
  let settleError = null;
  let sawTurnStart = false;
  let lastActivityAt = Date.now();
  const pendingBridges = new Set();

  const mux = new DshMuxConnection(client.muxUrl(), (frame, rpcId, raw) => {
    const frameSessionId = peekMuxSessionId(raw);
    if (!frameSessionId || frameSessionId !== sessionId) {
      return;
    }
    lastActivityAt = Date.now();
    const frameType = typeof frame.type === 'string' ? frame.type : '';
    const events = projectMuxFrame(frameType, frame, rpcId);
    for (const event of events) {
      switch (event.kind) {
        case 'text-delta':
          emitJsonStringMarker('[CONTENT_DELTA]', event.text);
          break;
        case 'reasoning-delta':
          emitJsonStringMarker('[THINKING_DELTA]', event.text);
          break;
        case 'tool-call':
          emitToolUseMessage({ id: event.toolId, name: event.toolName, input: event.input });
          break;
        case 'tool-result':
          emitToolResultMessage({
            toolUseId: event.toolId,
            content: typeof event.output === 'string' ? event.output : JSON.stringify(event.output ?? ''),
            isError: event.isError,
          });
          break;
        case 'usage':
          emitUsage({
            input_tokens: event.inputTokens ?? 0,
            output_tokens: event.outputTokens ?? 0,
            cache_read_input_tokens: event.cachedTokens ?? 0,
          });
          break;
        case 'turn-start':
          sawTurnStart = true;
          settlement.feed('turn-start');
          break;
        case 'turn-completed':
          if (settlement.feed('turn-completed') === 'settle') {
            settled = true;
          }
          break;
        case 'turn-error':
          settlement.feed('turn-error');
          settleError = event.error || 'DSH turn failed';
          settled = true;
          break;
        case 'goal-change':
          if (settlement.feed('goal-change', event.data) === 'settle') {
            settled = true;
          }
          break;
        case 'approval-request': {
          const bridge = bridgeDshApproval(client, event, sessionId, logDebug)
            .catch((error) => logDebug(`approval bridge failed: ${error.message}`));
          pendingBridges.add(bridge);
          bridge.finally(() => pendingBridges.delete(bridge));
          break;
        }
        case 'question-request': {
          const bridge = bridgeDshQuestion(client, event, sessionId, logDebug)
            .catch((error) => logDebug(`question bridge failed: ${error.message}`));
          pendingBridges.add(bridge);
          bridge.finally(() => pendingBridges.delete(bridge));
          break;
        }
        default:
          break;
      }
    }
  }, logDebug);

  mux.connect();
  const opened = await Promise.race([
    mux.whenOpen().then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), MUX_OPEN_TIMEOUT_MS)),
  ]);
  if (!opened) {
    mux.close();
    emitSendError('dsh mux WebSocket did not open in time', 'DSH');
    return;
  }

  // Best-effort cancel on interrupt (SIGTERM from Java process manager).
  const onShutdownSignal = () => {
    dshSession.cancel(client, sessionId).catch(() => {});
    mux.close();
    process.exit(143);
  };
  process.once('SIGTERM', onShutdownSignal);
  process.once('SIGINT', onShutdownSignal);

  beginStream();
  try {
    const ack = await dshSession.prompt(client, sessionId, text, images);
    if (ack && ack.accepted === false) {
      throw new Error(`prompt rejected by host (${ack.reason || 'unknown reason'})`);
    }
  } catch (error) {
    endStream();
    mux.close();
    emitSendError(`dsh session.prompt failed: ${error.message}`, 'DSH');
    return;
  }

  // Wait for Goal-aware settlement. Silence watchdog: no frames for this
  // session and no in-flight approval/question for a long stretch means the
  // turn terminal was lost (e.g. mux reconnect gap) — fail instead of hanging.
  const SILENCE_TIMEOUT_MS = 15 * 60_000;
  await new Promise((resolve) => {
    const poll = setInterval(() => {
      if (settled) {
        clearInterval(poll);
        resolve();
        return;
      }
      if (
        pendingBridges.size === 0 &&
        Date.now() - lastActivityAt > SILENCE_TIMEOUT_MS
      ) {
        clearInterval(poll);
        settleError = 'DSH turn went silent — the host stopped streaming for this session';
        settled = true;
        resolve();
      }
    }, 100);
  });

  // Let in-flight approval/question bridges finish their respond RPC.
  if (pendingBridges.size > 0) {
    await Promise.race([
      Promise.allSettled([...pendingBridges]),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }

  endStream();
  mux.close();

  if (settleError) {
    emitSendError(settleError, 'DSH');
    return;
  }
  if (!sawTurnStart) {
    logDebug('turn settled without turn/start (queued turn may have been coalesced)');
  }
}
