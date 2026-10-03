'use strict';

/**
 * The Gaia API — where first-class clients reach Gaia.
 *
 * Contract (kept in lockstep with the desktop's `conversation/turn` seam):
 *   GET  /health             → { ok: true, soulVersion: string }
 *   GET  /soul               → { version: string }   (identity version only)
 *   POST /conversation/turn  → { reply: string }     (auth required, Desktop's exact contract; optional { attachmentIds: [...] } inlines library files as context)
 *   POST /conversation/turn  → SSE stream            (auth required; { ..., stream: true } — Phase B, docs/web-migration-plan.md)
 *   /admin/*                 → operator-only provider/TTS config + Logos decision log (adminRoutes.js) — never part of any client's contract
 *   /library/*               → file library: upload/list/download/delete (libraryRoutes.js), auth required
 *   /conversations/*         → chat history: list/read/delete (historyRoutes.js), auth required — written as a
 *                              fire-and-forget side effect of a successful /conversation/turn, never by direct upload
 *   POST /speech             → audio/*             (auth required; { text } → Gaia's voice, src/speech/mimoTts.js or
 *                              src/speech/mistralTts.js per the TTS provider — presentation-only, always *after* a text
 *                              reply exists, never part of the Decision Engine)
 *   GET  /speech/info        → voice description    (auth required; { configured, provider, languages } — so clients
 *                              know whether a non-English reply is worth speaking; judges no text)
 *
 * Everything cognitive lives here or behind generation (Gaia's own
 * configured primary/backup inference providers —
 * src/generation/gaiaGenerator.js + generationFailover.js, resolved per
 * turn via `generator`/`backupGenerator`); clients send plain turns and
 * render plain replies. Model-agnostic by construction: the reply shape
 * carries no provider information whatsoever. The live turn is direct
 * generation only — no Decision Engine, no orchestration in this path
 * (server.js only constructs and hands over what is available).
 */
const express = require('express');
const { parseTokens, createAuthMiddleware } = require('./auth');
const { createHermesClient } = require('./hermesClient');
const { createHindsightClient } = require('./hindsightClient');
const { createHindsightHypothesisAdapter } = require('./reasoning/hindsightHypothesisAdapter');
const { createHypothesisManager } = require('./reasoning/hypothesisManager');
const { createHindsightPatternAdapter } = require('./reasoning/hindsightPatternAdapter');
const { createHindsightCognitionAdapter } = require('./reasoning/hindsightCognitionAdapter');
const { createPatternManager } = require('./reasoning/patternManager');
const { createFromEnv: createNativeGeneratorFromEnv } = require('./generation/gaiaGenerator');
const { createFromEnv: createTtsFromEnv } = require('./speech/mimoTts');
const { performTurn, performStreamingTurn } = require('./turn');
const { loadSoul } = require('./soul');
const { loadFoundationDocuments } = require('./foundation');
const { createAdminRouter } = require('./adminRoutes');
const { createProviderStore } = require('./providerStore');
const { resolveRoleConfig, resolveBackupConfig, resolveTtsConfig } = require('./providerConfigResolver');
const { createChronicleClient } = require('./chronicleClient');
const { createLibraryStore, resolveAttachmentsForPrompt } = require('./library');
const { createLibraryRouter } = require('./libraryRoutes');
const { createConversationStore } = require('./conversationStore');
const { createHistoryRouter } = require('./historyRoutes');
const { createDecisionStore } = require('./logos/decisionStore');
const { createTtsLog } = require('./speech/ttsLog');
const { createIntentModelStore } = require('./logos/intentModelStore');
const { getUserIdentity } = require('./identity');
const { createVersionRouter } = require('./versionRoutes');

const PORT = Number(process.env.PORT || 8891);

