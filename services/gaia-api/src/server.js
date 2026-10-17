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
 *   /conversations/*         → chat history: list/read/search/delete (historyRoutes.js), auth required — written as a
 *                              fire-and-forget side effect of a successful /conversation/turn, never by direct upload
 *   /desktop/*               → confirmation flow for the `desktop` capability (desktopRoutes.js), auth required
 *   /eleos/*                 → Gaia-initiated check-ins: pending + delivered loops (eleosRoutes.js), auth required —
 *                              the poll counterpart to research jobs; the check-in itself is an ordinary assistant
 *                              message in a server-started conversation
 *   POST /speech             → audio/*             (auth required; { text } → Gaia's voice, src/speech/mimoTts.js or
 *                              src/speech/mistralTts.js per the TTS provider — presentation-only, always *after* a text
 *                              reply exists, never a turn decision)
 *   POST /speech/transcribe  → { text, language }  (auth required; one utterance of audio in the request body -> text,
 *                              src/speech/mistralStt.js — an input transport only: the client sends the text as an ordinary turn)
 *   GET  /speech/stt-info    → { configured, provider, languages, maxBytes }  (auth required)
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
const { createHindsightClient, createCrossBankRecallClient } = require('./hindsightClient');
const { createHindsightHypothesisAdapter } = require('./reasoning/hindsightHypothesisAdapter');
const { createHypothesisManager } = require('./reasoning/hypothesisManager');
const { createHindsightPatternAdapter } = require('./reasoning/hindsightPatternAdapter');
const { createCognitionClient } = require('./cognitionClient');
const { createCognitionSync } = require('./reasoning/cognitionSync');
const { createCognitionSink } = require('./reasoning/cognitionSink');
const { createSoftPromotionScan } = require('./reasoning/softPromotionScan');
const { createExpiryScan } = require('./reasoning/expiryScan');
const { readReachPolicy } = require('./reasoning/openQuestionReach');
const { createCognitionKnowledgeAdapter } = require('./reasoning/cognitionKnowledgeAdapter');
const { createAionWriter } = require('./reasoning/aion');
const { createAionScheduler } = require('./reasoning/aionScheduler');
const { createMemoryTool } = require('./reasoning/memoryTool');
const { createMemoryRouter } = require('./memoryRoutes');
const { createWebSearchTool } = require('./reasoning/webSearchTool');
const { createWebSearchFromEnv } = require('./webSearchClient');
const { createLogosModelClient, readLogosTimeoutMs } = require('./logos/logosModelClient');
const { createCognitionRouter } = require('./cognitionRoutes');
const { createKairosRouter } = require('./kairosRoutes');
const { createKairosRuntime } = require('./kairos/runtime');
const { createPatternManager } = require('./reasoning/patternManager');
const { createFromEnv: createNativeGeneratorFromEnv } = require('./generation/gaiaGenerator');
const { createFromEnv: createTtsFromEnv } = require('./speech/mimoTts');
const { performTurn, performStreamingTurn } = require('./turn');
const { loadSoul } = require('./soul');
const { loadFoundationDocuments } = require('./foundation');
const { createAdminRouter } = require('./adminRoutes');
const { createProviderStore } = require('./providerStore');
const { resolveRoleConfig, resolveBackupConfig, resolveTtsConfig, resolveSttConfig } = require('./providerConfigResolver');
const { createFromEnv: createFoundationFromEnv } = require('./foundationClient');
const { createLibraryStore, resolveAttachmentsForPrompt } = require('./library');
const { createLibraryRouter } = require('./libraryRoutes');
const { createConversationStore } = require('./conversationStore');
const { generateConversationTitle } = require('./conversationTitle');
const { createConversationSearch } = require('./conversationSearch');
const { createEleosIntentStore } = require('./eleosIntentStore');
const { createEleosPass } = require('./reasoning/eleos');
const { createEleosVoice } = require('./eleosVoice');
const { createEleosRuntime } = require('./eleosRuntime');
const { createEleos } = require('./eleos');
const { createEleosRouter } = require('./eleosRoutes');
const { createDesktopBroker } = require('./desktopBroker');
const { createDesktopRouter } = require('./desktopRoutes');
const { generateWithFailover } = require('./generation/generationFailover');
const { createResearchJobStore } = require('./researchJobStore');
const { startResearchJob, pollResearchJobs, saveResearchMessage, saveResearchCheckin, answerJobApproval, resolveOutboxDir } = require('./researchJob');
const { createResearchRouter } = require('./researchRoutes');
const { HERMES_OUTBOX_DIR } = require('./researchReach');
const { createHistoryRouter } = require('./historyRoutes');
const { createDecisionStore } = require('./logos/decisionStore');
const { createTtsLog } = require('./speech/ttsLog');
const { createSttLog } = require('./speech/sttLog');
const mistralStt = require('./speech/mistralStt');
const { getUserIdentity } = require('./identity');
const { createVersionRouter } = require('./versionRoutes');

const PORT = Number(process.env.PORT || 8891);

function createApp(env = process.env) {
  const soul = loadSoulWithEnv(env);
  const documents = loadFoundationDocumentsWithEnv(env);
  // Hermes is handed exactly ONE thing: a research run, where Gaia names a
  // routing skill and Hermes loads and runs it in the background
  // (src/researchReach.js + src/researchJob.js, wired further down). It is
  // still never the generator and never an inference fallback — which is also
  // why it never travels as `hermes` into the turn: a `hermes` client becomes
  // the generator whenever nothing else is configured.
  const hermes = createHermesClient({
    baseUrl: env.HERMES_BASE_URL,
    model: env.HERMES_MODEL || 'hermes-agent',
    authToken: env.HERMES_AUTH_TOKEN,
  });

  const hindsightUrl = env.HINDSIGHT_URL || 'http://100.65.0.15:8888';
  const hindsightBudget = env.HINDSIGHT_RECALL_BUDGET || 'mid';
  // Cap on every Hindsight call this service makes (recall, mental models,
  // knowledge pages). A per-bank safety cap, NOT a latency target — a call
  // returns as soon as it is done; this only stops a hung one. Raise it for
  // headroom (e.g. 8000) so a slow bank is not dropped on a spiky turn.
  // Unset ⇒ the client default (4000 ms).
  const hindsightTimeoutMs = Number(env.HINDSIGHT_TIMEOUT_MS) > 0 ? Number(env.HINDSIGHT_TIMEOUT_MS) : undefined;
  // The system-memory bank: the memoryworthiness-gated conversation
  // reflection still writes here, unchanged. The gate lives in turn.js.
  const hindsightBankId = env.HINDSIGHT_BANK_ID || 'bojan';
  // Gaia's OWN bank — her memories, her human side. Hers alone, no gate; the
  // write path for her own curation is not built yet, so today it is a
  // recall-only source. Read here so a memory she later places there is
  // surfaceable from the start.
  const hindsightOwnBankId = env.HINDSIGHT_OWN_BANK_ID || 'gaia';
  // The derived-knowledge bank: the Cognition → Hindsight mirror (hypotheses,
  // patterns, Kairos episodes) that Logos forms.
  const hindsightLogosBankId = env.HINDSIGHT_LOGOS_BANK_ID || 'gaia-logos';
  const hindsightApp = createHindsightClient({
    baseUrl: hindsightUrl,
    bankId: hindsightBankId,
    budget: hindsightBudget,
    timeoutMs: hindsightTimeoutMs,
  });
  const hindsightLogos = createHindsightClient({
    baseUrl: hindsightUrl,
    bankId: hindsightLogosBankId,
    budget: hindsightBudget,
    timeoutMs: hindsightTimeoutMs,
  });
  // Gaia's own bank client — a recall source today, and the write target of
  // the Aion pass (see getEffectiveAionWriter below).
  const hindsightOwn = createHindsightClient({
    baseUrl: hindsightUrl,
    bankId: hindsightOwnBankId,
    budget: hindsightBudget,
    timeoutMs: hindsightTimeoutMs,
  });
  // The banks Gaia recalls over: the system memory, the derived knowledge, and
  // her own bank — so a derived statement or one of her own memories is as
  // surfaceable as a raw memory of Bo's. `HINDSIGHT_RECALL_BANK_IDS` overrides
  // the set; the app bank is always the primary (every non-recall method stays
  // on it).
  const recallBankIds = String(
    env.HINDSIGHT_RECALL_BANK_IDS
      || `${hindsightBankId},${hindsightLogosBankId},${hindsightOwnBankId}`
  ).split(',').map((id) => id.trim()).filter(Boolean);
  const recallClients = [];
  const seenRecallBanks = new Set();
  for (const id of recallBankIds) {
    if (seenRecallBanks.has(id)) continue;
    seenRecallBanks.add(id);
    if (id === hindsightBankId) recallClients.push(hindsightApp);
    else if (id === hindsightLogosBankId) recallClients.push(hindsightLogos);
    else if (id === hindsightOwnBankId) recallClients.push(hindsightOwn);
    else recallClients.push(createHindsightClient({ baseUrl: hindsightUrl, bankId: id, budget: hindsightBudget, timeoutMs: hindsightTimeoutMs }));
  }
  const hindsight = createCrossBankRecallClient(
    hindsightApp,
    ...recallClients.filter((client) => client !== hindsightApp)
  );
  // The SHALLOW live lookup — a sibling of the research job, never a
  // replacement for it. Configured provider or no tool at all: the
  // `web_search` capability is derived from the tool's presence, so she is
  // never told she can look something up when she cannot. Off with
  // GAIA_WEB_SEARCH_API_KEY unset.
  const webSearch = createWebSearchFromEnv(env);
  const webSearchTool = webSearch ? createWebSearchTool({ search: webSearch }) : null;

  // Cognition (derived-knowledge store + lifecycle owner) and its Hindsight
  // mirror — created unconditionally so the GaiaChat review surface works even
  // when per-turn hypothesis persistence is disabled.
  const cognition = createCognitionClient({
    baseUrl: env.COGNITION_URL || undefined,
    bankId: env.COGNITION_BANK_ID || undefined,
  });
  const cognitionSync = createCognitionSync({ hindsight: hindsightLogos, cognition });

  // On-demand memory: the tools Gaia may call during a turn. `remember`
  // writes to the shared system-memory bank (`bojan`); `keep` writes to HER
  // own bank (`gaia`) — the explicit, in-conversation counterpart to Aion.
  // `search_memory` reads back through the SAME cross-bank client the turn's
  // gated recall uses, so her on-demand lookup spans every recall bank.
  // `retract_memory` takes a memory back when the person says it is not true:
  // it needs the banks themselves (to find the unit and patch the store that
  // holds it) and Cognition plus its mirror (to retire the derived statement
  // the memory came from, so it cannot be written back into recall). Built
  // here rather than beside the other clients above because of that second
  // dependency — a tool handed a client that does not exist yet is a crash,
  // not a degraded tool.
  // Off with GAIA_MEMORY_TOOL=false.
  //
  // The bank list and the "home" bank (where a person's correction is kept)
  // are named here because two callers need the same wiring — the
  // in-conversation `retract_memory` tool and the HTTP route behind the
  // clients' "dit klopt niet" button (memoryRoutes.js).
  const memoryBanks = [
    { name: hindsightBankId, client: hindsightApp },
    { name: hindsightLogosBankId, client: hindsightLogos },
    { name: hindsightOwnBankId, client: hindsightOwn },
  ];
  const memoryHome = { name: hindsightBankId, client: hindsightApp };
  const memoryTool = env.GAIA_MEMORY_TOOL === 'false'
    ? null
    : createMemoryTool({
      hindsight: hindsightApp,
      ownHindsight: hindsightOwn,
      searchHindsight: hindsight,
      banks: memoryBanks,
      home: memoryHome,
      cognition,
      sync: cognitionSync,
    });

  // One option bag for the generator, whatever combination of tools exists.
  // The dispatcher routes by name and falls through on the codebase's own
  // 'Unknown action.' convention (see generation/gaiaGenerator.js), so adding
  // another tool later stays a one-line change.
  const toolParts = [memoryTool, webSearchTool].filter(Boolean);
  const toolOptions = toolParts.length === 0 ? {} : {
    tools: toolParts.flatMap((tool) => tool.TOOLS),
    onToolCall: async (name, args) => {
      for (const tool of toolParts) {
        const result = await tool.onToolCall(name, args);
        if (result !== 'Unknown action.') return result;
      }
      return 'Unknown action.';
    },
  };
  // Foundation (raw-observation source of truth): Gaia reads it for
  // archive-shaped asks and carries completed turns / observations back into
  // its stream. Undefined when FOUNDATION_URL is unset — every caller falls
  // through silently.
  const foundation = createFoundationFromEnv(env);
  // Hypothesis Persistence 0.1 — Logos's structured hypotheses persist to
  // Cognition (the lifecycle owner) and mirror into Hindsight via cognitionSync.
  // Boot loads the currently-active hypotheses once, lazily, best-effort; every
  // failure is logged and never blocks a turn. Disable with
  // GAIA_HYPOTHESIS_PERSISTENCE=false.
  let hypothesisRuntime = null;
  let softPromotionScan = null;
  let expiryScan = null;
  if ((env.GAIA_HYPOTHESIS_PERSISTENCE || 'true') !== 'false') {
    const cognitionSink = createCognitionSink({ cognition, sync: cognitionSync });

    // Read adapters (Hindsight) — recall/load only; their sinks are retired.
    // They read the derived-knowledge bank, matching where cognitionSync writes.
    const hypothesisAdapter = createHindsightHypothesisAdapter({ client: hindsightLogos });
    const hypothesisManager = createHypothesisManager({ sink: cognitionSink.hypothesis });
    // Logos pattern formation over DURABLE hypotheses — persisted to Cognition
    // (the read side still reconstructs patterns from Hindsight).
    const patternAdapter = createHindsightPatternAdapter({ client: hindsightLogos });
    const patternManager = createPatternManager({ sink: cognitionSink.pattern });
    let loadedPromise = null;
    hypothesisRuntime = {
      manager: hypothesisManager,
      recallHypotheses: (query) => hypothesisAdapter.recallHypotheses(query),
      // Pattern Awareness 0.1 — per-turn scoped pattern recall through the
      // same adapter that persists patterns (turn.js gates the call on
      // IntentIQ signals and owns whatever happens next).
      recallPatterns: (query) => patternAdapter.recallPatterns(query),
      patternManager,
      // Cognitive Analysis Model v1.0 — observations go to Foundation's
      // ingest gateway; open questions and relationships go to Cognition
      // (kinds open_question / relationship), mirrored to Hindsight.
      cognition: createCognitionKnowledgeAdapter({ cognition, sync: cognitionSync, foundation }),
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

    // v1.4 — Gaia may bring one of her own unanswered questions up. This is the
    // only place she speaks first, so it is off unless the person asks for it:
    // the seam carries the restraint (one per turn, its own conversation first,
    // never more than three times, a retry term in between) so a turn that is
    // switched off costs nothing and behaves exactly as before.
    if (env.GAIA_OPEN_QUESTION_REACH === 'on') {
      hypothesisRuntime.openQuestions = {
        list: () => cognition.listHypotheses({ kind: 'open_question' }),
        markRaised: (id) => cognition.markQuestionRaised(id),
        policy: readReachPolicy(env),
      };
    }

    // The periodic catch-up for the machine tier: hypotheses the store holds
    // whose micro soft-promotion no turn will ever trigger again (see
    // reasoning/softPromotionScan.js). Best-effort, never blocks a turn;
    // stopped again on shutdown below.
    softPromotionScan = createSoftPromotionScan({
      cognition,
      sink: cognitionSink.hypothesis,
      env,
    });

    // The expiry pass: a hypothesis that never gathered evidence, and that
    // nothing has touched for the term, lapses (see reasoning/expiryScan.js).
    // Same posture as the scan above — best-effort, never blocks a turn.
    expiryScan = createExpiryScan({
      cognition,
      sink: cognitionSink.hypothesis,
      env,
    });
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
  // GAIA_NATIVE_BASE_URL/GAIA_NATIVE_MODEL are unset, in which case a live
  // turn answers a calm 503 rather than falling back to Hermes (see
  // .env.example). Provider store may override env vars when role
  // selections exist. `llmCallLogger` is bound here (not threaded per-call
  // like Logos's background reflection) because this client is a singleton
  // with no per-turn logger in scope.
  const nativeGenerator = createNativeGeneratorFromEnv(env, llmCallLogger, toolOptions);
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
  // Voice activity tail for the admin surface (GET /admin/api/tts/log) —
  // in-memory by design: a restart clears it, same as a fresh pair of
  // ears on the next shift.
  const ttsLog = createTtsLog();
  // Listening activity tail (GET /admin/api/stt/log) — never carries audio or text.
  const sttLog = createSttLog();
  app.use('/admin', createAdminRouter({ providerStore, decisionStore, auth, ttsLog, sttLog }));

  // v3.0: no live IntentIQ pre-flight — Logos reflects after delivery.

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
          ...toolOptions,
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

  // Aion: Gaia's own-bank write path. A background pass asks her,
  // every few turns (and when a session ends), whether anything from the
  // conversation is hers to keep; what she answers goes to `gaia`, ungated.
  // Uses the `aion` provider role (env fallback: the reasoning role),
  // so it can be pointed at its own model. Off with GAIA_AION=false.
  function getEffectiveAionWriter() {
    if (env.GAIA_AION === 'false') return undefined;
    const roleConfig = resolveRoleConfig('aion', providerStore, env);
    if (!roleConfig || !roleConfig.baseUrl || !roleConfig.model) return undefined;
    const model = createLogosModelClient({ ...roleConfig, timeoutMs: readLogosTimeoutMs(env), logSystem: 'aion', logPurpose: 'aion' });
    return createAionWriter({ model, hindsight: hindsightOwn });
  }

  // The scheduler owns WHEN it runs: every GAIA_AION_EVERY_TURNS
  // turns, plus a flush when the conversation changes or goes idle (the
  // closest thing to an end-of-session signal this service has).
  const aion = env.GAIA_AION === 'false'
    ? undefined
    : createAionScheduler({
        getWriter: getEffectiveAionWriter,
        everyTurns: Number(env.GAIA_AION_EVERY_TURNS) || 5,
        idleMs: env.GAIA_AION_IDLE_MS !== undefined
          ? Number(env.GAIA_AION_IDLE_MS)
          : 5 * 60 * 1000,
      });

  /**
   * The speech-to-text client for the current configuration (provider store,
   * else GAIA_STT_* env), plus the resolved config so POST /speech/transcribe
   * can log which provider/model handled it. `stt` is null when unconfigured.
   */
  function getEffectiveStt() {
    const config = resolveSttConfig(providerStore, env);
    if (!config || !config.baseUrl || !config.model) return { stt: null, config };
    return {
      stt: mistralStt.createMistralStt({
        baseUrl: config.baseUrl,
        model: config.model,
        authToken: config.apiKey,
      }),
      config,
    };
  }

  function getEffectiveTts(language) {
    const providerTtsConfig = resolveTtsConfig(providerStore, env, language);
    // The resolved config travels with the client so POST /speech can log
    // *what* it spoke with (provider/model/voice) without re-resolving.
    // ElevenLabs and Fish Audio need no base URL (they default to their public APIs).
    const needsBaseUrl = !providerTtsConfig || !['elevenlabs', 'fishaudio'].includes(providerTtsConfig.provider);
    if (!providerTtsConfig || (needsBaseUrl && !providerTtsConfig.baseUrl) || !providerTtsConfig.model) {
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
    if (providerTtsConfig.provider === 'fishaudio') {
      return {
        tts: require('./speech/fishAudioTts').createFishAudioTts({
          baseUrl: providerTtsConfig.baseUrl,
          model: providerTtsConfig.model,
          authToken: providerTtsConfig.apiKey,
          voiceId: providerTtsConfig.voiceId,
        }),
        config: providerTtsConfig,
      };
    }
    if (providerTtsConfig.provider === 'elevenlabs') {
      return {
        tts: require('./speech/elevenLabsTts').createElevenLabsTts({
          baseUrl: providerTtsConfig.baseUrl,
          model: providerTtsConfig.model,
          authToken: providerTtsConfig.apiKey,
          voiceId: providerTtsConfig.voiceId,
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
    if (provider === 'elevenlabs') return require('./speech/elevenLabsTts').LANGUAGES;
    if (provider === 'fishaudio') return require('./speech/fishAudioTts').LANGUAGES;
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
  // Literal-text search over the saved transcripts — the read seam behind the
  // `conversation_search` capability (the turn reaches for it on a lookup) and
  // the client's own GET /conversations/search.
  const conversationSearch = createConversationSearch({ store: historyStore });
  app.use('/conversations', createHistoryRouter({ store: historyStore, auth, search: conversationSearch }));

  // ELEOS — the check-in faculty: notice a moment worth coming back to, and
  // later start a new conversation about it. Off unless GAIA_ELEOS=true,
  // because it means Gaia speaks first, unprompted. The write half (the pass)
  // runs after a turn in the deferred phase; the delivery half (the runtime)
  // is a background tick like the research poller. The poll endpoint is
  // mounted unconditionally so a client can always ask (and get empty lists)
  // even while the feature is off.
  const eleosStore = createEleosIntentStore(
    env.GAIA_ELEOS_INTENTS_PATH !== undefined ? { intentsDir: env.GAIA_ELEOS_INTENTS_PATH } : {}
  );
  // Resolve the check-in model lazily — the `eleos` role can change in the
  // admin panel at any time (env fallback: the reasoning role).
  function getEffectiveEleosModel() {
    const roleConfig = resolveRoleConfig('eleos', providerStore, env);
    if (!roleConfig || !roleConfig.baseUrl || !roleConfig.model) return null;
    return createLogosModelClient({
      ...roleConfig,
      timeoutMs: readLogosTimeoutMs(env),
      logSystem: 'eleos',
      logPurpose: 'eleos',
    });
  }
  const eleosVoice = createEleosVoice({
    documents,
    generate: (messages) => generateWithFailover(messages, {
      primary: getEffectiveNativeGenerator(),
      backup: getEffectiveBackupGenerator(),
    }),
  });
  const eleosRuntime = createEleosRuntime({
    store: eleosStore,
    voice: eleosVoice,
    historyStore,
    activeMs: Number(env.GAIA_ELEOS_ACTIVE_MS) || undefined,
    deferMs: Number(env.GAIA_ELEOS_DEFER_MS) || undefined,
    quietStartHour: Number.isFinite(Number(env.GAIA_ELEOS_QUIET_START)) ? Number(env.GAIA_ELEOS_QUIET_START) : undefined,
    quietEndHour: Number.isFinite(Number(env.GAIA_ELEOS_QUIET_END)) ? Number(env.GAIA_ELEOS_QUIET_END) : undefined,
    timezone: env.GAIA_ELEOS_TIMEZONE || undefined,
    maxPerDay: Number.isFinite(Number(env.GAIA_ELEOS_MAX_PER_DAY)) ? Number(env.GAIA_ELEOS_MAX_PER_DAY) : undefined,
    tickMs: Number(env.GAIA_ELEOS_TICK_MS) || undefined,
  });
  const eleos = env.GAIA_ELEOS === 'true'
    ? createEleos({
        pass: createEleosPass({
          getModel: getEffectiveEleosModel,
          store: eleosStore,
          delayMinMs: Number(env.GAIA_ELEOS_DELAY_MIN_MS) || undefined,
          delayMaxMs: Number(env.GAIA_ELEOS_DELAY_MAX_MS) || undefined,
        }),
        runtime: eleosRuntime,
      })
    : undefined;
  if (eleos) eleos.start();
  app.use('/eleos', createEleosRouter({ store: eleosStore, auth }));

  // DESKTOP — Gaia reaching for the person's OWN computer (Desktop Commander, run by Gaia-Desktop).
  // Gaia-Cloud executes nothing there: the broker turns a tool call into an action the connected client
  // carries out, and reads run freely while writes and commands wait for the person's confirmation
  // (src/desktopBroker.js, docs/desktop-capability.md). Off unless a deployment opts in
  // (GAIA_DESKTOP=true); even then a turn offers it only when the client declares `desktop: true`.
  const desktopBroker = env.GAIA_DESKTOP === 'true'
    ? createDesktopBroker({
      confirmTimeoutMs: Number(env.GAIA_DESKTOP_CONFIRM_TIMEOUT_MS) || undefined,
      resultTimeoutMs: Number(env.GAIA_DESKTOP_RESULT_TIMEOUT_MS) || undefined,
      logger: (line) => {
        console.log(line);
        try { decisionStore.append(JSON.parse(line)); } catch (_) { /* observability only */ }
      },
    })
    : undefined;
  if (desktopBroker) app.use('/desktop', createDesktopRouter({ broker: desktopBroker, auth }));

  // RESEARCH JOBS — Gaia reaching FOR a Hermes skill, off the turn's clock.
  //
  // A research turn submits a run at Hermes and answers immediately; the
  // findings are picked up later by a poll cycle, written into the
  // conversation like any other message, and announced through
  // GET /research/jobs so a client knows to look. Off unless a deployment
  // opts in (GAIA_RESEARCH_REACH=on), because it means Hermes works
  // unattended, with its full toolset, on Gaia's behalf.
  const researchStore = createResearchJobStore(
    env.GAIA_RESEARCH_JOBS_PATH !== undefined ? { jobsDir: env.GAIA_RESEARCH_JOBS_PATH } : {}
  );
  const researchOutboxDir = resolveOutboxDir(env);
  const researchJobs = env.GAIA_RESEARCH_REACH === 'on'
    ? {
        start: async ({ question, skillId, conversationId }) => startResearchJob({
          question,
          skillId,
          conversationId,
          hermes,
          store: researchStore,
          outboxDir: HERMES_OUTBOX_DIR,
        }),
      }
    : undefined;
  app.use('/research', createResearchRouter({
    store: researchStore,
    auth,
    answerApproval: (jobId, choice) => answerJobApproval({
      jobId,
      choice,
      hermes,
      store: researchStore,
    }),
  }));

  if (researchJobs) {
    const pollMs = Number(env.GAIA_RESEARCH_POLL_MS) > 0 ? Number(env.GAIA_RESEARCH_POLL_MS) : 20000;
    const timer = setInterval(() => {
      pollResearchJobs({
        hermes,
        store: researchStore,
        library: libraryStore,
        outboxDir: researchOutboxDir,
        onCompleted: async (job) => {
          // The findings belong in the conversation, not only in a poll
          // response: write them, then remember that we did.
          const saved = saveResearchMessage({ job, historyStore });
          if (saved) researchStore.update(job.id, { messageSaved: true });
        },
        onCheckin: async (job) => {
          // A long run must not be silent: the person sees, in the
          // conversation itself, that it is still going. Nothing is promised —
          // the check-in only says the investigation is alive.
          const saved = saveResearchCheckin({ job, historyStore });
          if (saved) researchStore.update(job.id, { checkinSaved: true });
        },
      }).catch(() => { /* a poll cycle never rejects; belt and braces */ });
    }, pollMs);
    // Never hold the process open just for the poller.
    if (typeof timer.unref === 'function') timer.unref();
  }

  // GaiaChat review surface — the human Absolute Override (list/test/reject/
  // confirm) with active supersession. Part of the client contract.
  app.use('/cognition', createCognitionRouter({ cognition, sync: cognitionSync, auth }));

  // Taking a memory back — the person's own route, for the clients' "dit klopt
  // niet" button. Deliberately independent of GAIA_MEMORY_TOOL: that switch
  // governs what Gaia may call herself, and the failure it exists to answer is
  // precisely her having said something untrue from memory. Losing the ability
  // to correct her there would be the wrong trade.
  app.use('/memory', createMemoryRouter({
    banks: memoryBanks,
    home: memoryHome,
    cognition,
    sync: cognitionSync,
    auth,
  }));

  // Kairos — derived narrative episodes over the raw Foundation observation
  // stream, plus the realtime SSE stream. Clients reach episodes ONLY here,
  // never Cognition/Foundation directly. Mounted unconditionally so the read
  // + stream work even when the worker is disabled; the worker itself is
  // created below behind GAIA_KAIROS_ENABLED.
  app.use('/kairos', createKairosRouter({ cognition, foundation, auth }));

  // Version endpoint - public, no auth required
  app.use('/api', createVersionRouter());

  // v3.0: no live tools. The turn is direct generation with
  // policy-gated Hindsight recall only; nothing routes to a tool.

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
      // The client may leave at any moment (Desktop closes the connection when the user interrupts
      // Gaia): abort the turn so generation stops instead of running on for nobody. `close` also fires
      // after a normal finish, so only an unfinished response counts as a disconnect. Attached before
      // the first await so a client that leaves early is caught too.
      const turnAbort = new AbortController();
      res.on('close', () => {
        if (!res.writableFinished) turnAbort.abort();
      });

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
        foundation,
        conversationSearch,
        aion,
        eleos,
        desktopBroker,
        desktopClient: Boolean(req.body && req.body.desktop === true),
        desktopRoots: req.body && req.body.desktopRoots,
        desktopPlaces: req.body && req.body.desktopPlaces,
        desktopIndex: Boolean(req.body && req.body.desktopIndex === true),
        res,
        conversationId,
        generator: getEffectiveNativeGenerator(),
        backupGenerator: getEffectiveBackupGenerator(),
        researchJobs,
        historyStore,
        decisionStore,
        attachments: resolvedAttachments,
        traceId,
        userDisplayName,
        signal: turnAbort.signal,
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
      foundation,
      conversationSearch,
      aion,
      eleos,
      attachments,
      generator: getEffectiveNativeGenerator(),
      backupGenerator: getEffectiveBackupGenerator(),
      researchJobs,
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
      // Asked BEFORE the save: only a conversation that has no title yet gets
      // a name (see conversationTitle.js). This route has already answered the
      // person, so unlike the streaming path there is no frame to ride and no
      // deadline to keep — the name is written when it is ready and reaches
      // clients through the store (`GET /conversations`, and the changed event
      // the history stream already relays).
      const needsTitle =
        typeof historyStore.getTitle === 'function' && historyStore.getTitle(conversationId) === null;
      try {
        historyStore.saveConversation(conversationId, [...messages, { role: 'assistant', content: result.body.reply }]);
        if (needsTitle) {
          void generateConversationTitle({
            generator: getEffectiveNativeGenerator(),
            messages,
            replyText: result.body.reply,
          }).then((title) => {
            if (title) historyStore.setTitle(conversationId, title);
          });
        }
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
  // run any turn pipeline at all, by construction (it never imports
  // turn.js or the generation providers).
  // Gaia's voice info — which provider backs POST /speech and which
  // languages it pronounces, so clients can decide *whether* to speak a
  // given reply (Dutch stays silent on a MiMo-only voice). Describes the
  // voice, never judges text: no request body, no language detection here.
  app.get('/speech/info', auth, (req, res) => {
    const providerTtsConfig = resolveTtsConfig(providerStore, env);
    const configured = Boolean(
      providerTtsConfig && (providerTtsConfig.baseUrl || ['elevenlabs', 'fishaudio'].includes(providerTtsConfig.provider)) && providerTtsConfig.model
    ) || Boolean(tts);
    const provider = providerTtsConfig ? providerTtsConfig.provider : null;
    // The English voice may run on another provider: advertise the union of what both can speak.
    const englishConfig = resolveTtsConfig(providerStore, env, 'en');
    const englishProvider = englishConfig ? englishConfig.provider : null;
    const languages = [...new Set([...languagesForTtsProvider(provider), ...(englishProvider ? languagesForTtsProvider(englishProvider) : [])])];
    res.json({ configured, provider, languages });
  });

  // Speech recognition info — whether POST /speech/transcribe can work, which
  // provider backs it, and the limits clients must respect (one utterance at a
  // time, MAX_AUDIO_BYTES). Describes the capability, never judges audio.
  app.get('/speech/stt-info', auth, (req, res) => {
    const config = resolveSttConfig(providerStore, env);
    const configured = Boolean(config && config.baseUrl && config.model);
    res.json({
      configured,
      provider: config ? config.provider : null,
      languages: mistralStt.LANGUAGES,
      maxBytes: mistralStt.MAX_AUDIO_BYTES,
    });
  });

  // Speech recognition: ONE finished utterance of audio in, text out. The body
  // is the raw audio (Content-Type audio/*, 16 kHz mono WAV from Desktop);
  // an optional language hint comes as ?language=nl or X-Gaia-Language. The
  // audio exists in memory for this request only and is never stored; the
  // activity log records bytes, timing and outcome but never audio or text.
  // This is an input transport: the client sends the returned text to
  // POST /conversation/turn as an ordinary user message.
  app.post(
    '/speech/transcribe',
    auth, // auth BEFORE the body parser: unauthenticated audio is never buffered
    express.raw({ type: () => true, limit: mistralStt.MAX_AUDIO_BYTES }),
    async (req, res) => {
      const audio = req.body;
      const { stt: effectiveStt, config: sttConfig } = getEffectiveStt();
      const logBase = {
        provider: sttConfig ? sttConfig.provider : null,
        model: sttConfig ? sttConfig.model : null,
        bytes: Buffer.isBuffer(audio) ? audio.length : 0,
      };
      if (!Buffer.isBuffer(audio) || audio.length === 0) {
        sttLog.record({ ...logBase, outcome: 'bad-request', error: 'no audio', status: 400, durationMs: 0 });
        return res.status(400).json({ error: 'audio must be sent as the request body' });
      }
      if (!effectiveStt) {
        sttLog.record({ ...logBase, outcome: 'not-configured', error: 'speech recognition is not configured', status: 503, durationMs: 0 });
        return res.status(503).json({ error: 'speech recognition is not configured' });
      }
      const started = process.hrtime.bigint();
      try {
        const { text, language } = await effectiveStt.transcribe(audio, {
          mimeType: req.get('content-type'),
          language: req.query.language || req.get('x-gaia-language'),
        });
        const durationMs = Math.round((Number(process.hrtime.bigint() - started) / 1e6) * 100) / 100;
        sttLog.record({ ...logBase, outcome: 'ok', error: null, status: 200, durationMs });
        return res.status(200).json({ text, language });
      } catch (err) {
        // Calm, generic — same posture as POST /speech: never forward the
        // underlying error, provider name, or endpoint. The operator log
        // (never the client) also gets the fixed reason phrase, e.g.
        // "provider answered 401", so a key or model problem is visible.
        const durationMs = Math.round((Number(process.hrtime.bigint() - started) / 1e6) * 100) / 100;
        const reason = err && typeof err.reason === 'string' ? ` (${err.reason})` : '';
        sttLog.record({ ...logBase, outcome: 'error', error: `gaia could not listen right now${reason}`, status: 502, durationMs });
        return res.status(502).json({ error: 'gaia could not listen right now' });
      }
    }
  );

  app.post('/speech', auth, async (req, res) => {
    const text = req.body && req.body.text;
    if (typeof text !== 'string' || text.trim() === '') {
      return res.status(400).json({ error: 'text must be a non-empty string' });
    }
    // The client detects the reply's language (this route judges no text); 'en' uses the English
    // voice when one is configured, anything else — or no language — the default (Dutch) voice.
    const language = req.body.language === 'en' || req.body.language === 'nl' ? req.body.language : undefined;
    const { tts: effectiveTts, config: ttsConfig } = getEffectiveTts(language);
    // Operator diagnostics (GET /admin/api/tts/log): what the voice
    // attempted, with what, and how it ended. Clients never see this —
    // they keep the calm wording below — but "she doesn't speak" without
    // it is undebuggable.
    const logBase = {
      provider: ttsConfig ? ttsConfig.provider : null,
      model: ttsConfig ? ttsConfig.model : null,
      voiceId: (ttsConfig && ttsConfig.voiceId) || '',
      language: language || null,
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

  // Kairos worker — folds raw Foundation observations into narrative episodes
  // and pushes them over the SSE stream. Entirely best-effort and off by
  // default (GAIA_KAIROS_ENABLED=true to start): no Foundation, no Cognition,
  // or no Kairos model simply leaves the read/stream endpoints serving
  // whatever already exists. Never blocks startup, never affects a turn.
  const kairosRuntime = createKairosRuntime({
    bankId: cognition.bankId,
    foundation,
    cognition,
    providerStore,
    syncEpisode: (episode) => cognitionSync.syncKairosEpisode(episode),
    env,
  });
  if (kairosRuntime) kairosRuntime.start();
  // Hypothesis soft-promotion scan — same posture as Kairos: best-effort,
  // never blocks startup and never affects a turn.
  if (softPromotionScan) softPromotionScan.start();
  // The hypothesis expiry pass — same posture: best-effort, invisible to turns.
  if (expiryScan) expiryScan.start();

  // Calm JSON error surface — no stack traces, no provider names.
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'request body must be valid JSON' });
    }
    if (err && err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'request body is too large' });
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
