import { useTranslation } from 'react-i18next';
import type { TokenIndicatorProps } from './types';
import { clampUsagePercentage } from '../../utils/usagePercentage';

/**
 * TokenIndicator - Usage ring progress bar component
 * Implemented using SVG dual-circle approach
 */
export const TokenIndicator = ({
  percentage,
  size = 14,
  usedTokens,
  maxTokens,
}: TokenIndicatorProps) => {
  const { t } = useTranslation();
  const safePercentage = clampUsagePercentage(percentage);
  // Circle radius (accounting for stroke space)
  const radius = (size - 3) / 2;
  const center = size / 2;

  // Circumference
  const circumference = 2 * Math.PI * radius;

  // Calculate offset (fill clockwise from top)
  const strokeOffset = circumference * (1 - safePercentage / 100);

  // Indicator label: integer percentage (no decimal)
  const labelPercentage = `${Math.round(safePercentage)}%`;
  // Tooltip: one decimal place for precision
  const tooltipPercentage = `${(Math.round(safePercentage * 10) / 10).toFixed(1)}%`;

  const formatTokens = (value?: number) => {
    if (typeof value !== 'number' || !isFinite(value)) return undefined;
    // Use the largest readable unit, matching the context usage dialog
    // e.g.: 1,000,000 -> 1M, 500,000 -> 500k
    if (value >= 1_000_000) {
      const mValue = value / 1_000_000;
      return Number.isInteger(mValue) ? `${mValue}M` : `${mValue.toFixed(1)}M`;
    }
    if (value >= 1_000) {
      const kValue = value / 1_000;
      // If it's a whole number, don't show decimal point
      return Number.isInteger(kValue) ? `${kValue}k` : `${kValue.toFixed(1)}k`;
    }
    return `${value}`;
  };

  const usedText = formatTokens(usedTokens);
  const maxText = formatTokens(maxTokens);
  const tooltip = usedText && maxText
    ? `${tooltipPercentage} · ${usedText} / ${maxText} ${' '}${t('chat.context')}`
    : t('chat.usagePercentage', { percentage: tooltipPercentage });

  return (
    <div className="token-indicator">
      <div className="token-indicator-wrap">
        <svg
          className="token-indicator-ring"
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
        >
          {/* Background circle */}
          <circle
            className="token-indicator-bg"
            cx={center}
            cy={center}
            r={radius}
          />
          {/* Progress arc */}
          <circle
            className="token-indicator-fill"
            cx={center}
            cy={center}
            r={radius}
            strokeDasharray={circumference}
            strokeDashoffset={strokeOffset}
          />
        </svg>
        {/* Hover tooltip */}
        <div className="token-tooltip">
          {tooltip}
        </div>
      </div>
      <span className="token-percentage-label">{labelPercentage}</span>
    </div>
  );
};

export default TokenIndicator;
