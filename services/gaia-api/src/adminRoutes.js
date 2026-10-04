'use strict';

/**
 * Admin surface for configuring the unified model provider at runtime. Deliberately separate from Gaia Desktop's
 * Settings panel — this is operator/admin tooling for Gaia Cloud itself,
 * gated behind the same bearer token as every other authenticated route.
 *
 * The API key never round-trips back to any client once saved.
 *
 * Routes (all mounted under /admin, all except the static page require
 * the standard Bearer auth):
 *   GET  /admin                       -> the static admin page
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
 *   PUT  /admin/api/tts/config        -> { provider?, baseUrl?, apiKey?, model?, voiceId? }
 *   GET  /admin/api/tts/models        -> retrieve models from TTS provider
 *   GET  /admin/api/tts/voices        -> list saved voices from the TTS provider (Mistral only)
 *   GET  /admin/api/tts/log           -> recent speech-synthesis attempts, newest first
 *
 *   Logos:
 *   GET  /admin/api/logos/decisions   -> durable Logos decision log
 */
const express = require('express');
const path = require('path');
const { createOpenRouterClient } = require('./logos/openRouterClient');
const { retrieveModels, retrieveOpenRouterModelEndpoints } = require('./modelDiscovery');
const { listVoices: listMistralVoices } = require('./speech/mistralTts');

const VALID_ROLES = ['generation', 'reasoning', 'vision', 'kairos'];

/**
 * @param {{
 *   providerStore?: ReturnType<import('./providerStore').createProviderStore>,
 *   decisionStore?: ReturnType<import('./logos/decisionStore').createDecisionStore>,
 *   auth: import('express').RequestHandler,
 *   createOpenRouterClientFn?: typeof createOpenRouterClient,
 *   retrieveModelsFn?: typeof retrieveModels,
 *   retrieveOpenRouterModelEndpointsFn?: typeof retrieveOpenRouterModelEndpoints,
 *   listTtsVoicesFn?: (options: { baseUrl: string, apiKey?: string }) => Promise<Array<{ id: string, name: string }>>,
 *   ttsLog?: { list: () => object[] },
 * }} deps
 */
function createAdminRouter({
  providerStore, decisionStore, auth, ttsLog,
  createOpenRouterClientFn = createOpenRouterClient,
  retrieveModelsFn = retrieveModels,
  retrieveOpenRouterModelEndpointsFn = retrieveOpenRouterModelEndpoints,
  listTtsVoicesFn = listMistralVoices,
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

  function mainProviderConfigured() {
    const main = providerStore ? providerStore.getConfig() : null;
    return Boolean(main && main.apiKey);
  }

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

    // --- Backup generation provider (independent inference fallback) ---
    // GET returns the masked backup config; PUT accepts
    // { provider?, baseUrl?, model?, apiKey? }. An empty apiKey never
    // clears or changes the stored key.

    router.get('/api/provider/backup/config', auth, (req, res) => {
      res.json(providerStore.getMaskedConfig().generationBackup);
    });

    router.put('/api/provider/backup/config', auth, (req, res) => {
      const body = req.body || {};
      const allowed = {};
      if (typeof body.provider === 'string') allowed.provider = body.provider.trim();
      if (typeof body.baseUrl === 'string') allowed.baseUrl = body.baseUrl.trim();
      if (typeof body.model === 'string') allowed.model = body.model.trim();
      if (typeof body.apiKey === 'string' && body.apiKey.trim() !== '') allowed.apiKey = body.apiKey.trim();

      if (Object.keys(allowed).length === 0) {
        return res.status(400).json({ error: 'no valid fields supplied' });
      }

      providerStore.saveBackupConfig(allowed);
      res.json(providerStore.getMaskedConfig().generationBackup);
    });

    router.get('/api/provider/capabilities', auth, (req, res) => {
      const config = providerStore.getConfig();
      const roles = config && config.roles ? config.roles : {};
      const ttsConfig = config && config.tts ? config.tts : {};
      const capabilities = {
        generation: Boolean(roles.generation && roles.generation.model),
        reasoning: Boolean(roles.reasoning && roles.reasoning.model),
        vision: Boolean(roles.vision && roles.vision.model),
        kairos: Boolean(roles.kairos && roles.kairos.model),
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
      if (typeof body.voiceId === 'string') allowed.voiceId = body.voiceId.trim();
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

    router.get('/api/tts/voices', auth, async (req, res) => {
      const config = providerStore.getConfig();
      const tts = config && config.tts ? config.tts : {};
      const effective = tts.useMainProvider
        ? (config && config.apiKey ? { provider: config.provider || 'openrouter', baseUrl: config.baseUrl || '', apiKey: config.apiKey } : null)
        : (tts.provider ? { provider: tts.provider, baseUrl: tts.baseUrl || '', apiKey: tts.apiKey || '' } : null);
      if (!effective) {
        return res.status(400).json({ error: tts.useMainProvider ? 'configure the main provider first' : 'configure a TTS provider first' });
      }
      // Only Mistral exposes a voice library (GET /v1/audio/voices) —
      // MiMo designs its voice from a prompt instead, so there is nothing
      // to list for any other provider.
      if (effective.provider !== 'mistral') {
        return res.status(400).json({ error: 'voice listing is only available for Mistral Voxtral' });
      }
      if (!effective.baseUrl) {
        return res.status(400).json({ error: 'set a base URL for the TTS provider' });
      }

      try {
        const voices = await listTtsVoicesFn({
          baseUrl: effective.baseUrl,
          authToken: effective.apiKey,
        });
        res.json({ voices });
      } catch (err) {
        if (err && err.status === 401) {
          return res.status(401).json({ error: 'authentication failed — check your TTS API key' });
        }
        res.status(502).json({ error: 'could not retrieve voices from TTS provider' });
      }
    });

    router.get('/api/tts/log', auth, (req, res) => {
      // The voice activity tail (src/speech/ttsLog.js) — what POST
      // /speech attempted, with what, and how it ended. Operator-only
      // like everything under /admin: entries name the provider/model
      // (already visible in the masked TTS config) but never carry keys,
      // endpoints, or stacks. Absent when this router was constructed
      // without a log (unit tests) — an empty tail, not a 404.
      res.json({ entries: ttsLog ? ttsLog.list() : [] });
    });
  }

  return router;
}

module.exports = { createAdminRouter };
