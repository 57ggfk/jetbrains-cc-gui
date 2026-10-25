import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TokenIndicator } from './TokenIndicator';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { percentage?: string }) => options?.percentage ?? key,
  }),
}));

describe('TokenIndicator', () => {
  it('clamps labels and ring geometry above 100 percent', () => {
    const { container } = render(<TokenIndicator percentage={145} usedTokens={2900} maxTokens={2000} />);

    expect(screen.getByText('100%')).toBeTruthy();
    const progressCircle = container.querySelector('.token-indicator-fill');
    expect(progressCircle?.getAttribute('stroke-dashoffset')).toBe('0');
    expect(screen.getByText(/2.9k \/ 2k/)).toBeTruthy();
  });

  it('formats million-token capacities with an M unit', () => {
    render(<TokenIndicator percentage={3} usedTokens={37600} maxTokens={1000000} />);

    expect(screen.getByText(/37.6k \/ 1M/)).toBeTruthy();
  });
});
