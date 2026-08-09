import { describe, expect, it } from 'vitest';
import { buildCodexModelList } from './codexModelList';
import { CODEX_MODELS } from './types';
import type { ModelInfo } from './types';

const catalog: ModelInfo[] = [
  { id: 'kimi-k3', label: 'kimi-k3', description: 'kimi-k3' },
];

describe('buildCodexModelList', () => {
  it('puts catalog entries first and appends custom models', () => {
    const customs: ModelInfo[] = [{ id: 'my-model', label: 'My Model' }];
    expect(buildCodexModelList(catalog, customs).map((m) => m.id)).toEqual(['kimi-k3', 'my-model']);
  });

  it('dedupes custom models that collide with catalog entries', () => {
    const customs: ModelInfo[] = [{ id: 'kimi-k3', label: 'Custom Label' }];
    const merged = buildCodexModelList(catalog, customs);
    expect(merged).toHaveLength(1);
    expect(merged[0].label).toBe('kimi-k3');
  });

  it('keeps the catalog order (config default pinned first by the backend)', () => {
    const multi: ModelInfo[] = [
      { id: 'kimi-k3', label: 'kimi-k3' },
      { id: 'other-model', label: 'Other' },
    ];
    expect(buildCodexModelList(multi, []).map((m) => m.id)).toEqual(['kimi-k3', 'other-model']);
  });

  it('returns customs when the catalog is empty', () => {
    const customs: ModelInfo[] = [{ id: 'my-model', label: 'My Model' }];
    expect(buildCodexModelList([], customs).map((m) => m.id)).toEqual(['my-model']);
  });

  it('falls back to the static built-in list shape when given CODEX_MODELS', () => {
    // Official-provider path: hook substitutes CODEX_MODELS as the catalog.
    const merged = buildCodexModelList(CODEX_MODELS, []);
    expect(merged.map((m) => m.id)).toEqual(CODEX_MODELS.map((m) => m.id));
  });
});
