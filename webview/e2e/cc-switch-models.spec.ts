import { expect, test } from '@playwright/test';
import { APP_VERSION } from '../src/version/version';
import { parseClaudeModelMapping, parseClaudeModelPicker } from '../../ai-bridge/services/claude/models-service.js';

const route = 'ccs-claude-provider-a--glm-pro';
const fixtures = [
  {
    mode: 'aggregate', selectedModel: route, label: 'GLM Pro (Provider A)',
    settings: {
      model: `${route}[1m]`,
      modelPicker: { replaceBuiltInOptions: true, options: [
        { model: `${route}[1m]`, label: 'GLM Pro (Provider A)', description: 'glm-pro · 1M' },
        { model: 'ccs-claude-provider-b--glm-flash', label: 'GLM Flash (Provider B)' },
      ] },
    },
  },
  {
    mode: 'route', selectedModel: 'claude-sonnet-5', label: 'GLM Flash Route',
    settings: { env: {
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-flash',
      ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'GLM Flash Route',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-pro',
      ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'GLM Pro Route',
    } },
  },
  {
    mode: 'direct', selectedModel: 'claude-sonnet-5', label: 'GLM Flash Direct',
    settings: { env: {
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-flash',
      ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'GLM Flash Direct',
    } },
  },
];

for (const fixture of fixtures) {
  test(`${fixture.mode}: reads configured names and sends xhigh/max`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const catalog = {
      provider: 'claude', success: true,
      ...parseClaudeModelPicker(fixture.settings),
      modelMapping: parseClaudeModelMapping(fixture.settings),
    };
    await page.addInitScript(({ appVersion, selectedModel, catalog }) => {
      localStorage.setItem('language', 'en');
      localStorage.setItem('lastSeenChangelogVersion', appVersion);
      localStorage.setItem('model-selection-state', JSON.stringify({
        provider: 'claude', claudeModel: selectedModel,
        claudePermissionMode: 'bypassPermissions', reasoningEffort: 'high', longContextEnabled: false,
      }));
      const bridge = window as unknown as Record<string, any>;
      bridge.__ccSwitchSends = [];
      bridge.sendToJava = (message: string) => {
        const respond = (callback: string, payload: unknown) => setTimeout(() =>
          bridge[callback]?.(JSON.stringify(payload)), 0);
        if (message.startsWith('get_cli_models:claude')) respond('setCliModels', catalog);
        if (message.startsWith('set_model:')) bridge.__ccSwitchModel = message.slice('set_model:'.length);
        if (message.startsWith('get_dependency_status:')) respond('updateDependencyStatus', {
          'claude-sdk': { status: 'installed', meetsMinimumVersion: true },
        });
        if (message.startsWith('send_message:')) {
          bridge.__ccSwitchSends.push(JSON.parse(message.slice('send_message:'.length)));
          setTimeout(() => bridge.updateLoadingStatus?.(false), 0);
        }
      };
    }, { appVersion: APP_VERSION, selectedModel: fixture.selectedModel, catalog });
    await page.goto('/');
    await expect(page.locator('.input-editable')).toBeVisible();
    await expect(page.locator('.sdk-warning-bar')).toHaveCount(0);
    await page.addStyleTag({ content: '#__vconsole { display: none !important; }' });
    const trigger = page.getByTestId('model-config-trigger');
    await expect(trigger).toContainText(fixture.label);
    await trigger.click();
    if (fixture.mode === 'aggregate') {
      await expect(page.getByTestId(`model-option-${route}`)).toContainText(fixture.label);
      await expect(page.getByTestId('model-option-claude-sonnet-5')).toHaveCount(0);
    } else {
      await expect(page.getByTestId('model-option-claude-sonnet-5')).toContainText(fixture.label);
    }
    await page.screenshot({ path: testInfo.outputPath(`${fixture.mode}-models.png`), animations: 'disabled' });
    await page.getByTestId('model-config-option-effort').click();
    const dropdown = page.getByTestId('reasoning-selector-dropdown');
    await expect(dropdown.locator('.selector-option')).toHaveCount(5);
    await expect(dropdown.getByText('XHigh', { exact: true })).toBeVisible();
    await expect(dropdown.getByText('Max', { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`${fixture.mode}-effort.png`), animations: 'disabled' });
    await dropdown.getByText('XHigh', { exact: true }).click();
    await expect(trigger).toContainText('XHigh');
    await page.locator('.input-editable').fill('Local xhigh verification');
    await page.locator('.input-editable').press('Enter');
    await expect.poll(() => page.evaluate(() =>
      (window as any).__ccSwitchSends.at(-1)?.reasoningEffort)).toBe('xhigh');
    await page.reload();
    await expect(trigger).toContainText(fixture.label);
    await trigger.click();
    await page.getByTestId('model-config-option-effort').click();
    await dropdown.getByText('Max', { exact: true }).click();
    await expect(trigger).toContainText('Max');
    await page.locator('.input-editable').fill('Local max verification');
    await page.locator('.input-editable').press('Enter');
    await expect.poll(() => page.evaluate(() =>
      (window as any).__ccSwitchSends.at(-1)?.reasoningEffort)).toBe('max');
    await expect.poll(() => page.evaluate(() =>
      (window as any).__ccSwitchModel)).toBe(fixture.selectedModel);
    expect(errors).toEqual([]);
  });
}
