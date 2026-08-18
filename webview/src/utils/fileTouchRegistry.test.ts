import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  clearFileTouchRegistry,
  getDistinctActorsForPath,
  isMultiActorPath,
  loadFileTouchMap,
  recordFileTouches,
  wasTouchedOutsideSession,
} from './fileTouchRegistry';

describe('fileTouchRegistry', () => {
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('records touches from two sessions on the same file as multi-actor', () => {
    const path = '/proj/name.js';
    recordFileTouches([path], 'AI1', new Map([[path, ['main']]]), 1);
    recordFileTouches([path], 'AI2', new Map([[path, ['main']]]), 2);

    expect(isMultiActorPath(path)).toBe(true);
    expect(getDistinctActorsForPath(path)).toHaveLength(2);
    expect(wasTouchedOutsideSession(path, 'AI2')).toBe(true);
    expect(wasTouchedOutsideSession(path, 'AI1')).toBe(true);
  });

  it('two agents in one session are multi-actor', () => {
    const path = '/proj/x.ts';
    recordFileTouches([path], 'sess', new Map([[path, ['main', 'task-a']]]), 1);
    expect(isMultiActorPath(path)).toBe(true);
  });

  it('single session single agent is not multi-actor', () => {
    const path = '/proj/y.ts';
    recordFileTouches([path], 'sess', new Map([[path, ['main']]]), 1);
    recordFileTouches([path], 'sess', new Map([[path, ['main']]]), 2);
    expect(isMultiActorPath(path)).toBe(false);
    expect(wasTouchedOutsideSession(path, 'sess')).toBe(false);
  });

  it('clear empties registry', () => {
    recordFileTouches(['/a'], 's', new Map([['/a', ['main']]]));
    expect(Object.keys(loadFileTouchMap()).length).toBeGreaterThan(0);
    clearFileTouchRegistry();
    expect(loadFileTouchMap()).toEqual({});
  });
});
