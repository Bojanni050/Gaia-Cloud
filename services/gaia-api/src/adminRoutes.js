'use strict';

/**
 * Admin surface for configuring ReasonIQ's reasoning model at runtime —
 * fill in an OpenRouter API key, fetch the models it makes available,
 * and choose one. Deliberately separate from Gaia Desktop's Settings
 * panel (which states plainly that "nothing cognitive ever appears
 * here") and from anything a normal Gaia client touches: this is
 * operator/admin tooling for Gaia Cloud itself, gated behind the same
 * bearer token as every other authenticated route on this API.
 *
 * The API key never round-trips back to any client once saved — see
 * reasoningModelStore.js's getMaskedConfig().
 *
 * Routes (all mounted under /admin, all except the static page require
 * the standard Bearer auth):
 *   GET  /admin                       -> the static admin page (public shell, no secrets embedded)
 *   GET  /admin/api/reasoniq/config   -> masked current config
 *   PUT  /admin/api/reasoniq/config   -> { provider?, baseUrl?, model?, visionModel?, apiKey? } -> masked config
 *       `visionModel` is a separate, optional model id used only for
 *       image OCR (ocrResolver.js) — same OpenRouter account as `model`,
 *       falls back to `model` when unset.
 *   GET  /admin/api/reasoniq/models   -> fetches the model list from OpenRouter using the stored key
 *   GET  /admin/api/logos/decisions  -> { decisions: [...] } — durable IntentIQ/ReasonIQ decision log
 *       (decisionStore.js), newest first. Query params: `limit` (default 50),
 *       `kind` ('intentiq.decision' | 'reasoniq.result', omit for both).
 *
 * Provider Settings routes (new — unified provider + role-based model selection):
 *   GET  /admin/api/provider/config           -> masked provider config + roles + catalog
 *   PUT  /admin/api/provider/config           -> { provider?, baseUrl?, apiKey? } -> masked config
 *   GET  /admin/api/provider/models           -> retrieve models from the configured provider
 *   PUT  /admin/api/provider/roles            -> { role, mode, model } -> masked config
 *   GET  /admin/api/provider/capabilities     -> derived capability availability
 */
const express = require('express');
const path = require('path');
const { createOpenRouterClient } = require('./logos/openRouterClient');
const { retrieveModels } = require('./modelDiscovery');

const VALID_ROLES = ['generation', 'reasoning', 'vision', 'tts'];

/**
 * @param {{
 *   store: ReturnType<import('./logos/reasoningModelStore').createReasoningModelStore>,
 *   providerStore?: ReturnType<import('./providerStore').createProviderStore>,
 *   decisionStore?: ReturnType<import('./logos/decisionStore').createDecisionStore>,
 *   auth: import('express').RequestHandler,
 *   createOpenRouterClientFn?: typeof createOpenRouterClient,
 *   retrieveModelsFn?: typeof retrieveModels,
 * }} deps
 */
function createAdminRouter({ store, providerStore, decisionStore, auth, createOpenRouterClientFn = createOpenRouterClient, retrieveModelsFn = retrieveModels }) {
  const router = express.Router();

  router.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/admin.html'));
  });

  // --- ReasonIQ routes (unchanged) ---

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
      return res.status(400).json({ error: 'save an OpenRouter API key first' });
    }

    const client = createOpenRouterClientFn({ apiKey: config.apiKey, baseUrl: config.baseUrl });
    try {
      const models = await client.listModels();
      res.json({ models });
    } catch (err) {
      res.status(502).json({ error: 'could not fetch models from openrouter right now' });
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
        // Never log or return API keys — calm, generic error only.
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
      const capabilities = {
        generation: Boolean(roles.generation && roles.generation.model),
        reasoning: Boolean(roles.reasoning && roles.reasoning.model),
        vision: Boolean(roles.vision && roles.vision.model),
        tts: Boolean(roles.tts && roles.tts.model),
      };
      res.json(capabilities);
    });
  }

  return router;
}

module.exports = { createAdminRouter };
