import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectGrokAuthMethodId,
  normalizeAuthMethod,
  buildGrokEnv,
  applyGrokBaseUrlEnv,
  isBareGatewayV1Base,
} from './grok-utils.js';

test('normalizeAuthMethod aliases', () => {
  assert.equal(normalizeAuthMethod('cached_token'), 'oauth');
  assert.equal(normalizeAuthMethod('xai.api_key'), 'api_key');
  assert.equal(normalizeAuthMethod('CLI_LOGIN'), 'oauth');
  assert.equal(normalizeAuthMethod('auto'), 'auto');
});

test('oauth preferred picks cached_token even when api key present', () => {
  const id = selectGrokAuthMethodId({
    authMethods: new Set(['cached_token', 'grok.com', 'xai.api_key']),
    defaultAuth: 'xai.api_key',
    preferred: 'oauth',
    hasApiKey: true,
  });
  assert.equal(id, 'cached_token');
});

test('api_key preferred picks xai.api_key when key present', () => {
  const id = selectGrokAuthMethodId({
    authMethods: new Set(['cached_token', 'xai.api_key']),
    preferred: 'api_key',
    hasApiKey: true,
  });
  assert.equal(id, 'xai.api_key');
});

test('api_key preferred falls back to oauth when no key', () => {
  const id = selectGrokAuthMethodId({
    authMethods: new Set(['cached_token', 'xai.api_key']),
    preferred: 'api_key',
    hasApiKey: false,
  });
  assert.equal(id, 'cached_token');
});

test('auto prefers oauth over api key', () => {
  const id = selectGrokAuthMethodId({
    authMethods: new Set(['cached_token', 'xai.api_key']),
    defaultAuth: 'xai.api_key',
    preferred: 'auto',
    hasApiKey: true,
  });
  assert.equal(id, 'cached_token');
});

test('buildGrokEnv oauth strips API keys', () => {
  const env = buildGrokEnv(
    { XAI_API_KEY: 'secret', GROK_API_KEY: 'secret', PATH: '/bin' },
    'also-secret',
    '',
    'oauth'
  );
  assert.equal(env.XAI_API_KEY, undefined);
  assert.equal(env.GROK_API_KEY, undefined);
  assert.equal(env.GROK_AUTH_METHOD, 'oauth');
  assert.equal(env.PATH, '/bin');
});

test('buildGrokEnv api_key keeps provided key', () => {
  const env = buildGrokEnv({ PATH: '/bin' }, 'k123', '', 'api_key');
  assert.equal(env.XAI_API_KEY, 'k123');
  assert.equal(env.GROK_API_KEY, 'k123');
  assert.equal(env.GROK_AUTH_METHOD, 'api_key');
});

test('buildGrokEnv oauth sets chat-proxy + models base (not XAI_API_BASE_URL)', () => {
  const env = buildGrokEnv({ PATH: '/bin' }, '', 'https://gw.example.com/grok/v1', 'oauth');
  assert.equal(env.GROK_CLI_CHAT_PROXY_BASE_URL, 'https://gw.example.com/grok/v1');
  assert.equal(env.GROK_BASE_URL, 'https://gw.example.com/grok/v1');
  assert.equal(env.GROK_MODELS_BASE_URL, 'https://gw.example.com/grok/v1');
  assert.equal(env.GROK_MODELS_LIST_URL, 'https://gw.example.com/grok/v1/models');
  assert.equal(env.XAI_API_BASE_URL, undefined);
});

test('buildGrokEnv api_key sets XAI + chat-proxy + models base', () => {
  const env = buildGrokEnv({ PATH: '/bin' }, 'k', 'https://gw.example.com/xai/v1', 'api_key');
  assert.equal(env.XAI_API_BASE_URL, 'https://gw.example.com/xai/v1');
  assert.equal(env.GROK_BASE_URL, 'https://gw.example.com/xai/v1');
  assert.equal(env.GROK_CLI_CHAT_PROXY_BASE_URL, 'https://gw.example.com/xai/v1');
  assert.equal(env.GROK_MODELS_BASE_URL, 'https://gw.example.com/xai/v1');
  assert.equal(env.GROK_MODELS_LIST_URL, 'https://gw.example.com/xai/v1/models');
});

test('buildGrokEnv empty base does not override', () => {
  const env = buildGrokEnv(
    { PATH: '/bin', XAI_API_BASE_URL: 'keep-me' },
    '',
    '',
    'api_key'
  );
  assert.equal(env.XAI_API_BASE_URL, 'keep-me');
  assert.equal(env.GROK_CLI_CHAT_PROXY_BASE_URL, undefined);
  assert.equal(env.GROK_MODELS_BASE_URL, undefined);
});

test('applyGrokBaseUrlEnv auto sets chat-proxy + models + XAI', () => {
  const env = {};
  applyGrokBaseUrlEnv(env, 'auto', 'http://127.0.0.1:18789/grok/v1');
  assert.equal(env.GROK_BASE_URL, 'http://127.0.0.1:18789/grok/v1');
  assert.equal(env.XAI_API_BASE_URL, 'http://127.0.0.1:18789/grok/v1');
  assert.equal(env.GROK_CLI_CHAT_PROXY_BASE_URL, 'http://127.0.0.1:18789/grok/v1');
  assert.equal(env.GROK_MODELS_BASE_URL, 'http://127.0.0.1:18789/grok/v1');
  assert.equal(env.GROK_MODELS_LIST_URL, 'http://127.0.0.1:18789/grok/v1/models');
});

test('isBareGatewayV1Base detects lock path', () => {
  assert.equal(isBareGatewayV1Base('https://gw.example.com/v1'), true);
  assert.equal(isBareGatewayV1Base('https://gw.example.com/v1/'), true);
  assert.equal(isBareGatewayV1Base('https://gw.example.com/xai/v1'), false);
  assert.equal(isBareGatewayV1Base('https://gw.example.com/grok/v1'), false);
  assert.equal(isBareGatewayV1Base(''), false);
});
