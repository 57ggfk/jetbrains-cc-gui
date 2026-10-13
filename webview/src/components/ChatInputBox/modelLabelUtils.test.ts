import { describe, expect, it } from 'vitest';
import { resolveModelDisplayLabel, resolveMappedModelName } from './modelLabelUtils';

describe('Claude route and direct display names', () => {
  const t = (key: string) => key;
  it('uses configured display names for the selector and keeps the routing lookup unchanged', () => {
    const mapping = { sonnet: 'claude-sonnet-5[1M]', sonnetName: 'GLM Flash', fable: 'claude-fable-5', fableName: 'GLM Pro' };
    expect(resolveModelDisplayLabel({ id: 'claude-sonnet-5', label: 'Sonnet' }, { t, modelMapping: mapping })).toBe('GLM Flash');
    expect(resolveModelDisplayLabel({ id: 'claude-fable-5', label: 'Fable' }, { t, modelMapping: mapping })).toBe('GLM Pro');
    expect(resolveMappedModelName('sonnet', mapping)).toBe('claude-sonnet-5[1M]');
  });
  it('falls back to actual direct model ids when no display name is configured', () => {
    expect(resolveModelDisplayLabel({ id: 'claude-sonnet-5', label: 'Sonnet' }, { t, modelMapping: { sonnet: 'glm-flash' } })).toBe('glm-flash');
  });
});
