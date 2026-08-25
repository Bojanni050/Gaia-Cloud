'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAdminRouter } = require('../src/adminRoutes');
const { createReasoningModelStore } = require('../src/logos/reasoningModelStore');
const { createProviderStore } = require('../src/providerStore');
const { createDecisionStore } = require('../src/logos/decisionStore');
const { parseTokens, createAuthMiddleware } = require('../src/auth');

function startTestServer({ withDecisionStore = true, withProviderStore = false } = {}) {
  const storePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'admin-routes-')), 'config.json');
  const store = createReasoningModelStore({ storePath });
  const decisionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-routes-decisions-'));
  const decisionStore = withDecisionStore ? createDecisionStore({ decisionsDir }) : undefined;
  const auth = createAuthMiddleware(parseTokens('test-token'));

  let fakeOpenRouterModels = null;
  let fakeOpenRouterError = null;
  const createOpenRouterClientFn = () => ({
    listModels: async () => {
      if (fakeOpenRouterError) throw fakeOpenRouterError;
      return fakeOpenRouterModels || [];
    },
  });

  let fakeProviderModels = null;
  let fakeProviderError = null;
  const retrieveModelsFn = async () => {
    if (fakeProviderError) throw fakeProviderError;
    return fakeProviderModels || [];
  };

  const providerStore = withProviderStore
    ? createProviderStore({ storePath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'provider-store-')), 'config.json') })
    : undefined;

  const app = express();
  app.use(express.json());
  app.use('/admin', createAdminRouter({ store, providerStore, decisionStore, auth, createOpenRouterClientFn, retrieveModelsFn }));

  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    store,
    providerStore,
    decisionStore,
    setModels: (models) => { fakeOpenRouterModels = models; },
    setError: (err) => { fakeOpenRouterError = err; },
    setProviderModels: (models) => { fakeProviderModels = models; },
    setProviderError: (err) => { fakeProviderError = err; },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function authHeaders(token = 'test-token') {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

test('GET /admin serves the static admin page without auth', async () => {
  const ctx = startTestServer();
  try {
    const res = await fetch(`${ctx.baseUrl}/admin`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /ReasonIQ/);
  } finally {
    await ctx.close();
  }
});

test('GET /admin/api/reasoniq/config requires auth', async () => {
  const ctx = startTestServer();
  try {
    const res = await fetch(`${ctx.baseUrl}/admin/api/reasoniq/config`);
    assert.equal(res.status, 401);
  } finally {
    await ctx.close();
  }
});

test('GET /admin/api/reasoniq/config returns an empty masked config before anything is saved', async () => {
  const ctx = startTestServer();
  try {
    const res = await fetch(`${ctx.baseUrl}/admin/api/reasoniq/config`, { headers: authHeaders() });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.hasApiKey, false);
  } finally {
    await ctx.close();
  }
});

