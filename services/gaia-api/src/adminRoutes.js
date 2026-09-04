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
 *   IntentIQ:
 *   GET  /admin/api/intentiq/config   -> current model override (+ env fallback + effective value)
 *   PUT  /admin/api/intentiq/config   -> { model } — empty/blank clears the override
 *
 *   Logos:
 *   GET  /admin/api/logos/decisions   -> durable IntentIQ/ReasonIQ decision log
 */
const express = require('express');
const path = require('path');
const { createOpenRouterClient } = require('./logos/openRouterClient');
const { retrieveModels } = require('./modelDiscovery');
const { readIntentModelConfig } = require('./logos/intentModelClient');
const { resolveIntentModelConfig } = require('./logos/intentModelConfigResolver');

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
 * }} deps
 */
function createAdminRouter({ store, providerStore, decisionStore, intentModelStore, auth, createOpenRouterClientFn = createOpenRouterClient, retrieveModelsFn = retrieveModels }) {
  const router = express.Router();

  router.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/admin.html'));
  });

  // --- ReasonIQ routes (provider-agnostic) ---

  router.get('/api/reasoniq/config', auth, (req, res) => {
    res.json(store.getMaskedConfig());
  });

  router.put('/api/reasoniq/config', auth, (req, res) => {
    const body = req.body || {};
    const allowed = {};
    if (typeof body.provider === 'string') allowed.provider = body.provider.trim();
    if (typeof body.baseUrl === 'string') allowed.baseUrl = body.baseUrl.trim();
    if (typeof body.model === 'string') allowed.model = body.model.trim();
    if (typeof body.visionModel === 'string') allowed.visionModel = body.visionModel.trim();
    if (typeof body.apiKey === 'string' && body.apiKey.trim() !== '') allowed.apiKey = body.apiKey.trim();

    if (Object.keys(allowed).length === 0) {
      return res.status(400).json({ error: 'no valid fields supplied' });
    }

    store.saveConfig(allowed);
    res.json(store.getMaskedConfig());
  });

  router.get('/api/reasoniq/models', auth, async (req, res) => {
    const config = store.getConfig();
    if (!config || !config.apiKey) {
      return res.status(400).json({ error: 'save an API key first' });
    }
    if (!config.baseUrl) {
      return res.status(400).json({ error: 'set a base URL for the provider' });
    }

    try {
      const models = await retrieveModelsFn({
        provider: config.provider || 'openrouter',
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
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

  // --- IntentIQ routes ---

  router.get('/api/intentiq/config', auth, (req, res) => {
    const envConfig = readIntentModelConfig();
    const stored = intentModelStore ? intentModelStore.getMaskedConfig() : { model: null, updatedAt: null };
    const effective = resolveIntentModelConfig({ store: intentModelStore });
    res.json({
      envModel: envConfig.model || null,
      configured: Boolean(envConfig.baseUrl),
      overrideModel: stored.model,
      updatedAt: stored.updatedAt,
      effectiveModel: effective.model || null,
    });
  });

  router.put('/api/intentiq/config', auth, (req, res) => {
    if (!intentModelStore) {
      return res.status(400).json({ error: 'intent model store not available' });
    }
    const body = req.body || {};
    if (typeof body.model !== 'string') {
      return res.status(400).json({ error: 'model is required (empty string clears the override)' });
    }
    intentModelStore.saveConfig({ model: body.model });
    const envConfig = readIntentModelConfig();
    const stored = intentModelStore.getMaskedConfig();
    const effective = resolveIntentModelConfig({ store: intentModelStore });
    res.json({
      envModel: envConfig.model || null,
      configured: Boolean(envConfig.baseUrl),
      overrideModel: stored.model,
      updatedAt: stored.updatedAt,
      effectiveModel: effective.model || null,
    });
  });

  router.get('/api/logos/decisions', auth, (req, res) => {
    if (!decisionStore) {
      return res.json({ decisions: [] });
    }
    const limit = Number(req.query.limit);
    const kind = typeof req.query.kind === 'string' ? req.query.kind : undefined;
    res.json({ decisions: decisionStore.list({ limit: Number.isFinite(limit) ? limit : undefined, kind }) });
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
      res.json(providerStore.getMaskedConfig().tts);
    });

    router.put('/api/tts/config', auth, (req, res) => {
      const body = req.body || {};
      const allowed = {};
      if (typeof body.provider === 'string') allowed.provider = body.provider.trim();
      if (typeof body.baseUrl === 'string') allowed.baseUrl = body.baseUrl.trim();
      if (typeof body.model === 'string') allowed.model = body.model.trim();
      if (typeof body.apiKey === 'string' && body.apiKey.trim() !== '') allowed.apiKey = body.apiKey.trim();

      if (Object.keys(allowed).length === 0) {
        return res.status(400).json({ error: 'no valid fields supplied' });
      }

      providerStore.saveTtsConfig(allowed);
      res.json(providerStore.getMaskedConfig().tts);
    });

    router.get('/api/tts/models', auth, async (req, res) => {
      const config = providerStore.getConfig();
      const tts = config && config.tts ? config.tts : {};
      if (!tts.provider) {
        return res.status(400).json({ error: 'configure a TTS provider first' });
      }
      if (!tts.baseUrl) {
        return res.status(400).json({ error: 'set a base URL for the TTS provider' });
      }

      try {
        const models = await retrieveModelsFn({
          provider: tts.provider,
          baseUrl: tts.baseUrl,
          apiKey: tts.apiKey || '',
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
