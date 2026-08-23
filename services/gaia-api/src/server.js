'use strict';

/**
 * The Gaia API — where first-class clients reach Gaia.
 *
 * Contract (kept in lockstep with the desktop's `conversation/turn` seam):
 *   GET  /health             → { ok: true, soulVersion: string }
 *   GET  /soul               → { version: string }   (identity version only)
 *   POST /conversation/turn  → { reply: string }     (auth required, Desktop's exact contract; optional { attachmentIds: [...] } inlines library files as context)
 *   POST /conversation/turn  → SSE stream            (auth required; { ..., stream: true } — Phase B, docs/web-migration-plan.md)
 *   /admin/*                 → operator-only ReasonIQ config + IntentIQ/ReasonIQ decision log (adminRoutes.js) — never part of any client's contract
 *   /library/*               → file library: upload/list/download/delete (libraryRoutes.js), auth required
 *   /conversations/*         → chat history: list/read/delete (historyRoutes.js), auth required — written as a
 *                              fire-and-forget side effect of a successful /conversation/turn, never by direct upload
 *   POST /speech             → audio/wav            (auth required; { text } → Gaia's voice, src/speech/mimoTts.js —
 *                              presentation-only, always *after* a text reply exists, never part of the Decision Engine)
 *
 * Everything cognitive lives here or behind a capability (Hermes, or Gaia's
 * own native generator — src/generation/gaiaGenerator.js, wired in below via
 * `nativeGenerator` when GAIA_NATIVE_BASE_URL/GAIA_NATIVE_MODEL are set);
 * clients send plain turns and render plain replies. Model-agnostic by
 * construction: the reply shape carries no provider information whatsoever.
 * Which capability actually answers a turn is turn.js's Decision Engine's
 * call, never this file's — server.js only constructs and hands over what
 * is available.
 */
const express = require('express');
const { parseTokens, createAuthMiddleware } = require('./auth');
const { createHermesClient } = require('./hermesClient');
const { createHindsightClient } = require('./hindsightClient');
const { createFromEnv: createNativeGeneratorFromEnv } = require('./generation/gaiaGenerator');
const { createFromEnv: createTtsFromEnv } = require('./speech/mimoTts');
const { performTurn, performStreamingTurn } = require('./turn');
const { loadSoul } = require('./soul');
const { loadFoundationDocuments } = require('./foundation');
const { createAdminRouter } = require('./adminRoutes');
const { createReasoningModelStore } = require('./logos/reasoningModelStore');
const { createLibraryStore, resolveAttachmentsForPrompt } = require('./library');
const { createLibraryRouter } = require('./libraryRoutes');
const { createConversationStore } = require('./conversationStore');
const { createHistoryRouter } = require('./historyRoutes');
const { createDecisionStore } = require('./logos/decisionStore');

const PORT = Number(process.env.PORT || 8891);

