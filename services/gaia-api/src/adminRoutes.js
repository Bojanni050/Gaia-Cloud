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
 *   PUT  /admin/api/provider/role-provider -> { role, provider?, baseUrl?, model?, apiKey?, useMainProvider? } (generation/reasoning/vision/kairos/aion)
 *   POST /admin/api/provider/role-models -> { role, provider, baseUrl, apiKey? } -> the role's own provider's model list
 *   POST /admin/api/provider/role-test -> { role, provider?, baseUrl?, model?, apiKey? } -> one minimal chat call, to prove the role's model answers
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
const { CUSTOM_PROVIDER_ROLES } = require('./providerStore');
const { resolveRoleConfig } = require('./providerConfigResolver');
const { probeChatCompletion } = require('./providerProbe');

const VALID_ROLES = ['generation', 'reasoning', 'vision', 'kairos', 'aion'];

/**
 * @param {{
 *   providerStore?: ReturnType<import('./providerStore').createProviderStore>,
 *   decisionStore?: ReturnType<import('./logos/decisionStore').createDecisionStore>,
 *   auth: import('express').RequestHandler,
 *   createOpenRouterClientFn?: typeof createOpenRouterClient,
 *   retrieveModelsFn?: typeof retrieveModels,
 *   retrieveOpenRouterModelEndpointsFn?: typeof retrieveOpenRouterModelEndpoints,
 *   listTtsVoicesFn?: (options: { baseUrl: string, apiKey?: string }) => Promise<Array<{ id: string, name: string }>>,
 *   probeChatFn?: typeof probeChatCompletion,
 *   ttsLog?: { list: () => object[] },
 * }} deps
 */
