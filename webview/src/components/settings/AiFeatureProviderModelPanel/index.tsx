import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { CLAUDE_MODELS, CODEX_MODELS } from '../../ChatInputBox/types';
import type { ModelInfo } from '../../ChatInputBox/types';
import { ProviderModelIcon } from '../../shared/ProviderModelIcon';
import { usePluginModels } from '../hooks/usePluginModels';
import { STORAGE_KEYS } from '../../../types/provider';
import { applyClaudeModelMapping, readClaudeModelMapping } from '../../../utils/claudeModelMapping';
import type { AiFeatureConfig, AiFeatureProvider } from '../../../types/aiFeatureConfig';
import styles from './style.module.less';

interface AiFeatureProviderModelPanelProps {
  config: AiFeatureConfig;
  settingsKeyPrefix: string;
  providerKeyPrefix: string;
  fallbackProvider?: AiFeatureProvider;
  onProviderChange?: (provider: AiFeatureProvider) => void;
  onModelChange?: (model: string) => void;
  onResetToDefault?: () => void;
}

const AiFeatureProviderModelPanel = ({
  config,
  settingsKeyPrefix,
  providerKeyPrefix,
  fallbackProvider = 'codex',
  onProviderChange = () => {},
  onModelChange = () => {},
  onResetToDefault = () => {},
}: AiFeatureProviderModelPanelProps) => {
  const { t } = useTranslation();

  const selectedProvider = config.provider
    ?? config.effectiveProvider
    ?? fallbackProvider;
  const statusProvider = config.effectiveProvider ?? config.provider ?? fallbackProvider;

  // Model list mirrors the main chat: the user's configured custom models
  // (usePluginModels localStorage) merged with the built-ins; for Claude the
  // model-mapping labels are applied (so the user's real provider models, e.g.
  // GLM-5.x, show up). Duplicate labels (several built-in slots mapped to the
  // same real model) are collapsed.
  const claudeCustomModels = usePluginModels(STORAGE_KEYS.CLAUDE_CUSTOM_MODELS).models;
  const codexCustomModels = usePluginModels(STORAGE_KEYS.CODEX_CUSTOM_MODELS).models;
  const availableModels = useMemo<ModelInfo[]>(() => {
    const customs: ModelInfo[] = (selectedProvider === 'codex' ? codexCustomModels : claudeCustomModels)
      .map((m) => ({ id: m.id, label: m.label || m.id, description: m.description }));

    let builtIns: ModelInfo[] = selectedProvider === 'codex' ? CODEX_MODELS : CLAUDE_MODELS;
    if (selectedProvider !== 'codex') {
      try {
        const mapping = readClaudeModelMapping();
        if (Object.keys(mapping).length > 0) {
          builtIns = CLAUDE_MODELS.map((m) => applyClaudeModelMapping(m, mapping));
        }
      } catch {
        // ignore — fall back to unmapped built-ins
      }
    }

    const merged = [...customs, ...builtIns];
    const seen = new Set<string>();
    return merged.filter((m) => {
      const key = m.label.trim().toLowerCase();
      if (key && seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }, [selectedProvider, claudeCustomModels, codexCustomModels]);

  const currentModel = config.models[selectedProvider] ?? '';
  const currentModelInList = availableModels.some((m) => m.id === currentModel);
  // If the saved model isn't in the list (e.g. a custom id), still show it as an option.
  const modelOptions: ModelInfo[] = (!currentModelInList && currentModel)
    ? [{ id: currentModel, label: currentModel }, ...availableModels]
    : availableModels;

  const isAutoMode = config.provider == null;
  const statusText = config.resolutionSource === 'auto'
    ? t(`${settingsKeyPrefix}.currentProviderAuto`, {
      provider: t(`${providerKeyPrefix}.${statusProvider}`),
    })
    : config.resolutionSource === 'manual'
      ? t(`${settingsKeyPrefix}.currentProviderManual`, {
        provider: t(`${providerKeyPrefix}.${statusProvider}`),
      })
      : t(`${settingsKeyPrefix}.currentProviderUnavailable`, {
        provider: t(`${providerKeyPrefix}.${statusProvider}`),
      });

  const getProviderLabel = useCallback((provider: AiFeatureProvider) => {
    return t(`${providerKeyPrefix}.${provider}`);
  }, [t, providerKeyPrefix]);

  return (
    <div className={styles.panel}>
      <div className={styles.selectGroup}>
        <div className={styles.selectWrap}>
          <span className={styles.iconWrap} data-testid="provider-select-icon" aria-hidden="true">
            <ProviderModelIcon providerId={selectedProvider} size={14} colored />
          </span>
          <select
            className={styles.providerSelect}
            value={selectedProvider}
            onChange={(e) => onProviderChange(e.target.value as AiFeatureProvider)}
            aria-label={t(`${settingsKeyPrefix}.label`)}
          >
            {(['claude', 'codex'] as AiFeatureProvider[]).map((provider) => (
              <option key={provider} value={provider} disabled={!config.availability[provider]}>
                {getProviderLabel(provider)}{!config.availability[provider] ? ` (${t(`${settingsKeyPrefix}.providerUnavailable`)})` : ''}
              </option>
            ))}
          </select>
          <span className={`codicon codicon-chevron-down ${styles.selectArrow}`} />
        </div>

        <div className={styles.selectWrap}>
          <span className={styles.iconWrap} aria-hidden="true">
            <ProviderModelIcon providerId={selectedProvider} modelId={currentModel} size={14} colored />
          </span>
          <select
            id={`${settingsKeyPrefix}-model`}
            className={styles.modelSelect}
            value={currentModel}
            onChange={(e) => onModelChange(e.target.value)}
            aria-label={t(`${settingsKeyPrefix}.modelLabel`)}
          >
            {modelOptions.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </select>
          <span className={`codicon codicon-chevron-down ${styles.selectArrow}`} />
        </div>
      </div>

      <div className={styles.actionsRow} data-testid="ai-feature-actions-row">
        <div className={styles.statusHint} data-testid="ai-feature-status-hint">
          <span className="codicon codicon-info" />
          <span className={styles.statusText} title={statusText}>{statusText}</span>
        </div>

        <button
          type="button"
          className={styles.resetBtn}
          onClick={onResetToDefault}
          disabled={isAutoMode}
          aria-label={t(`${settingsKeyPrefix}.resetToDefault`)}
        >
          {t(`${settingsKeyPrefix}.resetToDefault`)}
        </button>
      </div>
    </div>
  );
};

export default AiFeatureProviderModelPanel;
