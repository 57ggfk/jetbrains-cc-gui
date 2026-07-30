import { sendBridgeEvent } from './bridge';

const BRIDGE_FAST_RETRY_ATTEMPTS = 50;
const BRIDGE_FAST_RETRY_INTERVAL_MS = 100;
const BRIDGE_SLOW_RETRY_INTERVAL_MS = 1000;
const DEPENDENCY_STATUS_FAST_RETRY_ATTEMPTS = 3;
const DEPENDENCY_STATUS_FAST_RETRY_INTERVAL_MS = 2000;
const DEPENDENCY_STATUS_SLOW_RETRY_INTERVAL_MS = 5000;

export function waitForBridge(callback: () => void): () => void {
  let attempt = 0;
  let completed = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const cancel = () => {
    completed = true;
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
    delete window.__ccgOnBridgeReady;
  };

  const check = () => {
    if (completed) {
      return;
    }
    attempt++;
    if (window.sendToJava) {
      completed = true;
      if (retryTimer !== undefined) {
        clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      delete window.__ccgOnBridgeReady;
      window.removeEventListener('pagehide', cancel);
      callback();
      return;
    }

    if (attempt === BRIDGE_FAST_RETRY_ATTEMPTS) {
      console.warn('[Main] Bridge startup is delayed; continuing low-frequency retries');
    }
    const retryInterval = attempt < BRIDGE_FAST_RETRY_ATTEMPTS
      ? BRIDGE_FAST_RETRY_INTERVAL_MS
      : BRIDGE_SLOW_RETRY_INTERVAL_MS;
    retryTimer = setTimeout(check, retryInterval);
  };

  window.__ccgOnBridgeReady = check;
  window.addEventListener('pagehide', cancel, { once: true });
  check();
  return cancel;
}

export function requestDependencyStatusUntilReady(): () => void {
  let attempt = 0;
  let cancelled = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const cancel = () => {
    cancelled = true;
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
  };

  const request = () => {
    if (cancelled) {
      return;
    }
    if (window.__dependencyStatusReady) {
      cancel();
      window.removeEventListener('pagehide', cancel);
      return;
    }

    attempt++;
    sendBridgeEvent('get_dependency_status');
    if (attempt === DEPENDENCY_STATUS_FAST_RETRY_ATTEMPTS) {
      console.warn('[Main] SDK status response is delayed; continuing low-frequency retries');
    }

    const retryInterval = attempt < DEPENDENCY_STATUS_FAST_RETRY_ATTEMPTS
      ? DEPENDENCY_STATUS_FAST_RETRY_INTERVAL_MS
      : DEPENDENCY_STATUS_SLOW_RETRY_INTERVAL_MS;
    retryTimer = setTimeout(request, retryInterval);
  };

  window.addEventListener('pagehide', cancel, { once: true });
  request();
  return cancel;
}

export function isDependencyStatusResponse(payload: unknown): boolean {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return false;
  }
  const response = payload as Record<string, unknown>;
  return response.success !== false;
}