function createAdminRouter({
  providerStore, decisionStore, auth, ttsLog,
  createOpenRouterClientFn = createOpenRouterClient,
  retrieveModelsFn = retrieveModels,
  retrieveOpenRouterModelEndpointsFn = retrieveOpenRouterModelEndpoints,
  listTtsVoicesFn = listMistralVoices,
  probeChatFn = probeChatCompletion,
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
    // The masked config plus, per role, the config the runtime will actually
    // resolve — so the admin cards can show "Active · <model> · <provider>"
    // without duplicating the resolver's fallback rules on the client.
    function maskedWithResolved() {
      const masked = providerStore.getMaskedConfig();
      const resolved = {};
      for (const role of VALID_ROLES) {
        const c = resolveRoleConfig(role, providerStore);
        resolved[role] = c ? { provider: c.provider || '', model: c.model || '', baseUrl: c.baseUrl || '' } : null;
      }
      return { ...masked, resolved };
    }

    router.get('/api/provider/config', auth, (req, res) => {
      res.json(maskedWithResolved());
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
      res.json(maskedWithResolved());
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
      res.json(maskedWithResolved());
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

    // --- Per-role custom provider (generation / reasoning / vision / kairos / aion) ---
    // PUT accepts { role, provider?, baseUrl?, model?, apiKey?, useMainProvider? }.
    // An empty apiKey never clears or changes the stored key.

    router.put('/api/provider/role-provider', auth, (req, res) => {
      const body = req.body || {};
      const role = body.role;
      if (!CUSTOM_PROVIDER_ROLES.includes(role)) {
        return res.status(400).json({ error: `role must be one of: ${CUSTOM_PROVIDER_ROLES.join(', ')}` });
      }
      const allowed = {};
      if (typeof body.provider === 'string') allowed.provider = body.provider.trim();
      if (typeof body.baseUrl === 'string') allowed.baseUrl = body.baseUrl.trim();
      if (typeof body.model === 'string') allowed.model = body.model.trim();
      if (typeof body.apiKey === 'string' && body.apiKey.trim() !== '') allowed.apiKey = body.apiKey.trim();
      if (typeof body.useMainProvider === 'boolean') allowed.useMainProvider = body.useMainProvider;

      providerStore.saveRoleProvider(role, allowed);
      res.json(maskedWithResolved());
    });

    // Fetch the model list for a role's OWN custom provider (not the Main
    // Provider's catalog), so the operator can pick a model id instead of
    // typing it. Uses the body's apiKey when given, else the role's stored key.
    router.post('/api/provider/role-models', auth, async (req, res) => {
      const body = req.body || {};
      const role = body.role;
      if (!CUSTOM_PROVIDER_ROLES.includes(role)) {
        return res.status(400).json({ error: `role must be one of: ${CUSTOM_PROVIDER_ROLES.join(', ')}` });
      }
      const provider = typeof body.provider === 'string' ? body.provider.trim() : '';
      const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : '';
      let apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
      if (!apiKey) {
        const stored = providerStore.getConfig();
        const rp = stored && stored.roleProviders ? stored.roleProviders[role] : null;
        if (rp && rp.apiKey) apiKey = rp.apiKey;
      }
      if (!provider) return res.status(400).json({ error: 'select a provider first' });
      if (!baseUrl && provider !== 'edenai') return res.status(400).json({ error: 'set a base URL for the provider' });

      try {
        const models = await retrieveModelsFn({ provider, baseUrl, apiKey });
        res.json({ models });
      } catch (err) {
        const message = err && err.message ? err.message : 'unknown error';
        if (message.includes('authentication failed')) {
          return res.status(401).json({ error: 'authentication failed — check your API key' });
        }
        res.status(502).json({ error: 'could not retrieve models from provider' });
      }
    });

    // Prove a role's model actually answers. Resolves the role exactly as the
    // runtime does (Main Provider or its own provider), with the form's unsaved
    // values overriding the saved ones so a connection can be tested before it
    // is saved. One minimal chat call; the key is used but never returned.
    router.post('/api/provider/role-test', auth, async (req, res) => {
      const body = req.body || {};
      const role = body.role;
      if (!VALID_ROLES.includes(role)) {
        return res.status(400).json({ ok: false, error: `role must be one of: ${VALID_ROLES.join(', ')}` });
      }
      const stored = providerStore.getConfig();
      const rp = stored && stored.roleProviders ? stored.roleProviders[role] : null;
      let cfg = resolveRoleConfig(role, providerStore);
      if (body.baseUrl || body.model) {
        cfg = {
          provider: body.provider || (rp && rp.provider) || (cfg && cfg.provider) || 'custom',
          baseUrl: body.baseUrl || (rp && rp.baseUrl) || (cfg && cfg.baseUrl) || '',
          model: body.model || (rp && rp.model) || (cfg && cfg.model) || '',
          apiKey: body.apiKey || (rp && rp.apiKey) || (cfg && cfg.apiKey) || '',
        };
      }
      if (!cfg || !cfg.baseUrl || !cfg.model) {
        return res.json({ ok: false, error: 'no model configured for this role' });
      }
      const result = await probeChatFn({ baseUrl: cfg.baseUrl, model: cfg.model, apiKey: cfg.apiKey });
      res.json({
        ok: !!result.ok,
        provider: cfg.provider || '',
        model: cfg.model,
        latencyMs: result.latencyMs,
        status: result.status,
        sample: result.sample,
        error: result.ok ? undefined : (result.error || 'connection failed'),
      });
    });

    router.get('/api/provider/capabilities', auth, (req, res) => {
      const config = providerStore.getConfig();
      const roles = config && config.roles ? config.roles : {};
      const roleProviders = config && config.roleProviders ? config.roleProviders : {};
      const ttsConfig = config && config.tts ? config.tts : {};
      // A custom-provider role is active when it names its own endpoint, or
      // when it has a model picked from the Main Provider's catalog.
      const roleActive = (r) => {
        const custom = roleProviders[r];
        if (custom && custom.useMainProvider === false && custom.baseUrl && custom.model) return true;
        return Boolean(roles[r] && roles[r].model);
      };
      const capabilities = {
        generation: roleActive('generation'),
        reasoning: roleActive('reasoning'),
        vision: roleActive('vision'),
        kairos: roleActive('kairos'),
        aion: roleActive('aion'),
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
