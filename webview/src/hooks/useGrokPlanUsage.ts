import { useCallback, useEffect, useRef, useState } from 'react';
import { BRIDGE_READY_EVENT } from '../utils/bridgeStartup';
import { parseCapacityPayload, type PlanUsageSnapshot } from '../utils/planUsagePace';

export type GrokPlanUsageState = {
  status: 'idle' | 'loading' | 'ready' | 'unavailable';
  snapshot: PlanUsageSnapshot | null;
};

const EMPTY: GrokPlanUsageState = { status: 'idle', snapshot: null };

const BACKOFF_MS = [20_000, 60_000, 300_000, 1_800_000] as const;
const SUCCESS_POLL_MS = 60_000;

/**
 * Apply one poll result. The bar stays hidden until a present payload, and a later
 * {@code present: false} hides it again. A stale present reading keeps the percent.
 */
function applySnapshot(snap: PlanUsageSnapshot): GrokPlanUsageState {
  if (snap.present) {
    return { status: 'ready', snapshot: snap };
  }
  return EMPTY;
}

/**
 * Grok plan usage for ContextBar via the Java bridge
 * ({@code get_grok_plan_usage} → ACP {@code _x.ai/billing} on grok agent stdio).
 */
export function useGrokPlanUsage(currentProvider: string) {
  const [state, setState] = useState<GrokPlanUsageState>(EMPTY);
  const genRef = useRef(0);
  const handlerRef = useRef<((json: string) => void) | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollRef = useRef<(() => void) | null>(null);
  const failureStepRef = useRef(0);
  const skipPollingRef = useRef(false);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const scheduleNext = useCallback((delayMs: number) => {
    clearTimer();
    if (skipPollingRef.current) return;
    timerRef.current = setTimeout(() => {
      pollRef.current?.();
    }, delayMs);
  }, [clearTimer]);

  const poll = useCallback(() => {
    if (currentProvider !== 'grok' || skipPollingRef.current) {
      return;
    }
    const gen = ++genRef.current;
    setState((prev) => (prev.snapshot?.present ? prev : EMPTY));

    const w = window as unknown as {
      updateGrokPlanUsage?: (json: string) => void;
      sendToJava?: (cmd: string) => void;
    };

    const handler = (jsonStr: string) => {
      if (gen !== genRef.current) return;
      try {
        const raw = typeof jsonStr === 'string' ? JSON.parse(jsonStr) : jsonStr;
        if (raw && typeof raw === 'object' && (raw as { skipPolling?: boolean }).skipPolling === true) {
          skipPollingRef.current = true;
          clearTimer();
          setState(EMPTY);
          return;
        }
        const snap = parseCapacityPayload(raw);
        if (snap.present && snap.stale === true) {
          const delay = BACKOFF_MS[failureStepRef.current];
          failureStepRef.current = Math.min(failureStepRef.current + 1, BACKOFF_MS.length - 1);
          setState(applySnapshot(snap));
          scheduleNext(delay);
        } else if (snap.present) {
          failureStepRef.current = 0;
          setState(applySnapshot(snap));
          scheduleNext(SUCCESS_POLL_MS);
        } else {
          const delay = BACKOFF_MS[failureStepRef.current];
          failureStepRef.current = Math.min(failureStepRef.current + 1, BACKOFF_MS.length - 1);
          setState(applySnapshot(snap));
          scheduleNext(delay);
        }
      } catch {
        const delay = BACKOFF_MS[failureStepRef.current];
        failureStepRef.current = Math.min(failureStepRef.current + 1, BACKOFF_MS.length - 1);
        setState((prev) => (prev.snapshot?.present ? prev : EMPTY));
        scheduleNext(delay);
      }
    };

    handlerRef.current = handler;
    w.updateGrokPlanUsage = (json: string) => {
      if (handlerRef.current) {
        handlerRef.current(json);
      }
    };

    try {
      w.sendToJava?.('get_grok_plan_usage:');
    } catch {
      if (gen === genRef.current) {
        const delay = BACKOFF_MS[failureStepRef.current];
        failureStepRef.current = Math.min(failureStepRef.current + 1, BACKOFF_MS.length - 1);
        setState((prev) => (prev.snapshot?.present ? prev : EMPTY));
        scheduleNext(delay);
      }
    }
  }, [clearTimer, currentProvider, scheduleNext]);

  pollRef.current = poll;

  const refresh = useCallback(() => {
    skipPollingRef.current = false;
    failureStepRef.current = 0;
    clearTimer();
    poll();
  }, [clearTimer, poll]);

  useEffect(() => {
    skipPollingRef.current = false;
    failureStepRef.current = 0;
    if (currentProvider !== 'grok') {
      setState(EMPTY);
      clearTimer();
      return () => {
        genRef.current += 1;
        clearTimer();
      };
    }
    const onBridgeReady = () => {
      pollRef.current?.();
    };
    window.addEventListener(BRIDGE_READY_EVENT, onBridgeReady);
    poll();
    return () => {
      genRef.current += 1;
      window.removeEventListener(BRIDGE_READY_EVENT, onBridgeReady);
      clearTimer();
    };
  }, [clearTimer, currentProvider, poll]);

  return { ...state, refresh };
}

export type UseGrokPlanUsageReturn = ReturnType<typeof useGrokPlanUsage>;
