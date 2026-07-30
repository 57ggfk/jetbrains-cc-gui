import {
  isDependencyStatusResponse,
  requestDependencyStatusUntilReady,
  waitForBridge,
} from './bridgeStartup';

describe('bridge startup recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    delete window.sendToJava;
    delete window.__ccgOnBridgeReady;
    window.__dependencyStatusReady = false;
  });

  afterEach(() => {
    window.dispatchEvent(new Event('pagehide'));
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('bootstraps once when the bridge appears after the fast retry window', () => {
    const callback = vi.fn();
    waitForBridge(callback);
    const bridgeReady = window.__ccgOnBridgeReady;

    vi.advanceTimersByTime(6000);
    expect(callback).not.toHaveBeenCalled();

    window.sendToJava = vi.fn();
    bridgeReady?.();
    bridgeReady?.();
    vi.runOnlyPendingTimers();

    expect(callback).toHaveBeenCalledTimes(1);
    expect(window.__ccgOnBridgeReady).toBeUndefined();
  });

  it('cancels bridge polling when the page is hidden', () => {
    const callback = vi.fn();
    waitForBridge(callback);

    window.dispatchEvent(new Event('pagehide'));
    window.sendToJava = vi.fn();
    vi.runOnlyPendingTimers();

    expect(callback).not.toHaveBeenCalled();
    expect(window.__ccgOnBridgeReady).toBeUndefined();
  });

  it('stops dependency status retries after a valid response', () => {
    const sendToJava = vi.fn();
    window.sendToJava = sendToJava;
    requestDependencyStatusUntilReady();

    expect(sendToJava).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2000);
    expect(sendToJava).toHaveBeenCalledTimes(2);

    window.__dependencyStatusReady = true;
    vi.advanceTimersByTime(2000);
    vi.runOnlyPendingTimers();

    expect(sendToJava).toHaveBeenCalledTimes(2);
  });

  it('rejects backend error payloads as dependency status responses', () => {
    expect(isDependencyStatusResponse({ 'claude-sdk': { installed: true } })).toBe(true);
    expect(isDependencyStatusResponse({ success: false, error: 'unavailable' })).toBe(false);
    expect(isDependencyStatusResponse({ success: false, error: null })).toBe(false);
    expect(isDependencyStatusResponse(null)).toBe(false);
  });
});
