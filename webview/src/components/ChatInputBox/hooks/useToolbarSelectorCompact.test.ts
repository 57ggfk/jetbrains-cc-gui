import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  TOOLBAR_SELECTOR_MIN_GAP_PX,
  measureLeftContentWidth,
  shouldCollapseToolbarSelectors,
} from './useToolbarSelectorCompact';

describe('shouldCollapseToolbarSelectors', () => {
  it('does not collapse when left + right leave at least 20px gap', () => {
    // root 400, left 200, right 80 → used 280, free 120 ≥ 20
    expect(shouldCollapseToolbarSelectors(400, 200, 80)).toBe(false);
  });

  it('collapses when gap would be under 20px', () => {
    // root 300, left 200, right 90 → 200+90+20=310 > 300
    expect(shouldCollapseToolbarSelectors(300, 200, 90)).toBe(true);
  });

  it('collapses exactly at the 20px boundary (equal means would not fit with gap)', () => {
    // left + right + 20 === root → still need compact to preserve the gap
    expect(shouldCollapseToolbarSelectors(300, 200, 80, 20)).toBe(true);
  });

  it('does not collapse when free space equals min gap after content', () => {
    // left 200 + right 80 + 20 = 300, root 301 → ok
    expect(shouldCollapseToolbarSelectors(301, 200, 80, 20)).toBe(false);
  });

  it('uses TOOLBAR_SELECTOR_MIN_GAP_PX default of 20', () => {
    expect(TOOLBAR_SELECTOR_MIN_GAP_PX).toBe(20);
    expect(shouldCollapseToolbarSelectors(100, 50, 30)).toBe(true); // 50+30+20=100 → collapse at equality
    expect(shouldCollapseToolbarSelectors(101, 50, 30)).toBe(false);
  });

  it('does not collapse for invalid / empty measurements', () => {
    expect(shouldCollapseToolbarSelectors(0, 100, 50)).toBe(false);
    expect(shouldCollapseToolbarSelectors(200, 0, 50)).toBe(false);
  });

  it('works for long OpenCode-style model labels (all CLIs same rule)', () => {
    const longModel = 220; // e.g. "opencode/Deepseek-V4-Flash-Free" + icons + mode + reasoning
    const right = 72; // enhance + send
    const wide = 400;
    const narrow = 280;
    expect(shouldCollapseToolbarSelectors(wide, longModel, right)).toBe(false); // 220+72+20=312 < 400
    expect(shouldCollapseToolbarSelectors(narrow, longModel, right)).toBe(true); // 312 > 280
  });
});

describe('measureLeftContentWidth', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sums children widths and flex gap (not the stretched flex:1 box)', () => {
    const childA = { offsetWidth: 40 } as HTMLElement;
    const childB = { offsetWidth: 120 } as HTMLElement;
    const childC = { offsetWidth: 60 } as HTMLElement;
    const left = {
      children: {
        length: 3,
        0: childA,
        1: childB,
        2: childC,
      },
    } as unknown as HTMLElement;

    vi.stubGlobal('getComputedStyle', () => ({ columnGap: '4px', gap: '4px' }));

    // 40 + 4 + 120 + 4 + 60 = 228
    expect(measureLeftContentWidth(left)).toBe(228);
  });

  it('returns 0 for empty left cluster', () => {
    const left = { children: { length: 0 } } as unknown as HTMLElement;
    expect(measureLeftContentWidth(left)).toBe(0);
  });
});