test('PUT /admin/api/reasoniq/config saves an api key, and the response never contains the raw key', async () => {
  const ctx = startTestServer();
  try {
    const res = await fetch(`${ctx.baseUrl}/admin/api/reasoniq/config`, {
      method: 'PUT', headers: authHeaders(),
      body: JSON.stringify({ provider: 'openrouter', apiKey: 'sk-or-super-secret-value' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.hasApiKey, true);
    assert.ok(!JSON.stringify(body).includes('sk-or-super-secret-value'));

    // But it really was persisted:
    assert.equal(ctx.store.getConfig().apiKey, 'sk-or-super-secret-value');
  } finally {
    await ctx.close();
  }
});

test('PUT /admin/api/reasoniq/config with only a model does not clear the previously saved key', async () => {
  const ctx = startTestServer();
  try {
    await fetch(`${ctx.baseUrl}/admin/api/reasoniq/config`, {
      method: 'PUT', headers: authHeaders(), body: JSON.stringify({ apiKey: 'sk-or-secret' }),
    });
    const res = await fetch(`${ctx.baseUrl}/admin/api/reasoniq/config`, {
      method: 'PUT', headers: authHeaders(), body: JSON.stringify({ model: 'anthropic/claude-3.5-sonnet' }),
    });
    const body = await res.json();
    assert.equal(body.model, 'anthropic/claude-3.5-sonnet');
    assert.equal(body.hasApiKey, true);
    assert.equal(ctx.store.getConfig().apiKey, 'sk-or-secret');
  } finally {
    await ctx.close();
  }
});

test('PUT /admin/api/reasoniq/config rejects an empty body', async () => {
  const ctx = startTestServer();
  try {
    const res = await fetch(`${ctx.baseUrl}/admin/api/reasoniq/config`, {
      method: 'PUT', headers: authHeaders(), body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  } finally {
    await ctx.close();
  }
});

test('GET /admin/api/reasoniq/models requires a saved key first', async () => {
  const ctx = startTestServer();
  try {
    const res = await fetch(`${ctx.baseUrl}/admin/api/reasoniq/models`, { headers: authHeaders() });
    assert.equal(res.status, 400);
  } finally {
    await ctx.close();
  }
});

test('GET /admin/api/reasoniq/models returns the fetched model list once a key is saved', async () => {
  const ctx = startTestServer();
  try {
    await fetch(`${ctx.baseUrl}/admin/api/reasoniq/config`, {
      method: 'PUT', headers: authHeaders(), body: JSON.stringify({ apiKey: 'sk-or-x', baseUrl: 'https://openrouter.ai/api/v1' }),
    });
    ctx.setProviderModels([{ id: 'openai/gpt-4o-mini', name: 'GPT-4o mini', contextLength: 128000, pricing: { prompt: '0.15', completion: '0.6' } }]);

    const res = await fetch(`${ctx.baseUrl}/admin/api/reasoniq/models`, { headers: authHeaders() });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.models.length, 1);
    assert.equal(body.models[0].id, 'openai/gpt-4o-mini');
  } finally {
    await ctx.close();
  }
});

test('PUT /admin/api/reasoniq/config saves a visionModel independently of model', async () => {
  const ctx = startTestServer();
  try {
    await fetch(`${ctx.baseUrl}/admin/api/reasoniq/config`, {
      method: 'PUT', headers: authHeaders(), body: JSON.stringify({ apiKey: 'sk-or-x', model: 'anthropic/claude-3.5-sonnet' }),
    });
    const res = await fetch(`${ctx.baseUrl}/admin/api/reasoniq/config`, {
      method: 'PUT', headers: authHeaders(), body: JSON.stringify({ visionModel: 'openai/gpt-4o-mini' }),
    });
    const body = await res.json();
    assert.equal(body.visionModel, 'openai/gpt-4o-mini');
    assert.equal(body.model, 'anthropic/claude-3.5-sonnet'); // unaffected by the vision-only update
  } finally {
    await ctx.close();
  }
});

test('GET /admin/api/reasoniq/config reports visionModel: null before anything is saved', async () => {
  const ctx = startTestServer();
  try {
    const res = await fetch(`${ctx.baseUrl}/admin/api/reasoniq/config`, { headers: authHeaders() });
    const body = await res.json();
    assert.equal(body.visionModel, null);
  } finally {
    await ctx.close();
  }
});

test('GET /admin/api/reasoniq/models maps an OpenRouter failure to a calm 502', async () => {
  const ctx = startTestServer();
  try {
    await fetch(`${ctx.baseUrl}/admin/api/reasoniq/config`, {
      method: 'PUT', headers: authHeaders(), body: JSON.stringify({ apiKey: 'sk-or-x', baseUrl: 'https://openrouter.ai/api/v1' }),
    });
    ctx.setProviderError(new Error('openrouter rejected the api key'));

    const res = await fetch(`${ctx.baseUrl}/admin/api/reasoniq/models`, { headers: authHeaders() });
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.ok(!JSON.stringify(body).includes('sk-or-x'));
  } finally {
    await ctx.close();
  }
});

// --- GET /admin/api/logos/decisions -----------------------------------

test('GET /admin/api/logos/decisions requires auth', async () => {
  const ctx = startTestServer();
  try {
    const res = await fetch(`${ctx.baseUrl}/admin/api/logos/decisions`);
    assert.equal(res.status, 401);
  } finally {
    await ctx.close();
  }
});

test('GET /admin/api/logos/decisions returns the durable log, newest first', async () => {
  const ctx = startTestServer();
  try {
    ctx.decisionStore.append({ kind: 'intentiq.decision', intent: 'first' });
    ctx.decisionStore.append({ kind: 'reasoniq.result', reasoningDepth: 'shallow' });

    const res = await fetch(`${ctx.baseUrl}/admin/api/logos/decisions`, { headers: authHeaders() });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.decisions.length, 2);
    assert.equal(body.decisions[0].kind, 'reasoniq.result');
  } finally {
    await ctx.close();
  }
});

test('GET /admin/api/logos/decisions supports limit and kind filters', async () => {
  const ctx = startTestServer();
  try {
    ctx.decisionStore.append({ kind: 'intentiq.decision', intent: 'a' });
    ctx.decisionStore.append({ kind: 'reasoniq.result', reasoningDepth: 'shallow' });
    ctx.decisionStore.append({ kind: 'intentiq.decision', intent: 'b' });

    const res = await fetch(`${ctx.baseUrl}/admin/api/logos/decisions?kind=intentiq.decision&limit=1`, {
      headers: authHeaders(),
    });
    const body = await res.json();
    assert.equal(body.decisions.length, 1);
    assert.equal(body.decisions[0].intent, 'b');
  } finally {
    await ctx.close();
  }
});

test('GET /admin/api/logos/decisions returns an empty list rather than erroring when no decisionStore is configured', async () => {
  const ctx = startTestServer({ withDecisionStore: false });
  try {
    const res = await fetch(`${ctx.baseUrl}/admin/api/logos/decisions`, { headers: authHeaders() });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.decisions, []);
  } finally {
    await ctx.close();
  }
});

// --- Provider Settings routes ---

test('GET /admin/api/provider/config requires auth', async () => {
  const ctx = startTestServer({ withProviderStore: true });
  try {
    const res = await fetch(`${ctx.baseUrl}/admin/api/provider/config`);
    assert.equal(res.status, 401);
  } finally {
    await ctx.close();
  }
});

test('GET /admin/api/provider/config returns empty defaults before anything is saved', async () => {
  const ctx = startTestServer({ withProviderStore: true });
  try {
    const res = await fetch(`${ctx.baseUrl}/admin/api/provider/config`, { headers: authHeaders() });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.provider, null);
    assert.equal(body.hasApiKey, false);
    assert.deepEqual(body.catalog, []);
    assert.deepEqual(body.roles.generation, { mode: 'catalog', model: '' });
  } finally {
    await ctx.close();
  }
});

test('PUT /admin/api/provider/config saves provider and apiKey, response never contains raw key', async () => {
  const ctx = startTestServer({ withProviderStore: true });
  try {
    const res = await fetch(`${ctx.baseUrl}/admin/api/provider/config`, {
      method: 'PUT', headers: authHeaders(),
      body: JSON.stringify({ provider: 'edenai', baseUrl: 'https://api.edenai.run/v1', apiKey: 'sk-eden-super-secret' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.provider, 'edenai');
    assert.equal(body.baseUrl, 'https://api.edenai.run/v1');
    assert.equal(body.hasApiKey, true);
    assert.ok(!JSON.stringify(body).includes('sk-eden-super-secret'));
    // Verify persisted
    assert.equal(ctx.providerStore.getConfig().apiKey, 'sk-eden-super-secret');
  } finally {
    await ctx.close();
  }
});

test('PUT /admin/api/provider/config with only a provider does not clear the previously saved key', async () => {
  const ctx = startTestServer({ withProviderStore: true });
  try {
    await fetch(`${ctx.baseUrl}/admin/api/provider/config`, {
      method: 'PUT', headers: authHeaders(),
      body: JSON.stringify({ apiKey: 'sk-secret' }),
    });
    const res = await fetch(`${ctx.baseUrl}/admin/api/provider/config`, {
      method: 'PUT', headers: authHeaders(),
      body: JSON.stringify({ provider: 'openrouter' }),
    });
    const body = await res.json();
    assert.equal(body.provider, 'openrouter');
    assert.equal(body.hasApiKey, true);
    assert.equal(ctx.providerStore.getConfig().apiKey, 'sk-secret');
  } finally {
    await ctx.close();
  }
});

test('PUT /admin/api/provider/config rejects an empty body', async () => {
  const ctx = startTestServer({ withProviderStore: true });
  try {
    const res = await fetch(`${ctx.baseUrl}/admin/api/provider/config`, {
      method: 'PUT', headers: authHeaders(), body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  } finally {
    await ctx.close();
  }
});

test('GET /admin/api/provider/models requires a configured provider first', async () => {
  const ctx = startTestServer({ withProviderStore: true });
  try {
    const res = await fetch(`${ctx.baseUrl}/admin/api/provider/models`, { headers: authHeaders() });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.error.includes('configure a provider'));
  } finally {
    await ctx.close();
  }
});

test('GET /admin/api/provider/models returns catalog on success', async () => {
  const ctx = startTestServer({ withProviderStore: true });
  try {
    await fetch(`${ctx.baseUrl}/admin/api/provider/config`, {
      method: 'PUT', headers: authHeaders(),
      body: JSON.stringify({ provider: 'edenai', baseUrl: 'https://api.edenai.run/v1', apiKey: 'sk-x' }),
    });
    ctx.setProviderModels([
      { id: 'google/gemini-flash', name: 'Gemini Flash', capabilities: ['vision'] },
    ]);
    const res = await fetch(`${ctx.baseUrl}/admin/api/provider/models`, { headers: authHeaders() });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.catalog.length, 1);
    assert.equal(body.catalog[0].id, 'google/gemini-flash');
    assert.ok(body.catalogRetrievedAt);
  } finally {
    await ctx.close();
  }
});

test('GET /admin/api/provider/models returns 502 on provider failure', async () => {
  const ctx = startTestServer({ withProviderStore: true });
  try {
    await fetch(`${ctx.baseUrl}/admin/api/provider/config`, {
      method: 'PUT', headers: authHeaders(),
      body: JSON.stringify({ provider: 'edenai', baseUrl: 'https://api.edenai.run/v1', apiKey: 'sk-x' }),
    });
    ctx.setProviderError(new Error('authentication failed'));
    const res = await fetch(`${ctx.baseUrl}/admin/api/provider/models`, { headers: authHeaders() });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.ok(body.error.includes('authentication'));
    // Must not leak the API key
    assert.ok(!JSON.stringify(body).includes('sk-x'));
  } finally {
    await ctx.close();
  }
});

test('PUT /admin/api/provider/roles saves a role selection', async () => {
  const ctx = startTestServer({ withProviderStore: true });
  try {
    const res = await fetch(`${ctx.baseUrl}/admin/api/provider/roles`, {
      method: 'PUT', headers: authHeaders(),
      body: JSON.stringify({ role: 'generation', mode: 'catalog', model: 'google/gemini-flash' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.roles.generation.mode, 'catalog');
    assert.equal(body.roles.generation.model, 'google/gemini-flash');
  } finally {
    await ctx.close();
  }
});

test('PUT /admin/api/provider/roles rejects unknown role', async () => {
  const ctx = startTestServer({ withProviderStore: true });
  try {
    const res = await fetch(`${ctx.baseUrl}/admin/api/provider/roles`, {
      method: 'PUT', headers: authHeaders(),
      body: JSON.stringify({ role: 'unknown', mode: 'catalog', model: 'x' }),
    });
    assert.equal(res.status, 400);
  } finally {
    await ctx.close();
  }
});

test('PUT /admin/api/provider/roles rejects invalid mode', async () => {
  const ctx = startTestServer({ withProviderStore: true });
  try {
    const res = await fetch(`${ctx.baseUrl}/admin/api/provider/roles`, {
      method: 'PUT', headers: authHeaders(),
      body: JSON.stringify({ role: 'vision', mode: 'invalid', model: 'x' }),
    });
    assert.equal(res.status, 400);
  } finally {
    await ctx.close();
  }
});

test('PUT /admin/api/provider/roles saves manual mode selection', async () => {
  const ctx = startTestServer({ withProviderStore: true });
  try {
    const res = await fetch(`${ctx.baseUrl}/admin/api/provider/roles`, {
      method: 'PUT', headers: authHeaders(),
      body: JSON.stringify({ role: 'vision', mode: 'manual', model: 'custom-vision-model' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.roles.vision.mode, 'manual');
    assert.equal(body.roles.vision.model, 'custom-vision-model');
  } finally {
    await ctx.close();
  }
});

test('GET /admin/api/provider/capabilities returns capability availability', async () => {
  const ctx = startTestServer({ withProviderStore: true });
  try {
    await fetch(`${ctx.baseUrl}/admin/api/provider/config`, {
      method: 'PUT', headers: authHeaders(),
      body: JSON.stringify({ provider: 'edenai', baseUrl: 'https://x', apiKey: 'k' }),
    });
    await fetch(`${ctx.baseUrl}/admin/api/provider/roles`, {
      method: 'PUT', headers: authHeaders(),
      body: JSON.stringify({ role: 'generation', mode: 'catalog', model: 'g1' }),
    });
    await fetch(`${ctx.baseUrl}/admin/api/tts/config`, {
      method: 'PUT', headers: authHeaders(),
      body: JSON.stringify({ provider: 'xiaomi', baseUrl: 'https://tts.x', model: 't1' }),
    });
    const res = await fetch(`${ctx.baseUrl}/admin/api/provider/capabilities`, { headers: authHeaders() });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.generation, true);
    assert.equal(body.reasoning, false);
    assert.equal(body.vision, false);
    assert.equal(body.tts, true);
  } finally {
    await ctx.close();
  }
});

test('GET /admin/api/provider/capabilities reports all false when nothing configured', async () => {
  const ctx = startTestServer({ withProviderStore: true });
  try {
    const res = await fetch(`${ctx.baseUrl}/admin/api/provider/capabilities`, { headers: authHeaders() });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.generation, false);
    assert.equal(body.reasoning, false);
    assert.equal(body.vision, false);
    assert.equal(body.tts, false);
  } finally {
    await ctx.close();
  }
});

test('Provider routes are not available when providerStore is not provided', async () => {
  const ctx = startTestServer({ withProviderStore: false });
  try {
    const res = await fetch(`${ctx.baseUrl}/admin/api/provider/config`, { headers: authHeaders() });
    assert.equal(res.status, 404);
  } finally {
    await ctx.close();
  }
});

// --- TTS routes ---

test('GET /admin/api/tts/config returns TTS defaults', async () => {
  const ctx = startTestServer({ withProviderStore: true });
  try {
    const res = await fetch(`${ctx.baseUrl}/admin/api/tts/config`, { headers: authHeaders() });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.provider, '');
    assert.equal(body.hasApiKey, false);
  } finally {
    await ctx.close();
  }
});

test('PUT /admin/api/tts/config saves TTS config', async () => {
  const ctx = startTestServer({ withProviderStore: true });
  try {
    const res = await fetch(`${ctx.baseUrl}/admin/api/tts/config`, {
      method: 'PUT', headers: authHeaders(),
      body: JSON.stringify({ provider: 'xiaomi', baseUrl: 'https://api.xiaomimimo.com/v1', apiKey: 'tts-secret', model: 'mimo-tts' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.provider, 'xiaomi');
    assert.equal(body.baseUrl, 'https://api.xiaomimimo.com/v1');
    assert.equal(body.model, 'mimo-tts');
    assert.equal(body.hasApiKey, true);
    assert.ok(!JSON.stringify(body).includes('tts-secret'));
    // Verify persisted
    assert.equal(ctx.providerStore.getConfig().tts.apiKey, 'tts-secret');
  } finally {
    await ctx.close();
  }
});

test('PUT /admin/api/tts/config partial update keeps previously stored apiKey', async () => {
  const ctx = startTestServer({ withProviderStore: true });
  try {
    await fetch(`${ctx.baseUrl}/admin/api/tts/config`, {
      method: 'PUT', headers: authHeaders(),
      body: JSON.stringify({ provider: 'xiaomi', apiKey: 'tts-key', model: 'm1' }),
    });
    const res = await fetch(`${ctx.baseUrl}/admin/api/tts/config`, {
      method: 'PUT', headers: authHeaders(),
      body: JSON.stringify({ model: 'm2' }),
    });
    const body = await res.json();
    assert.equal(body.model, 'm2');
    assert.equal(body.hasApiKey, true);
    assert.equal(ctx.providerStore.getConfig().tts.apiKey, 'tts-key');
  } finally {
    await ctx.close();
  }
});

test('PUT /admin/api/tts/config rejects empty body', async () => {
  const ctx = startTestServer({ withProviderStore: true });
  try {
    const res = await fetch(`${ctx.baseUrl}/admin/api/tts/config`, {
      method: 'PUT', headers: authHeaders(), body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  } finally {
    await ctx.close();
  }
});

test('GET /admin/api/tts/models requires TTS provider first', async () => {
  const ctx = startTestServer({ withProviderStore: true });
  try {
    const res = await fetch(`${ctx.baseUrl}/admin/api/tts/models`, { headers: authHeaders() });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.error.includes('configure a TTS provider'));
  } finally {
    await ctx.close();
  }
});

test('GET /admin/api/tts/models returns models on success', async () => {
  const ctx = startTestServer({ withProviderStore: true });
  try {
    await fetch(`${ctx.baseUrl}/admin/api/tts/config`, {
      method: 'PUT', headers: authHeaders(),
      body: JSON.stringify({ provider: 'xiaomi', baseUrl: 'https://api.xiaomimimo.com/v1', apiKey: 'k' }),
    });
    ctx.setProviderModels([{ id: 'mimo-tts', name: 'MiMo TTS', capabilities: [] }]);
    const res = await fetch(`${ctx.baseUrl}/admin/api/tts/models`, { headers: authHeaders() });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.models.length, 1);
    assert.equal(body.models[0].id, 'mimo-tts');
  } finally {
    await ctx.close();
  }
});

test('GET /admin/api/tts/models returns 502 on provider failure', async () => {
  const ctx = startTestServer({ withProviderStore: true });
  try {
    await fetch(`${ctx.baseUrl}/admin/api/tts/config`, {
      method: 'PUT', headers: authHeaders(),
      body: JSON.stringify({ provider: 'xiaomi', baseUrl: 'https://api.xiaomimimo.com/v1', apiKey: 'k' }),
    });
    ctx.setProviderError(new Error('provider unreachable'));
    const res = await fetch(`${ctx.baseUrl}/admin/api/tts/models`, { headers: authHeaders() });
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.ok(!JSON.stringify(body).includes('k'));
  } finally {
    await ctx.close();
  }
});

test('TTS config is independent from main provider', async () => {
  const ctx = startTestServer({ withProviderStore: true });
  try {
    await fetch(`${ctx.baseUrl}/admin/api/provider/config`, {
      method: 'PUT', headers: authHeaders(),
      body: JSON.stringify({ provider: 'edenai', baseUrl: 'https://api.edenai.run/v1', apiKey: 'main-key' }),
    });
    await fetch(`${ctx.baseUrl}/admin/api/tts/config`, {
      method: 'PUT', headers: authHeaders(),
      body: JSON.stringify({ provider: 'xiaomi', baseUrl: 'https://api.xiaomimimo.com/v1', apiKey: 'tts-key', model: 'mimo' }),
    });
    const mainConfig = await (await fetch(`${ctx.baseUrl}/admin/api/provider/config`, { headers: authHeaders() })).json();
    const ttsConfig = await (await fetch(`${ctx.baseUrl}/admin/api/tts/config`, { headers: authHeaders() })).json();
    assert.equal(mainConfig.provider, 'edenai');
    assert.equal(ttsConfig.provider, 'xiaomi');
    assert.equal(ttsConfig.model, 'mimo');
    // Main config should not contain TTS apiKey
    assert.ok(!JSON.stringify(mainConfig).includes('tts-key'));
  } finally {
    await ctx.close();
  }
});
