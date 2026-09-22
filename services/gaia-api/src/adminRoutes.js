'use strict';

/**
 * Admin surface for configuring ReasonIQ's reasoning model and the unified
 * model provider at runtime. Deliberately separate from Gaia Desktop's
 * Settings panel — this is operator/admin tooling for Gaia Cloud itself,
 * gated behind the same bearer token as every other authenticated route.
 *
 * The API key never round-trips back to any client once saved.
 *
 * Routes (all mounted under /admin, all except the static page require
 * the standard Bearer auth):
 *   GET  /admin                       -> the static admin page
 *
 *   ReasonIQ:
 *   GET  /admin/api/reasoniq/config   -> masked current config
 *   PUT  /admin/api/reasoniq/config   -> { provider?, baseUrl?, model?, visionModel?, apiKey? }
 *   GET  /admin/api/reasoniq/models   -> fetch models from configured provider
 *
 *   Provider Settings:
 *   GET  /admin/api/provider/config   -> masked provider config + roles + catalog
 *   PUT  /admin/api/provider/config   -> { provider?, baseUrl?, apiKey? }
 *   GET  /admin/api/provider/models   -> retrieve models from provider
 *   PUT  /admin/api/provider/roles    -> { role, mode, model }
 *   GET  /admin/api/provider/capabilities -> derived capability availability
 *
 *   TTS (independent):
 *   GET  /admin/api/tts/config        -> masked TTS config
 *   PUT  /admin/api/tts/config        -> { provider?, baseUrl?, apiKey?, model? }
 *   GET  /admin/api/tts/models        -> retrieve models from TTS provider
 *
 *   IntentIQ (semantic classification model — same shape as ReasonIQ's):
 *   GET  /admin/api/intentiq/config   -> masked current config + env fallback
 *   PUT  /admin/api/intentiq/config   -> { provider?, baseUrl?, model?, apiKey? }
 *   GET  /admin/api/intentiq/models   -> fetch models from configured provider
 *
 *   Logos:
 *   GET  /admin/api/logos/decisions   -> durable IntentIQ/ReasonIQ decision log
 */
const express = require('express');
const path = require('path');
const { createOpenRouterClient } = require('./logos/openRouterClient');
const { retrieveModels, retrieveOpenRouterModelEndpoints } = require('./modelDiscovery');
const { readIntentModelConfig } = require('./logos/intentModelClient');

const VALID_ROLES = ['generation', 'reasoning', 'vision'];

/**
 * @param {{
 *   store: ReturnType<import('./logos/reasoningModelStore').createReasoningModelStore>,
 *   providerStore?: ReturnType<import('./providerStore').createProviderStore>,
 *   decisionStore?: ReturnType<import('./logos/decisionStore').createDecisionStore>,
 *   intentModelStore?: ReturnType<import('./logos/intentModelStore').createIntentModelStore>,
 *   auth: import('express').RequestHandler,
 *   createOpenRouterClientFn?: typeof createOpenRouterClient,
 *   retrieveModelsFn?: typeof retrieveModels,
 *   retrieveOpenRouterModelEndpointsFn?: typeof retrieveOpenRouterModelEndpoints,
 * }} deps
 */