function createApp(env = process.env) {
  const soul = loadSoulWithEnv(env);
  const systemPrompt = soul.prompt;
  const documents = loadFoundationDocumentsWithEnv(env);
  const hermes = createHermesClient({
    baseUrl: env.HERMES_BASE_URL,
    model: env.HERMES_MODEL || 'hermes-agent',
    authToken: env.HERMES_AUTH_TOKEN,
  });
  const hindsight = createHindsightClient({
    baseUrl: env.HINDSIGHT_URL || 'http://100.64.144.93:8888',
    bankId: env.HINDSIGHT_BANK_ID || 'bojan',
    budget: env.HINDSIGHT_RECALL_BUDGET || 'mid',
  });
  // Gaia's native voice (src/generation/gaiaGenerator.js) — undefined when
  // GAIA_NATIVE_BASE_URL/GAIA_NATIVE_MODEL are unset, in which case the
  // Decision Engine never sees a "native" capability and every turn routes
  // through Hermes exactly as before this existed (see .env.example).
  const nativeGenerator = createNativeGeneratorFromEnv(env);
  // Gaia's voice (src/speech/mimoTts.js) — undefined when GAIA_TTS_BASE_URL/
  // GAIA_TTS_MODEL are unset, in which case POST /speech answers 503
  // rather than attempting a call with nothing configured. Entirely
  // separate from nativeGenerator above: this never influences what Gaia
  // says, only how an already-decided reply sounds.
  const tts = createTtsFromEnv(env);
  const auth = createAuthMiddleware(parseTokens(env.GAIA_API_TOKEN));

  const app = express();
  app.use(express.json());

  // Request log — server-side only, so failures are diagnosable without
  // leaking anything to clients.
  app.use((req, res, next) => {
    res.on('finish', () => {
      console.log(`${req.method} ${req.path} -> ${res.statusCode}`);
    });
    next();
  });

  const health = (req, res) => res.json({ ok: true, soulVersion: soul.version });
  app.get('/health', health);
  app.get('/', health);

  // Identity version only — clients observe which SOUL they're talking to;
  // the constitution itself stays server-side.
  app.get('/soul', (req, res) => res.json({ version: soul.version }));

  const reasoningModelStore = createReasoningModelStore(
    env.REASONIQ_CONFIG_PATH !== undefined ? { storePath: env.REASONIQ_CONFIG_PATH } : {}
  );
  const decisionStore = createDecisionStore(
    env.LOGOS_DECISIONS_PATH !== undefined ? { decisionsDir: env.LOGOS_DECISIONS_PATH } : {}
  );
  app.use('/admin', createAdminRouter({ store: reasoningModelStore, decisionStore, auth }));

  const libraryStore = createLibraryStore(env.LIBRARY_PATH !== undefined ? { libraryDir: env.LIBRARY_PATH } : {});
  const libraryMaxFileSizeMb = Number(env.LIBRARY_MAX_FILE_SIZE_MB) || undefined;
  app.use(
    '/library',
    createLibraryRouter({
      store: libraryStore,
      auth,
      ...(libraryMaxFileSizeMb ? { maxFileSizeMb: libraryMaxFileSizeMb } : {}),
    })
  );

  const historyStore = createConversationStore(env.HISTORY_PATH !== undefined ? { historyDir: env.HISTORY_PATH } : {});
  app.use('/conversations', createHistoryRouter({ store: historyStore, auth }));

  app.post('/conversation/turn', auth, async (req, res) => {
    const messages = req.body && req.body.messages;
    const conversationId = req.body && req.body.conversationId;

    if (req.body && req.body.stream) {
      await performStreamingTurn({
        messages,
        documents,
        hermes,
        hindsight,
        res,
        conversationId,
        nativeGenerator,
        historyStore,
        decisionStore,
      });
      return;
    }

    const attachmentIds = (req.body && req.body.attachmentIds) || [];
    const attachments = await resolveAttachmentsForPrompt(libraryStore, attachmentIds);
    const result = await performTurn({ messages, systemPrompt, hermes, attachments, nativeGenerator });
    res.status(result.status).json(result.body);

    // Chat history — fire-and-forget, after the response is already sent,
    // never Hindsight's job (see conversationStore.js's module comment).
    // performTurn stays the minimal, unchanged function; this side effect
    // lives here, not inside it, for the same reason performStreamingTurn
    // keeps reflectOnTurn's save separate from producing the reply.
    if (result.status === 200 && conversationId) {
      try {
        historyStore.saveConversation(conversationId, [...messages, { role: 'assistant', content: result.body.reply }]);
      } catch (_) {
        // Never surface a history-write failure as a turn failure.
      }
    }
  });

  // Gaia's voice — strictly a presentation step on an *already-produced*
  // Gaia text reply. This route never generates, selects, or judges text;
  // it only ever turns given text into audio. `text` here is expected to
  // be the client's already-received Gaia response (see the desktop's own
  // wiring), not a fresh prompt for Gaia to answer — this route does not
  // run IntentIQ/ReasonIQ/the Decision Engine/Orchestrator/Response Engine
  // at all, by construction (it never imports any of them).
  app.post('/speech', auth, async (req, res) => {
    const text = req.body && req.body.text;
    if (typeof text !== 'string' || text.trim() === '') {
      return res.status(400).json({ error: 'text must be a non-empty string' });
    }
    if (!tts) {
      return res.status(503).json({ error: 'speech is not configured' });
    }
    try {
      const { audio, mimeType } = await tts.synthesize(text);
      res.status(200).type(mimeType).send(audio);
    } catch (_) {
      // Calm, generic — same posture as responseEngine.js's toCalmError:
      // never forward the underlying error, provider name, or endpoint.
      res.status(502).json({ error: 'gaia could not speak right now' });
    }
  });

  // Calm JSON error surface — no stack traces, no provider names.
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'request body must be valid JSON' });
    }
    return res.status(500).json({ error: 'something went wrong' });
  });

  return app;
}

// Split so tests can inject env without touching process.env.
function loadSoulWithEnv(env) {
  if (env.SOUL_PATH !== undefined && env !== process.env) {
    const previous = process.env.SOUL_PATH;
    if (env.SOUL_PATH) process.env.SOUL_PATH = env.SOUL_PATH;
    try {
      return loadSoul();
    } finally {
      if (previous === undefined) delete process.env.SOUL_PATH;
      else process.env.SOUL_PATH = previous;
    }
  }
  return loadSoul();
}

// Same pattern as loadSoulWithEnv, for foundation-artifact.json.
function loadFoundationDocumentsWithEnv(env) {
  if (env.FOUNDATION_ARTIFACT_PATH !== undefined && env !== process.env) {
    const previous = process.env.FOUNDATION_ARTIFACT_PATH;
    if (env.FOUNDATION_ARTIFACT_PATH) process.env.FOUNDATION_ARTIFACT_PATH = env.FOUNDATION_ARTIFACT_PATH;
    try {
      return loadFoundationDocuments();
    } finally {
      if (previous === undefined) delete process.env.FOUNDATION_ARTIFACT_PATH;
      else process.env.FOUNDATION_ARTIFACT_PATH = previous;
    }
  }
  return loadFoundationDocuments();
}

if (require.main === module) {
  const app = createApp();
  app.listen(PORT, () => {
    console.log(`Gaia API listening on :${PORT}`);
  });
}

module.exports = { createApp, PORT };
