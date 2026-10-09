'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAdminRouter } = require('../src/adminRoutes');
const { createProviderStore } = require('../src/providerStore');
const { createDecisionStore } = require('../src/logos/decisionStore');
const { parseTokens, createAuthMiddleware } = require('../src/auth');

function startTestServer({ withDecisionStore = true, withProviderStore = false, ttsLog = null } = {}) {
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

  let fakeTtsVoices = null;
  let fakeTtsVoicesError = null;
  const listTtsVoicesFn = async () => {
    if (fakeTtsVoicesError) throw fakeTtsVoicesError;
    return fakeTtsVoices || [];
  };

  let fakeProbeResult = { ok: true, latencyMs: 12, sample: 'pong' };
  const probeChatFn = async () => fakeProbeResult;

  const providerStore = withProviderStore
    ? createProviderStore({ storePath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'provider-store-')), 'config.json') })
    : undefined;

  const app = express();
  app.use(express.json());
  app.use('/admin', createAdminRouter({ providerStore, decisionStore, auth, createOpenRouterClientFn, retrieveModelsFn, listTtsVoicesFn, probeChatFn, ttsLog }));

  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    providerStore,
    decisionStore,
    setModels: (models) => { fakeOpenRouterModels = models; },
    setError: (err) => { fakeOpenRouterError = err; },
    setProviderModels: (models) => { fakeProviderModels = models; },
    setProviderError: (err) => { fakeProviderError = err; },
    setTtsVoices: (voices) => { fakeTtsVoices = voices; },
    setTtsVoicesError: (err) => { fakeTtsVoicesError = err; },
    setProbeResult: (result) => { fakeProbeResult = result; },
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
    assert.match(body, /Logos/);
  } finally {
    await ctx.close();
  }
});

// --- retired ReasonIQ routes (V3: unified provider roles own reasoning/vision) ---

test('GET /admin/api/reasoniq/config is gone (404)', async () => {
  const ctx = startTestServer();
  try {
    const res = await fetch(`${ctx.baseUrl}/admin/api/reasoniq/config`, { headers: authHeaders() });
    assert.equal(res.status, 404);
  } finally {
    await ctx.close();
  }
});

test('PUT /admin/api/reasoniq/config is gone (404)', async () => {
  const ctx = startTestServer();
  try {
    const res = await fetch(`${ctx.baseUrl}/admin/api/reasoniq/config`, {
      method: 'PUT', headers: authHeaders(), body: JSON.stringify({ model: 'x' }),
    });
    assert.equal(res.status, 404);
  } finally {
    await ctx.close();
  }
});

test('GET /admin/api/reasoniq/models is gone (404)', async () => {
  const ctx = startTestServer();
  try {
    const res = await fetch(`${ctx.baseUrl}/admin/api/reasoniq/models`, { headers: authHeaders() });
    assert.equal(res.status, 404);
  } finally {
    await ctx.close();
  }
});

test('GET /admin/api/reasoniq/log is gone (404)', async () => {
  const ctx = startTestServer();
  try {
    const res = await fetch(`${ctx.baseUrl}/admin/api/reasoniq/log`, { headers: authHeaders() });
    assert.equal(res.status, 404);
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
    ctx.decisionStore.append({ kind: 'logos.result', reasoningDepth: 'shallow' });

    const res = await fetch(`${ctx.baseUrl}/admin/api/logos/decisions`, { headers: authHeaders() });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.decisions.length, 2);
    assert.equal(body.decisions[0].kind, 'logos.result');
  } finally {
    await ctx.close();
  }
});