function createApp(env = process.env) {
  const soul = loadSoulWithEnv(env);
  const documents = loadFoundationDocumentsWithEnv(env);
  // Hermes stays constructed for explicit future HADES use only — it is
  // never passed into the live turn and never an inference fallback.
  const hermes = createHermesClient({
    baseUrl: env.HERMES_BASE_URL,
    model: env.HERMES_MODEL || 'hermes-agent',
    authToken: env.HERMES_AUTH_TOKEN,
  });
  void hermes;
  const hindsight = createHindsightClient({
    baseUrl: env.HINDSIGHT_URL || 'http://100.65.0.15:8888',
    bankId: env.HINDSIGHT_BANK_ID || 'bojan',
    budget: env.HINDSIGHT_RECALL_BUDGET || 'mid',
  });
  // Hypothesis Persistence 0.1 — Logos's structured hypotheses persist
  // as retained world-facts (tag gaia:hypothesis) through
  // HypothesisManager's policy into Hindsight via the thin adapter. Boot
  // loads the currently-active hypotheses once, lazily, best-effort; every
  // failure is logged and never blocks a turn. Disable with
  // GAIA_HYPOTHESIS_PERSISTENCE=false.
  let hypothesisRuntime = null;
  if ((env.GAIA_HYPOTHESIS_PERSISTENCE || 'true') !== 'false') {
    const hypothesisAdapter = createHindsightHypothesisAdapter({ client: hindsight });
    const hypothesisManager = createHypothesisManager({ sink: hypothesisAdapter.sink });
    // Logos pattern formation over DURABLE hypotheses, persisted
    // via the same principles (gaia:pattern world-facts). Gated: only runs
    // when a durable hypothesis actually changed during a turn.
    const patternAdapter = createHindsightPatternAdapter({ client: hindsight });
    const patternManager = createPatternManager({ sink: patternAdapter.sink });
    let loadedPromise = null;
    hypothesisRuntime = {
      manager: hypothesisManager,
      recallHypotheses: (query) => hypothesisAdapter.recallHypotheses(query),
      // Pattern Awareness 0.1 — per-turn scoped pattern recall through the
      // same adapter that persists patterns (turn.js gates the call on
      // IntentIQ signals; the Decision Engine owns whatever happens next).
      recallPatterns: (query) => patternAdapter.recallPatterns(query),
      patternManager,
      // Cognitive Analysis Model v1.0 — durable observations/open questions
      // persist as ordinary Hindsight world facts (no second store; see
      // reasoning/hindsightCognitionAdapter.js).
      cognition: createHindsightCognitionAdapter({ client: hindsight }),
      ensureLoaded: () => {
        if (!loadedPromise) {
          loadedPromise = Promise.all([
            hypothesisAdapter.loadActiveHypotheses(),
            patternAdapter.loadActivePatterns().catch(() => []),
          ])
            .then(([hypotheses, patterns]) => {
              hypothesisManager.seed(hypotheses);
              patternManager.seed(patterns);
            })
            .catch((err) => {
              console.warn(`[gaia:hypotheses] boot load failed (non-fatal): ${err.message}`);
            });
        }
        return loadedPromise;
      },
    };
  }
  // Durable Logos decision log (adminRoutes.js's
  // /admin/api/logos/decisions) — created here, ahead of the native
  // generator below, so its sink can also capture kind 'llm.call' records:
  // every actual LLM HTTP call the native generator makes, not just the
  // decision each one eventually reaches (a background Logos reflection
  // can be reached without a model call at all — shallow reflection — so
  // the two are genuinely different observability questions).
  const decisionStore = createDecisionStore(
    env.LOGOS_DECISIONS_PATH !== undefined ? { decisionsDir: env.LOGOS_DECISIONS_PATH } : {}
  );
  const llmCallLogger = (line) => {
    console.log(line);
    try {
      decisionStore.append(JSON.parse(line));
    } catch (_) {
      // Never let observability persistence affect a real call.
    }
  };

  // Gaia's native voice (src/generation/gaiaGenerator.js) — undefined when
  // GAIA_NATIVE_BASE_URL/GAIA_NATIVE_MODEL are unset, in which case the
  // Decision Engine never sees a "native" capability and every turn routes
  // through Hermes exactly as before this existed (see .env.example).
  // Provider store may override env vars when role selections exist.
  // `llmCallLogger` is bound here (not threaded per-call like Logos's
  // background reflection) because this client is a singleton invoked from
  // orchestrator.js, which has no per-turn logger in scope.
  const nativeGenerator = createNativeGeneratorFromEnv(env, llmCallLogger);
  // Gaia's voice (src/speech/mimoTts.js, src/speech/mistralTts.js) —
  // undefined when GAIA_TTS_BASE_URL/GAIA_TTS_MODEL are unset, in which
  // case POST /speech answers 503 rather than attempting a call with
  // nothing configured. Entirely
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

  const providerStore = createProviderStore(
    env.GAIA_PROVIDER_CONFIG_PATH !== undefined ? { storePath: env.GAIA_PROVIDER_CONFIG_PATH } : {}
  );
  const intentModelStore = createIntentModelStore(
    env.INTENTIQ_CONFIG_PATH !== undefined ? { storePath: env.INTENTIQ_CONFIG_PATH } : {}
  );
  // Voice activity tail for the admin surface (GET /admin/api/tts/log) —
  // in-memory by design: a restart clears it, same as a fresh pair of
  // ears on the next shift.
  const ttsLog = createTtsLog();
  app.use('/admin', createAdminRouter({ providerStore, decisionStore, intentModelStore, auth, ttsLog }));

  // v3.0: no live IntentIQ — Logos reflects after delivery. The intent
  // model store stays for the admin surface only.

  // Provider store role overrides — when a role has a model selected via
  // the admin surface, it takes precedence over env vars. This is
  // backwards-compatible: env vars remain the fallback when no provider
  // store config exists.
  //
  // Resolved fresh on every call (not once at startup): providerStore's
  // config can change at any time via the admin panel, and a value
  // computed once here at boot would keep serving the OLD provider/model
  // until the process restarted — confirmed live: clearing an override
  // through /admin/api/provider/roles updated the persisted config
  // immediately, but the running server kept calling the stale provider
  // until `docker restart`. createGaiaGenerator/createMimoTts are cheap,
  // I/O-free constructors, so re-resolving per turn/request costs nothing.
  function getEffectiveNativeGenerator() {
    const providerNativeConfig = resolveRoleConfig('generation', providerStore, env);
    return providerNativeConfig && providerNativeConfig.baseUrl && providerNativeConfig.model
      ? require('./generation/gaiaGenerator').createGaiaGenerator({
          baseUrl: providerNativeConfig.baseUrl,
          model: providerNativeConfig.model,
          authToken: providerNativeConfig.apiKey,
          logger: llmCallLogger,
        })
      : nativeGenerator;
  }

  // Backup inference provider (v3.0 failover): the independently stored
  // backup config first, GAIA_BACKUP_* env vars as fallback. A plain
  // inference provider — never Hermes, never tools, never memory.
  // Re-resolved per turn like the primary above so admin changes apply
  // without a restart.
  function getEffectiveBackupGenerator() {
    const backupConfig = resolveBackupConfig(providerStore, env);
    return backupConfig && backupConfig.baseUrl && backupConfig.model
      ? require('./generation/gaiaGenerator').createGaiaGenerator({
          baseUrl: backupConfig.baseUrl,
          model: backupConfig.model,
          authToken: backupConfig.apiKey,
          logger: llmCallLogger,
        })
      : undefined;
  }

  // Chronicle archive (v3.0 source of truth): completed turns register
  // here with status `observation`, fire-and-forget after delivery.
  const chronicle = createChronicleClient({ env });

  function getEffectiveTts() {
    const providerTtsConfig = resolveTtsConfig(providerStore, env);
    // The resolved config travels with the client so POST /speech can log
    // *what* it spoke with (provider/model/voice) without re-resolving.
    if (!providerTtsConfig || !providerTtsConfig.baseUrl || !providerTtsConfig.model) {
      return { tts, config: providerTtsConfig };
    }
    // Mistral speaks its own protocol (POST {base}/audio/speech, base64
    // JSON) — everything else stays on the MiMo client, which is also what
    // the pre-provider 'env' fallback resolves to. Unknown provider values
    // fall through to MiMo rather than 503: a stored baseUrl/model pair is
    // a configured voice until proven otherwise.
    if (providerTtsConfig.provider === 'mistral') {
      return {
        tts: require('./speech/mistralTts').createMistralTts({
          baseUrl: providerTtsConfig.baseUrl,
          model: providerTtsConfig.model,
          authToken: providerTtsConfig.apiKey,
          voiceId: providerTtsConfig.voiceId,
          format: env.GAIA_TTS_FORMAT,
        }),
        config: providerTtsConfig,
      };
    }
    return {
      tts: require('./speech/mimoTts').createMimoTts({
        baseUrl: providerTtsConfig.baseUrl,
        model: providerTtsConfig.model,
        authToken: providerTtsConfig.apiKey,
      }),
      config: providerTtsConfig,
    };
  }

  /**
   * Languages the configured TTS voice can pronounce, for clients that
   * gate *whether* to speak (the desktop stays silent on Dutch while the
   * voice is MiMo-only). Read from the provider, never the text — this
   * endpoint judges no reply, it only describes the voice.
   * @param {string} [provider]
   * @returns {string[]}
   */
  function languagesForTtsProvider(provider) {
    if (provider === 'mistral') return require('./speech/mistralTts').LANGUAGES;
    if (provider === 'xiaomi' || provider === 'env') return require('./speech/mimoTts').LANGUAGES;
    return ['en'];
  }

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

  // Version endpoint - public, no auth required
  app.use('/api', createVersionRouter());

  // v3.0: no live tools. conversation_search / hindsight-retrieval /
  // foundation-search stay available as modules for explicit future
  // HADES use, but nothing registers them into the live turn — the turn
  // is direct generation with policy-gated Hindsight recall only.

  app.post('/conversation/turn', auth, async (req, res) => {
    const messages = req.body && req.body.messages;
    const conversationId = req.body && req.body.conversationId;
    const attachmentIds = (req.body && req.body.attachmentIds) || [];
    const traceId = `trace-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // Conversation identity: Gaia ↔ User (Bojan for dev, dynamic for multi-user)
    const userIdentity = getUserIdentity({ req, displayName: req.body && req.body.userDisplayName });
    const userDisplayName = userIdentity.displayName;

    // STAGE 1: Log incoming turn request
    console.log(JSON.stringify({
      kind: 'vision.trace',
      traceId,
      stage: 'turn_input',
      hasMessages: !!messages,
      messageCount: messages ? messages.length : 0,
      attachmentIds: attachmentIds,
      attachmentCount: attachmentIds.length,
      hasConversationId: !!conversationId,
    }));

    if (req.body && req.body.stream) {
      // PATCH: Resolve attachments for streaming path too
      const modelSupportsVision = env.GAIA_NATIVE_SUPPORTS_VISION === 'true' || false;
      const resolvedAttachments = await resolveAttachmentsForPrompt(libraryStore, attachmentIds, { modelSupportsVision });
      
      // STAGE 2: Log resolved attachments for streaming
      console.log(JSON.stringify({
        kind: 'vision.trace',
        traceId,
        stage: 'resolution_streaming',
        modelSupportsVision,
        attachmentIds,
        resolvedCount: resolvedAttachments.length,
        resolvedAttachments: resolvedAttachments.map((a) => ({
          filename: a.filename,
          hasImageBytes: !!a.imageBytes,
          imageBytesLength: a.imageBytes ? a.imageBytes.length : 0,
          imageMimeType: a.imageMimeType || null,
          hasContent: !!a.content,
        })),
      }));

      await performStreamingTurn({
        messages,
        documents,
        hindsight,
        hypothesisRuntime,
        chronicle,
        res,
        conversationId,
        generator: getEffectiveNativeGenerator(),
        backupGenerator: getEffectiveBackupGenerator(),
        historyStore,
        decisionStore,
        attachments: resolvedAttachments,
        traceId,
        userDisplayName,
      });
      return;
    }

    // PATCH: Determine if model supports vision
    // Option 1: Explicit env var GAIA_NATIVE_SUPPORTS_VISION
    // Option 2: Auto-detect from native generator presence (fallback to false)
    const modelSupportsVision = env.GAIA_NATIVE_SUPPORTS_VISION === 'true' || false;
    
    const attachments = await resolveAttachmentsForPrompt(libraryStore, attachmentIds, { modelSupportsVision });
    
    // STAGE 2: Log resolved attachments
    console.log(JSON.stringify({
      kind: 'vision.trace',
      traceId,
      stage: 'resolution',
      modelSupportsVision,
      attachmentIds,
      resolvedCount: attachments.length,
      resolvedAttachments: attachments.map((a) => ({
        filename: a.filename,
        hasImageBytes: !!a.imageBytes,
        imageBytesLength: a.imageBytes ? a.imageBytes.length : 0,
        imageMimeType: a.imageMimeType || null,
        hasContent: !!a.content,
      })),
    }));

    // v3.0 LIVE PATH: direct generation (primary → backup failover) via
    // the shared runTurnCore pipeline. Only delivery differs: one JSON
    // body instead of SSE. Chat history stays a fire-and-forget save in
    // this handler after the response, mirroring performStreamingTurn's
    // inline save.
    const result = await performTurn({
      messages,
      documents,
      hindsight,
      hypothesisRuntime,
      chronicle,
      attachments,
      generator: getEffectiveNativeGenerator(),
      backupGenerator: getEffectiveBackupGenerator(),
      traceId,
      conversationId,
      decisionStore,
      userDisplayName,
    });
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
  // run IntentIQ/the Decision Engine/Orchestrator/Response Engine
  // at all, by construction (it never imports any of them).
  // Gaia's voice info — which provider backs POST /speech and which
  // languages it pronounces, so clients can decide *whether* to speak a
  // given reply (Dutch stays silent on a MiMo-only voice). Describes the
  // voice, never judges text: no request body, no language detection here.
  app.get('/speech/info', auth, (req, res) => {
    const providerTtsConfig = resolveTtsConfig(providerStore, env);
    const configured = Boolean(
      providerTtsConfig && providerTtsConfig.baseUrl && providerTtsConfig.model
    ) || Boolean(tts);
    const provider = providerTtsConfig ? providerTtsConfig.provider : null;
    res.json({ configured, provider, languages: languagesForTtsProvider(provider) });
  });

  app.post('/speech', auth, async (req, res) => {
    const text = req.body && req.body.text;
    if (typeof text !== 'string' || text.trim() === '') {
      return res.status(400).json({ error: 'text must be a non-empty string' });
    }
    const { tts: effectiveTts, config: ttsConfig } = getEffectiveTts();
    // Operator diagnostics (GET /admin/api/tts/log): what the voice
    // attempted, with what, and how it ended. Clients never see this —
    // they keep the calm wording below — but "she doesn't speak" without
    // it is undebuggable.
    const logBase = {
      provider: ttsConfig ? ttsConfig.provider : null,
      model: ttsConfig ? ttsConfig.model : null,
      voiceId: (ttsConfig && ttsConfig.voiceId) || '',
      chars: text.trim().length,
      preview: String(text).slice(0, 80),
    };
    if (!effectiveTts) {
      ttsLog.record({ ...logBase, outcome: 'not-configured', error: 'speech is not configured', status: 503, durationMs: 0 });
      return res.status(503).json({ error: 'speech is not configured' });
    }
    const ttsStart = process.hrtime.bigint();
    try {
      const ttsTraceId = `tts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const { audio, mimeType } = await effectiveTts.synthesize(text);
      const ttsDurationMs = Number(process.hrtime.bigint() - ttsStart) / 1e6;
      try {
        console.log(JSON.stringify({
          kind: 'gaia.timing',
          traceId: ttsTraceId,
          stage: 'tts.done',
          durationMs: Math.round(ttsDurationMs * 100) / 100,
        }));
      } catch (_) { /* never break a turn */ }
      ttsLog.record({ ...logBase, outcome: 'ok', error: null, status: 200, durationMs: Math.round(ttsDurationMs * 100) / 100 });
      res.status(200).type(mimeType).send(audio);
    } catch (_) {
      // Calm, generic — same posture as responseEngine.js's toCalmError:
      // never forward the underlying error, provider name, or endpoint.
      const ttsDurationMs = Number(process.hrtime.bigint() - ttsStart) / 1e6;
      ttsLog.record({ ...logBase, outcome: 'error', error: 'gaia could not speak right now', status: 502, durationMs: Math.round(ttsDurationMs * 100) / 100 });
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