function createAdminRouter({
  store, providerStore, decisionStore, intentModelStore, auth,
  createOpenRouterClientFn = createOpenRouterClient,
  retrieveModelsFn = retrieveModels,
  retrieveOpenRouterModelEndpointsFn = retrieveOpenRouterModelEndpoints,
}) {
  const router = express.Router();

  router.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/admin.html'));
  });

  // OpenRouter-only: a model id can be served by several underlying
  // providers, each with its own price. This is a plain passthrough to
  // OpenRouter's own public, unauthenticated endpoints listing — nothing
  // stored, nothing provider-store-specific, just a CORS-safe proxy so
  // admin.html doesn't have to call openrouter.ai directly from the browser.
  router.get('/api/openrouter/model-endpoints', auth, async (req, res) => {
    const modelId = typeof req.query.modelId === 'string' ? req.query.modelId.trim() : '';
    if (!modelId || !modelId.includes('/')) {
      return res.status(400).json({ error: 'modelId must be in "author/slug" form' });
    }
    try {
      const endpoints = await retrieveOpenRouterModelEndpointsFn({ modelId });
      res.json({ endpoints });
    } catch (err) {
      const message = err && err.message ? err.message : 'unknown error';
      if (message === 'model not found') {
        return res.status(404).json({ error: message });
      }
      res.status(502).json({ error: 'could not fetch provider endpoints from OpenRouter' });
    }
  });

  // --- ReasonIQ routes (provider-agnostic) ---

  // Resolves the provider/baseUrl/apiKey actually usable for a live models
  // fetch: the role's own saved config, or — when useMainProvider is set —
  // the shared Provider config's (providerStore) credentials/catalog. Used
  // by both /api/reasoniq/models and /api/intentiq/models.
  function resolveEffectiveProviderConfig(config) {
    if (config && config.useMainProvider) {
      const main = providerStore ? providerStore.getConfig() : null;
      if (main && main.apiKey) {
        return { provider: main.provider || 'openrouter', baseUrl: main.baseUrl || '', apiKey: main.apiKey, catalog: main.catalog || null };
      }
      return null;
    }
    if (config && config.apiKey) {
      return { provider: config.provider || 'openrouter', baseUrl: config.baseUrl || '', apiKey: config.apiKey, catalog: null };
    }
    return null;
  }

  function mainProviderConfigured() {
    const main = providerStore ? providerStore.getConfig() : null;
    return Boolean(main && main.apiKey);
  }

  router.get('/api/reasoniq/config', auth, (req, res) => {
    res.json({ ...store.getMaskedConfig(), mainProviderConfigured: mainProviderConfigured() });
  });

  router.put('/api/reasoniq/config', auth, (req, res) => {
    const body = req.body || {};
    const allowed = {};
    if (typeof body.provider === 'string') allowed.provider = body.provider.trim();
    if (typeof body.baseUrl === 'string') allowed.baseUrl = body.baseUrl.trim();
    if (typeof body.model === 'string') allowed.model = body.model.trim();
    if (typeof body.visionModel === 'string') allowed.visionModel = body.visionModel.trim();
    if (typeof body.apiKey === 'string' && body.apiKey.trim() !== '') allowed.apiKey = body.apiKey.trim();
    if (typeof body.useMainProvider === 'boolean') allowed.useMainProvider = body.useMainProvider;

    if (Object.keys(allowed).length === 0) {
      return res.status(400).json({ error: 'no valid fields supplied' });
    }

    store.saveConfig(allowed);
    res.json({ ...store.getMaskedConfig(), mainProviderConfigured: mainProviderConfigured() });
  });

  router.get('/api/reasoniq/models', auth, async (req, res) => {
    const config = store.getConfig();
    const effective = resolveEffectiveProviderConfig(config);
    if (!effective) {
      return res.status(400).json({ error: config && config.useMainProvider ? 'configure the main provider first' : 'save an API key first' });
    }
    if (effective.catalog) {
      // Already retrieved for the main provider — reuse it, no extra call.
      return res.json({ models: effective.catalog });
    }
    if (!effective.baseUrl) {
      return res.status(400).json({ error: 'set a base URL for the provider' });
    }

    try {
      const models = await retrieveModelsFn({
        provider: effective.provider,
        baseUrl: effective.baseUrl,
        apiKey: effective.apiKey,
      });
      res.json({ models });
    } catch (err) {
      const message = err && err.message ? err.message : 'unknown error';
      if (message.includes('authentication failed')) {
        return res.status(401).json({ error: 'authentication failed — check your API key' });
      }
      res.status(502).json({ error: 'could not fetch models from provider' });
    }
  });

  // --- IntentIQ routes (same shape as ReasonIQ's: save provider/key,
  // fetch the live model catalog, pick one) ---

  router.get('/api/intentiq/config', auth, (req, res) => {
    const envConfig = readIntentModelConfig();
    const masked = intentModelStore
      ? intentModelStore.getMaskedConfig()
      : { provider: null, baseUrl: null, model: null, hasApiKey: false, maskedApiKey: null, useMainProvider: false, updatedAt: null };
    res.json({
      ...masked,
      envModel: envConfig.model || null,
      envConfigured: Boolean(envConfig.baseUrl),
      mainProviderConfigured: mainProviderConfigured(),
    });
  });

  router.put('/api/intentiq/config', auth, (req, res) => {
    if (!intentModelStore) {
      return res.status(400).json({ error: 'intent model store not available' });
    }
    const body = req.body || {};
    const allowed = {};
    if (typeof body.provider === 'string') allowed.provider = body.provider.trim();
    if (typeof body.baseUrl === 'string') allowed.baseUrl = body.baseUrl.trim();
    if (typeof body.model === 'string') allowed.model = body.model.trim();
    if (typeof body.apiKey === 'string' && body.apiKey.trim() !== '') allowed.apiKey = body.apiKey.trim();
    if (typeof body.useMainProvider === 'boolean') allowed.useMainProvider = body.useMainProvider;

    if (Object.keys(allowed).length === 0) {
      return res.status(400).json({ error: 'no valid fields supplied' });
    }

    intentModelStore.saveConfig(allowed);
    const envConfig = readIntentModelConfig();
    res.json({
      ...intentModelStore.getMaskedConfig(),
      envModel: envConfig.model || null,
      envConfigured: Boolean(envConfig.baseUrl),
      mainProviderConfigured: mainProviderConfigured(),
    });
  });

  router.get('/api/intentiq/models', auth, async (req, res) => {
    const config = intentModelStore ? intentModelStore.getConfig() : null;
    const effective = resolveEffectiveProviderConfig(config);
    if (!effective) {
      return res.status(400).json({ error: config && config.useMainProvider ? 'configure the main provider first' : 'save an API key first' });
    }
    if (effective.catalog) {
      return res.json({ models: effective.catalog });
    }
    if (!effective.baseUrl) {
      return res.status(400).json({ error: 'set a base URL for the provider' });
    }

    try {
      const models = await retrieveModelsFn({
        provider: effective.provider,
        baseUrl: effective.baseUrl,
        apiKey: effective.apiKey,
      });
      res.json({ models });
    } catch (err) {
      const message = err && err.message ? err.message : 'unknown error';
      if (message.includes('authentication failed')) {
        return res.status(401).json({ error: 'authentication failed — check your API key' });
      }
      res.status(502).json({ error: 'could not fetch models from provider' });
    }
  });

  router.get('/api/logos/decisions', auth, (req, res) => {
    if (!decisionStore) {
      return res.json({ decisions: [] });
    }
    const limit = Number(req.query.limit);
    const kind = typeof req.query.kind === 'string' ? req.query.kind : undefined;
    res.json({ decisions: decisionStore.list({ limit: Number.isFinite(limit) ? limit : undefined, kind }) });
  });

  // ReasonIQ's own activity log — the same decisionStore records, but
  // filtered server-side to ReasonIQ's three kinds (gate, result, and the
  // reasoning llm.call) and sorted newest first. Gives the admin page one
  // dedicated surface for "what did ReasonIQ do with my turns?" without
  // mixing in IntentIQ/native decisions.
  router.get('/api/reasoniq/log', auth, (req, res) => {
    if (!decisionStore) {
      return res.json({ entries: [] });
    }
    const limit = Number(req.query.limit);
    const entries = decisionStore.list({ limit: Number.isFinite(limit) ? limit : 1000 })
      .filter((r) => r.kind === 'reasoniq.gate' || r.kind === 'reasoniq.result' || (r.kind === 'llm.call' && r.system === 'reasoniq'));
    res.json({ entries });
  });

  // --- Provider Settings routes ---

  if (providerStore) {
    router.get('/api/provider/config', auth, (req, res) => {
      res.json(providerStore.getMaskedConfig());
    });

    router.put('/api/provider/config', auth, (req, res) => {
      const body = req.body || {};
      const allowed = {};
      if (typeof body.provider === 'string') allowed.provider = body.provider.trim();
      if (typeof body.baseUrl === 'string') allowed.baseUrl = body.baseUrl.trim();
      if (typeof body.apiKey === 'string' && body.apiKey.trim() !== '') allowed.apiKey = body.apiKey.trim();

      if (Object.keys(allowed).length === 0) {
        return res.status(400).json({ error: 'no valid fields supplied' });
      }

      providerStore.saveProviderConfig(allowed);
      res.json(providerStore.getMaskedConfig());
    });

    router.get('/api/provider/models', auth, async (req, res) => {
      const config = providerStore.getConfig();
      if (!config || !config.provider) {
        return res.status(400).json({ error: 'configure a provider first' });
      }
      if (!config.baseUrl) {
        return res.status(400).json({ error: 'set a base URL for the provider' });
      }

      try {
        const catalog = await retrieveModelsFn({
          provider: config.provider,
          baseUrl: config.baseUrl,
          apiKey: config.apiKey || '',
        });
        providerStore.saveCatalog(catalog, new Date().toISOString());
        res.json({ catalog, catalogRetrievedAt: new Date().toISOString() });
      } catch (err) {
        const message = err && err.message ? err.message : 'unknown error';
        if (message.includes('authentication failed')) {
          return res.status(401).json({ error: 'authentication failed — check your API key' });
        }
        res.status(502).json({ error: 'could not retrieve models from provider' });
      }
    });

    router.put('/api/provider/roles', auth, (req, res) => {
      const body = req.body || {};
      const role = body.role;
      if (!VALID_ROLES.includes(role)) {
        return res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });
      }
      const mode = body.mode;
      if (mode !== 'catalog' && mode !== 'manual') {
        return res.status(400).json({ error: 'mode must be "catalog" or "manual"' });
      }
      const model = typeof body.model === 'string' ? body.model.trim() : '';

      providerStore.saveRoleSelection(role, { mode, model });
      res.json(providerStore.getMaskedConfig());
    });

    router.get('/api/provider/capabilities', auth, (req, res) => {
      const config = providerStore.getConfig();
      const roles = config && config.roles ? config.roles : {};
      const ttsConfig = config && config.tts ? config.tts : {};
      const capabilities = {
        generation: Boolean(roles.generation && roles.generation.model),
        reasoning: Boolean(roles.reasoning && roles.reasoning.model),
        vision: Boolean(roles.vision && roles.vision.model),
        tts: Boolean(ttsConfig.model),
      };
      res.json(capabilities);
    });

    // --- TTS (independent) routes ---

    router.get('/api/tts/config', auth, (req, res) => {
      res.json({ ...providerStore.getMaskedConfig().tts, mainProviderConfigured: mainProviderConfigured() });
    });

    router.put('/api/tts/config', auth, (req, res) => {
      const body = req.body || {};
      const allowed = {};
      if (typeof body.provider === 'string') allowed.provider = body.provider.trim();
      if (typeof body.baseUrl === 'string') allowed.baseUrl = body.baseUrl.trim();
      if (typeof body.model === 'string') allowed.model = body.model.trim();
      if (typeof body.apiKey === 'string' && body.apiKey.trim() !== '') allowed.apiKey = body.apiKey.trim();
      if (typeof body.useMainProvider === 'boolean') allowed.useMainProvider = body.useMainProvider;

      if (Object.keys(allowed).length === 0) {
        return res.status(400).json({ error: 'no valid fields supplied' });
      }

      providerStore.saveTtsConfig(allowed);
      res.json({ ...providerStore.getMaskedConfig().tts, mainProviderConfigured: mainProviderConfigured() });
    });

    router.get('/api/tts/models', auth, async (req, res) => {
      const config = providerStore.getConfig();
      const tts = config && config.tts ? config.tts : {};
      const effective = tts.useMainProvider
        ? (config && config.apiKey ? { provider: config.provider || 'openrouter', baseUrl: config.baseUrl || '', apiKey: config.apiKey } : null)
        : (tts.provider ? { provider: tts.provider, baseUrl: tts.baseUrl || '', apiKey: tts.apiKey || '' } : null);
      if (!effective) {
        return res.status(400).json({ error: tts.useMainProvider ? 'configure the main provider first' : 'configure a TTS provider first' });
      }
      if (!effective.baseUrl) {
        return res.status(400).json({ error: 'set a base URL for the TTS provider' });
      }

      try {
        const models = await retrieveModelsFn({
          provider: effective.provider,
          baseUrl: effective.baseUrl,
          apiKey: effective.apiKey,
        });
        // TTS doesn't need a persisted catalog — just return the list
        res.json({ models });
      } catch (err) {
        const message = err && err.message ? err.message : 'unknown error';
        if (message.includes('authentication failed')) {
          return res.status(401).json({ error: 'authentication failed — check your TTS API key' });
        }
        res.status(502).json({ error: 'could not retrieve models from TTS provider' });
      }
    });
  }

  return router;
}

module.exports = { createAdminRouter };