test('GET /admin/api/logos/decisions supports limit and kind filters', async () => {
  const ctx = startTestServer();
  try {
    ctx.decisionStore.append({ kind: 'intentiq.decision', intent: 'a' });
    ctx.decisionStore.append({ kind: 'logos.result', reasoningDepth: 'shallow' });
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

test('PUT /admin/api/provider/role-provider saves a custom provider for an allowed role', async () => {
  const ctx = startTestServer({ withProviderStore: true });
  try {
    const res = await fetch(`${ctx.baseUrl}/admin/api/provider/role-provider`, {
      method: 'PUT', headers: authHeaders(),
      body: JSON.stringify({ role: 'kairos', useMainProvider: false, provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: 'sk-kairos' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.roleProviders.kairos.baseUrl, 'https://api.openai.com/v1');
    assert.equal(body.roleProviders.kairos.model, 'gpt-4o-mini');
    assert.equal(body.roleProviders.kairos.useMainProvider, false);
    assert.ok(!JSON.stringify(body).includes('sk-kairos'));
  } finally {
    await ctx.close();
  }
});

test('PUT /admin/api/provider/role-provider accepts reasoning and vision', async () => {
  const ctx = startTestServer({ withProviderStore: true });
  try {
    for (const role of ['reasoning', 'vision']) {
      const res = await fetch(`${ctx.baseUrl}/admin/api/provider/role-provider`, {
        method: 'PUT', headers: authHeaders(),
        body: JSON.stringify({ role, useMainProvider: false, provider: 'edenai', baseUrl: 'https://api.edenai.run/v3', model: 'm' }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.roleProviders[role].baseUrl, 'https://api.edenai.run/v3');
    }
  } finally {
    await ctx.close();
  }
});

test('PUT /admin/api/provider/role-provider rejects roles without the option', async () => {
  const ctx = startTestServer({ withProviderStore: true });
  try {
    const res = await fetch(`${ctx.baseUrl}/admin/api/provider/role-provider`, {
      method: 'PUT', headers: authHeaders(),
      body: JSON.stringify({ role: 'tts', useMainProvider: false, baseUrl: 'x' }),
    });
    assert.equal(res.status, 400);
  } finally {
    await ctx.close();
  }
});

test('POST /admin/api/provider/role-models fetches models for a custom-provider role', async () => {
  const ctx = startTestServer({ withProviderStore: true });
  try {
    ctx.setProviderModels([{ id: 'gpt-4o-mini', name: 'GPT-4o Mini' }]);
    const res = await fetch(`${ctx.baseUrl}/admin/api/provider/role-models`, {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ role: 'kairos', provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-x' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.models[0].id, 'gpt-4o-mini');
  } finally {
    await ctx.close();
  }
});

test('POST /admin/api/provider/role-models rejects roles without the option', async () => {
  const ctx = startTestServer({ withProviderStore: true });
  try {
    const res = await fetch(`${ctx.baseUrl}/admin/api/provider/role-models`, {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ role: 'tts', provider: 'openai', baseUrl: 'https://x' }),
    });
    assert.equal(res.status, 400);
  } finally {
    await ctx.close();
  }
});

// --- role connection test ---

test('POST /admin/api/provider/role-test reports when a role has no model', async () => {
  const ctx = startTestServer({ withProviderStore: true });
  try {
    const res = await fetch(`${ctx.baseUrl}/admin/api/provider/role-test`, {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ role: 'generation' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.match(body.error, /no model configured/);
  } finally {
    await ctx.close();
  }
});

test('POST /admin/api/provider/role-test rejects an unknown role', async () => {
  const ctx = startTestServer({ withProviderStore: true });
  try {
    const res = await fetch(`${ctx.baseUrl}/admin/api/provider/role-test`, {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ role: 'nonsense' }),
    });
    assert.equal(res.status, 400);
  } finally {
    await ctx.close();
  }
});

test('POST /admin/api/provider/role-test probes the resolved role and reports latency', async () => {
  const ctx = startTestServer({ withProviderStore: true });
  try {
    await fetch(`${ctx.baseUrl}/admin/api/provider/config`, {
      method: 'PUT', headers: authHeaders(),
      body: JSON.stringify({ provider: 'edenai', baseUrl: 'https://api.edenai.run/v3', apiKey: 'k' }),
    });
    await fetch(`${ctx.baseUrl}/admin/api/provider/roles`, {
      method: 'PUT', headers: authHeaders(),
      body: JSON.stringify({ role: 'generation', mode: 'catalog', model: 'm1' }),
    });
    ctx.setProbeResult({ ok: true, latencyMs: 34, sample: 'pong' });

    const res = await fetch(`${ctx.baseUrl}/admin/api/provider/role-test`, {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ role: 'generation' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.model, 'm1');
    assert.equal(body.provider, 'edenai');
    assert.equal(body.latencyMs, 34);
  } finally {
    await ctx.close();
  }
});

test('POST /admin/api/provider/role-test surfaces a probe failure', async () => {
  const ctx = startTestServer({ withProviderStore: true });
  try {
    await fetch(`${ctx.baseUrl}/admin/api/provider/config`, {
      method: 'PUT', headers: authHeaders(),
      body: JSON.stringify({ provider: 'edenai', baseUrl: 'https://api.edenai.run/v3', apiKey: 'k' }),
    });
    await fetch(`${ctx.baseUrl}/admin/api/provider/roles`, {
      method: 'PUT', headers: authHeaders(),
      body: JSON.stringify({ role: 'reasoning', mode: 'catalog', model: 'm1' }),
    });
    ctx.setProbeResult({ ok: false, latencyMs: 5, status: 401, error: 'HTTP 401 — bad key' });

    const res = await fetch(`${ctx.baseUrl}/admin/api/provider/role-test`, {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ role: 'reasoning' }),
    });
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.match(body.error, /401/);
  } finally {
    await ctx.close();
  }
});

test('GET /admin/api/provider/config exposes the resolved per-role config', async () => {
  const ctx = startTestServer({ withProviderStore: true });
  try {
    await fetch(`${ctx.baseUrl}/admin/api/provider/config`, {
      method: 'PUT', headers: authHeaders(),
      body: JSON.stringify({ provider: 'edenai', baseUrl: 'https://api.edenai.run/v3', apiKey: 'k' }),
    });
    await fetch(`${ctx.baseUrl}/admin/api/provider/roles`, {
      method: 'PUT', headers: authHeaders(),
      body: JSON.stringify({ role: 'generation', mode: 'catalog', model: 'm1' }),
    });
    await fetch(`${ctx.baseUrl}/admin/api/provider/role-provider`, {
      method: 'PUT', headers: authHeaders(),
      body: JSON.stringify({ role: 'reasoning', useMainProvider: false, provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'r1' }),
    });

    const res = await fetch(`${ctx.baseUrl}/admin/api/provider/config`, { headers: authHeaders() });
    const body = await res.json();
    assert.equal(body.resolved.generation.model, 'm1');
    assert.equal(body.resolved.generation.provider, 'edenai');
    assert.equal(body.resolved.reasoning.model, 'r1');
    assert.equal(body.resolved.reasoning.provider, 'openai');
    assert.equal(body.resolved.vision, null);
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
    assert.equal(body.kairos, false);
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
    assert.equal(body.kairos, false);
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

test('PUT /admin/api/tts/config saves a Mistral voiceId alongside the model', async () => {
  const ctx = startTestServer({ withProviderStore: true });
  try {
    const res = await fetch(`${ctx.baseUrl}/admin/api/tts/config`, {
      method: 'PUT', headers: authHeaders(),
      body: JSON.stringify({ provider: 'mistral', baseUrl: 'https://api.mistral.ai/v1', apiKey: 'mistral-key', model: 'voxtral-mini-tts-2603', voiceId: 'gaia-voice-1' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.provider, 'mistral');
    assert.equal(body.model, 'voxtral-mini-tts-2603');
    assert.equal(body.voiceId, 'gaia-voice-1');
    // Verify persisted — voiceId is not a secret, it round-trips in the clear
    assert.equal(ctx.providerStore.getConfig().tts.voiceId, 'gaia-voice-1');
  } finally {
    await ctx.close();
  }
});

test('GET /admin/api/tts/voices returns the saved voices for a Mistral TTS provider', async () => {
  const ctx = startTestServer({ withProviderStore: true });
  try {
    await fetch(`${ctx.baseUrl}/admin/api/tts/config`, {
      method: 'PUT', headers: authHeaders(),
      body: JSON.stringify({ provider: 'mistral', baseUrl: 'https://api.mistral.ai/v1', apiKey: 'mistral-key', model: 'voxtral-mini-tts-2603' }),
    });
    ctx.setTtsVoices([{ id: 'voice-1', name: 'Gaia Warm' }, { id: 'voice-2', name: 'voice-2' }]);
    const res = await fetch(`${ctx.baseUrl}/admin/api/tts/voices`, { headers: authHeaders() });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.voices, [{ id: 'voice-1', name: 'Gaia Warm' }, { id: 'voice-2', name: 'voice-2' }]);
  } finally {
    await ctx.close();
  }
});

test('GET /admin/api/tts/voices requires a TTS provider first', async () => {
  const ctx = startTestServer({ withProviderStore: true });
  try {
    const res = await fetch(`${ctx.baseUrl}/admin/api/tts/voices`, { headers: authHeaders() });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /configure a TTS provider/);
  } finally {
    await ctx.close();
  }
});

test('GET /admin/api/tts/voices refuses non-Mistral providers — MiMo has no voice library', async () => {
  const ctx = startTestServer({ withProviderStore: true });
  try {
    await fetch(`${ctx.baseUrl}/admin/api/tts/config`, {
      method: 'PUT', headers: authHeaders(),
      body: JSON.stringify({ provider: 'xiaomi', baseUrl: 'https://api.xiaomimimo.com/v1', model: 'mimo-tts' }),
    });
    const res = await fetch(`${ctx.baseUrl}/admin/api/tts/voices`, { headers: authHeaders() });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /only available for Mistral/);
  } finally {
    await ctx.close();
  }
});

test('GET /admin/api/tts/voices maps a 401 to bad-key wording, other failures to a calm 502', async () => {
  const ctx = startTestServer({ withProviderStore: true });
  try {
    await fetch(`${ctx.baseUrl}/admin/api/tts/config`, {
      method: 'PUT', headers: authHeaders(),
      body: JSON.stringify({ provider: 'mistral', baseUrl: 'https://api.mistral.ai/v1', apiKey: 'wrong-key', model: 'voxtral-mini-tts-2603' }),
    });
    const authError = new Error('voice listing responded with an error');
    authError.status = 401;
    ctx.setTtsVoicesError(authError);
    const res401 = await fetch(`${ctx.baseUrl}/admin/api/tts/voices`, { headers: authHeaders() });
    assert.equal(res401.status, 401);
    assert.match((await res401.json()).error, /check your TTS API key/);

    ctx.setTtsVoicesError(new Error('socket hangup'));
    const res502 = await fetch(`${ctx.baseUrl}/admin/api/tts/voices`, { headers: authHeaders() });
    assert.equal(res502.status, 502);
    assert.match((await res502.json()).error, /could not retrieve voices/);
  } finally {
    await ctx.close();
  }
});

test('GET /admin/api/tts/log returns an empty tail when constructed without a log', async () => {
  const ctx = startTestServer({ withProviderStore: true });
  try {
    const res = await fetch(`${ctx.baseUrl}/admin/api/tts/log`, { headers: authHeaders() });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).entries, []);
  } finally {
    await ctx.close();
  }
});

test('GET /admin/api/tts/log returns recorded attempts, newest first', async () => {
  const { createTtsLog } = require('../src/speech/ttsLog');
  const ttsLog = createTtsLog();
  ttsLog.record({ provider: 'mistral', model: 'voxtral-mini-tts-2603', outcome: 'ok', status: 200 });
  ttsLog.record({ provider: 'mistral', model: 'voxtral-mini-tts-2603', outcome: 'error', status: 502 });
  const ctx = startTestServer({ withProviderStore: true, ttsLog });
  try {
    const res = await fetch(`${ctx.baseUrl}/admin/api/tts/log`, { headers: authHeaders() });
    assert.equal(res.status, 200);
    const entries = (await res.json()).entries;
    assert.equal(entries.length, 2);
    assert.equal(entries[0].outcome, 'error');
    assert.equal(entries[1].outcome, 'ok');
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

// --- Backup generation provider (v3.0 failover) ---

test('GET /admin/api/provider/backup/config requires auth', async () => {
  const ctx = startTestServer({ withProviderStore: true });
  try {
    const res = await fetch(`${ctx.baseUrl}/admin/api/provider/backup/config`);
    assert.equal(res.status, 401);
  } finally {
    await ctx.close();
  }
});

test('GET /admin/api/provider/backup/config returns empty defaults before anything is saved', async () => {
  const ctx = startTestServer({ withProviderStore: true });
  try {
    const res = await fetch(`${ctx.baseUrl}/admin/api/provider/backup/config`, { headers: authHeaders() });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.provider, '');
    assert.equal(body.baseUrl, '');
    assert.equal(body.model, '');
    assert.equal(body.hasApiKey, false);
    assert.equal(body.maskedApiKey, null);
  } finally {
    await ctx.close();
  }
});

test('PUT /admin/api/provider/backup/config saves backup provider, response never contains raw key', async () => {
  const ctx = startTestServer({ withProviderStore: true });
  try {
    const res = await fetch(`${ctx.baseUrl}/admin/api/provider/backup/config`, {
      method: 'PUT', headers: authHeaders(),
      body: JSON.stringify({ provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'backup-model', apiKey: 'sk-backup-super-secret' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.provider, 'openrouter');
    assert.equal(body.model, 'backup-model');
    assert.equal(body.hasApiKey, true);
    assert.ok(!JSON.stringify(body).includes('sk-backup-super-secret'));
    assert.equal(ctx.providerStore.getConfig().generationBackup.apiKey, 'sk-backup-super-secret');
  } finally {
    await ctx.close();
  }
});

test('PUT /admin/api/provider/backup/config with an empty apiKey keeps the previously saved key', async () => {
  const ctx = startTestServer({ withProviderStore: true });
  try {
    await fetch(`${ctx.baseUrl}/admin/api/provider/backup/config`, {
      method: 'PUT', headers: authHeaders(),
      body: JSON.stringify({ provider: 'openrouter', model: 'm1', apiKey: 'sk-backup-key' }),
    });
    const res = await fetch(`${ctx.baseUrl}/admin/api/provider/backup/config`, {
      method: 'PUT', headers: authHeaders(),
      body: JSON.stringify({ model: 'm2', apiKey: '' }),
    });
    const body = await res.json();
    assert.equal(body.model, 'm2');
    assert.equal(body.hasApiKey, true);
    assert.equal(ctx.providerStore.getConfig().generationBackup.apiKey, 'sk-backup-key');
  } finally {
    await ctx.close();
  }
});

test('PUT /admin/api/provider/backup/config rejects an empty body', async () => {
  const ctx = startTestServer({ withProviderStore: true });
  try {
    const res = await fetch(`${ctx.baseUrl}/admin/api/provider/backup/config`, {
      method: 'PUT', headers: authHeaders(), body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  } finally {
    await ctx.close();
  }
});
