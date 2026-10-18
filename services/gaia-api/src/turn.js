'use strict';

/**
 * Turn handling — the server side of the desktop's `conversation/turn`
 * contract (desktop/src/state/contract.js).
 *
 * GAIA v3.0 LIVE PATH ("De conversatie is de ervaring"): a live turn is
 * direct generation — validate → SOUL/context prompt → gated memory
 * recall → ONE inference call (primary LLM, backup on retryable
 * pre-output failure) → Response Engine. No synchronous IntentIQ/ReasonIQ
 * pre-flight, no Decision Engine, no Orchestrator, no plan/tool/
 * capability routing in the live flow. Hermes is never a fallback and is
 * never called here.
 *
 * Both transports share ONE pipeline — `runTurnCore` — and differ ONLY in
 * delivery: SSE deltas + typed step/error frames (streaming) vs one JSON
 * body (non-streaming). The reply is always resolved through
 * responseEngine.resolveReplyText and delivered via formatReply (JSON) or
 * deliverReply/emitter (SSE). Provider names, model names, transport
 * details and stacks never cross this seam (toCalmError).
 *
 * BACKGROUND (Logos is the reflection on the experience): Foundation
 * observation registration, Memoryworthiness, hypothesis lifecycle,
 * background Logos reflection, gated pattern formation, Hindsight reflection and
 * DecisionIQ review run in `runDeferredCognition` — started AFTER the
 * reply is delivered, never awaited, never touching the transport, never
 * altering the reply. Derived knowledge stays `interpretation`/
 * `hypothesis`; only a human confirms (Absolute Override).
 *
 * Chat history (conversationStore.js) is saved as a fire-and-forget side
 * effect AFTER a turn succeeds. Conversation history remembers everything;
 * Hindsight receives only what Memoryworthiness judged worth remembering.
 *
 * The conversation's NAME (conversationTitle.js) is the one model call a turn
 * makes about itself rather than for the person: on a conversation's first
 * turn only, the same generator that just answered is asked for a one-line
 * title, bounded by TITLE_DEADLINE_MS so the reply never waits on it, delivered
 * as a `title` frame and saved with the transcript. A name is not worth a
 * failover, so only the primary generator is ever asked.
 */

const { buildSystemPrompt } = require('./foundation');
const { recallRelevantContext, renderDualRecallContext, reflectOnTurn, fetchMentalModelContext, renderMentalModelContext } = require('./memory');
const { searchRelevantKnowledgePages, renderKnowledgePageContext } = require('./knowledgePages');
const { assembleEvidence } = require('./reasoning/evidenceAssembler');
const { fetchEvidenceForReflections } = require('./reasoning/evidenceRecall');
const {
  evaluateMemoryWorthiness, shouldRetainToHindsight, applyCapabilityOutcomeOverride,
  metadataForMemoryDecision, logMemoryWorthiness,
} = require('./memoryWorthiness');
const { shouldAttemptPatternRetrieval, renderPatternContextBlock, logPatternAwareness, evaluatePatternUsage } = require('./reasoning/patternAwareness');
const { renderCapabilityAwareness } = require('./capabilityAwareness');
const { pickOpenQuestion, renderOpenQuestionRaise, fromQuestionRow } = require('./reasoning/openQuestionReach');
const { renderFoundationContext } = require('./foundationClient');
const { renderConversationHistoryContext } = require('./conversationSearch');
const { createConversationTool } = require('./reasoning/conversationTool');
const { renderNowContext } = require('./nowContext');
const { generateConversationTitle, withDeadline, TITLE_DEADLINE_MS } = require('./conversationTitle');
const { resolveReachSkill, renderResearchPending } = require('./researchReach');
const { researchJobView } = require('./researchRoutes');
const { withKeptNotifier } = require('./reasoning/memoryTool');
const { evaluate: evaluateLogos, decideLogosDepth, explainLogosDepth } = require('./logos/logos');
const { logLogosGate } = require('./logos/logosLog');
const { shouldRecall } = require('./memoryPolicy');
const { logRecallMeasure } = require('./recallLog');
const { readTurn, logTurnShape } = require('./turnShape');
const crypto = require('crypto');
const {
  formatReply, createStreamEmitter, resolveReplyText, deliverReply, toCalmError,
} = require('./responseEngine');
const { generateWithFailover, streamWithFailover, isNotConfiguredError } = require('./generation/generationFailover');
const { createTurnTiming, trackFirstToken } = require('./timing');

const ALLOWED_ROLES = new Set(['user', 'assistant', 'system']);

/**
 * Combines the tools a live turn carries into one payload for the generator.
 * Each part is `{ tools, onToolCall }` and owns its own verbs; a call is handed
 * to the parts in order and the first one that does not answer
 * 'Unknown action.' wins — the same contract the server uses to dispatch
 * between the memory tool and the web tool. Returns null when nothing is
 * offered, so the generator is left exactly as it was.
 *
 * Parts that are absent, or that lack a dispatcher, are skipped: a tool may
 * only be offered to the model when something can actually run it.
 */
function combineTurnTools(...parts) {
  const tools = [];
  const dispatchers = [];
  for (const part of parts) {
    if (!part || !Array.isArray(part.tools) || typeof part.onToolCall !== 'function') continue;
    tools.push(...part.tools);
    dispatchers.push(part.onToolCall);
  }
  if (tools.length === 0) return null;
  return {
    tools,
    onToolCall: async (name, args) => {
      for (const dispatch of dispatchers) {
        const result = await dispatch(name, args);
        if (result !== 'Unknown action.') return result;
      }
      return 'Unknown action.';
    },
  };
}

/**
 * Validates the incoming message history. Returns null when valid, or a
 * human-readable problem string (surfaced as a 400 to the client).
 */
function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return 'messages must be a non-empty array';
  }
  for (const message of messages) {
    if (!message || typeof message !== 'object') {
      return 'each message must be an object';
    }
    if (!ALLOWED_ROLES.has(message.role)) {
      return `invalid message role: ${String(message.role)}`;
    }
    if (typeof message.content !== 'string' || message.content.trim() === '') {
      return 'each message must have non-empty string content';
    }
  }
  return null;
}

/**
 * Assembles the message list sent to generation: system messages first,
 * then the client's history verbatim (role + content only — any
 * client-side fields are already stripped by the desktop contract and
 * dropped again here, so nothing local ever reaches the inference path).
 *
 * When multimodalAttachments are present, the last user message is
 * converted to multimodal content format:
 *   content: [
 *     { type: "text", text: "user message" },
 *     { type: "image_url", image_url: { url: "data:image/png;base64,..." } }
 *   ]
 */
function assembleMessages(systemPrompt, messages, multimodalAttachments = []) {
  const baseMessages = [];
  if (systemPrompt) {
    baseMessages.push({ role: 'system', content: systemPrompt });
  }
  baseMessages.push(...messages.map(({ role, content }) => ({ role, content })));

  if (!Array.isArray(multimodalAttachments) || multimodalAttachments.length === 0) {
    return baseMessages;
  }

  let lastUserIdx = -1;
  for (let i = baseMessages.length - 1; i >= 0; i--) {
    if (baseMessages[i].role === 'user') {
      lastUserIdx = i;
      break;
    }
  }

  if (lastUserIdx === -1) {
    return baseMessages;
  }

  const userText = baseMessages[lastUserIdx].content;
  const contentBlocks = [
    { type: 'text', text: userText },
  ];

  for (const attachment of multimodalAttachments) {
    if (attachment.imageBytes && attachment.imageMimeType) {
      const dataUrl = `data:${attachment.imageMimeType};base64,${attachment.imageBytes.toString('base64')}`;
      contentBlocks.push({
        type: 'image_url',
        image_url: { url: dataUrl },
      });

      console.log(JSON.stringify({
        kind: 'turn.multimodal',
        multimodalMessageCreated: true,
        imageIncludedInLLMRequest: true,
        imageMimeType: attachment.imageMimeType,
        imageBytesLength: attachment.imageBytes.length,
        filename: attachment.filename,
      }));
    }
  }

  const result = [...baseMessages];
  result[lastUserIdx] = { role: 'user', content: contentBlocks };
  return result;
}

/**
 * Renders text-only attachments into a system-message block, in the same
 * calm, "use only what applies" register as memory.js's
 * renderMemoryContext — a file being attached is not an instruction to
 * force it into the reply.
 *
 * Only handles text attachments; images go through assembleMessages().
 * @param {Array<{ filename: string, content: string|null }>} attachments
 * @returns {string|null}
 */
function renderTextAttachmentContext(attachments) {
  if (!attachments || attachments.length === 0) return null;
  const textAttachments = attachments.filter((a) => !a.imageBytes);
  if (textAttachments.length === 0) return null;

  const blocks = textAttachments.map(({ filename, content }) =>
    content
      ? `--- ${filename} ---\n${content}`
      : `--- ${filename} ---\n(this file's content could not be read as text and is not included here)`
  );
  return [
    'The user has attached the following file(s) from their library as context for this turn.',
    'Use them only where genuinely relevant; do not force them in, and do not announce that you are reading an attachment.',
    '',
    ...blocks,
  ].join('\n');
}

/**
 * Legacy alias for backward compatibility.
 * @param {Array<{ filename: string, content: string|null }>} attachments
 * @returns {string|null}
 */
function renderAttachmentContext(attachments) {
  return renderTextAttachmentContext(attachments);
}

function latestUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') return messages[i].content || '';
  }
  return '';
}

/**
 * Adapts a legacy Hermes client (`{ chat, stream }`) to the generator
 * shape (`{ generate, stream }`) the live path speaks. Backward
 * compatibility for existing callers/tests only — production wiring
 * passes configured primary/backup generators and never Hermes. Hermes
 * is an explicit HADES execution instrument, never an inference fallback.
 * @param {{ chat?: Function, stream?: Function }|null|undefined} hermes
 * @returns {{ generate: Function, stream?: Function }|null}
 */
function adaptHermesToGenerator(hermes) {
  if (!hermes) return null;
  const adapter = {};
  if (typeof hermes.chat === 'function') {
    adapter.generate = (messages) => hermes.chat(messages);
  }
  if (typeof hermes.stream === 'function') {
    adapter.stream = (messages, { onDelta, signal } = {}) =>
      hermes.stream(messages, { onDelta, ...(signal ? { signal } : {}) });
  }
  return typeof adapter.generate === 'function' || typeof adapter.stream === 'function' ? adapter : null;
}

/**
 * Resolves the live generation pair: explicit primary/backup first,
 * legacy `nativeGenerator` as primary, legacy `hermes` adapted as
 * primary only when nothing else is configured (never as a fallback
 * behind a configured primary).
 */
function resolveLiveGenerators({ generator, backupGenerator, nativeGenerator, hermes }) {
  const primary = generator || nativeGenerator || adaptHermesToGenerator(hermes) || null;
  const backup = backupGenerator || null;
  return { primary, backup };
}

/**
 * Derives the capability-awareness entries from the live generation pair
 * so Gaia's self-knowledge stays truthful without a Decision Engine.
 */
function generationCapabilities({ primary }, { nativeGenerator, hermes, generator, foundation, conversationSearch, hindsight, aion, desktop, researchJobs } = {}) {
  const capabilities = [];
  if ((generator || nativeGenerator || primary) && !(hermes && !generator && !nativeGenerator)) {
    capabilities.push({ id: 'native' });
  } else if (hermes) {
    capabilities.push({ id: 'hermes' });
  }
  if (foundation && typeof foundation.searchResults === 'function') {
    capabilities.push({ id: 'foundation' });
  }
  // Conversation search is real this turn whenever the transcript read is
  // wired — the literal past, distinct from Hindsight's selected memory.
  if (conversationSearch && typeof conversationSearch.search === 'function') {
    capabilities.push({ id: 'conversation_search' });
  }
  // Memory is real this turn whenever Hindsight recall is wired — the
  // capability-awareness block is the one place Gaia learns that, so leaving
  // it out made her honestly deny a memory she actually has.
  if (hindsight && typeof hindsight.recall === 'function') {
    capabilities.push({ id: 'hindsight' });
  }
  // The on-demand shared-memory tool, when the primary generator carries it.
  const toolNames = primary && Array.isArray(primary.toolNames) ? primary.toolNames : [];
  if (toolNames.includes('remember')) {
    capabilities.push({ id: 'memory' });
  }
  // Taking a memory back — real only when the retraction tool is actually
  // there, which is exactly the turn in which the person's "that is not
  // correct" has somewhere to go. Same rule as `memory`: the tool's presence
  // is what makes the claim honest.
  if (toolNames.includes('retract_memory')) {
    capabilities.push({ id: 'memory_retraction' });
  }
  // Forgetting is a different verb from retracting: the person asked for it to
  // go, and whether it was ever true is not the question. Same honesty rule —
  // she may only claim it in a turn that actually carries the tool.
  if (toolNames.includes('forget_memory')) {
    capabilities.push({ id: 'memory_forgetting' });
  }
  // Her OWN memory — Aion in the background, or the on-demand `keep` tool.
  if (aion || toolNames.includes('keep')) {
    capabilities.push({ id: 'own_memory' });
  }
  // The person's own computer — real only when a desktop executor (Gaia-Desktop
  // running Desktop Commander locally) is connected for this turn. Nothing in
  // Gaia-Cloud executes on the desktop; absent the executor she must not
  // claim it.
  if (desktop && typeof desktop.execute === 'function') {
    capabilities.push({ id: 'desktop' });
  }
  // The shallow live lookup — real only when the primary generator actually
  // carries the `web_search` tool, i.e. when a search provider is configured.
  // Same rule as `memory`: the tool's presence is what makes the claim honest.
  if (toolNames.includes('web_search')) {
    capabilities.push({ id: 'web_search' });
  }
  // The DEEP path, a different thing entirely: a research job handed to Hermes
  // and answered later. Off unless the deployment opted in, which is exactly
  // why it is a separate capability from the lookup above.
  if (researchJobs && typeof researchJobs.start === 'function') {
    capabilities.push({ id: 'research' });
  }
  return capabilities;
}

/**
 * Observability must never take a turn down: runs `fn` and swallows anything it
 * throws.
 */
function safely(fn) {
  try {
    fn();
  } catch (_) {
    // Deliberately silent: a log line is never worth a failed turn.
  }
}

/**
 * Emits one structured log line, to the decision logger when the turn has one
 * (which also persists it) and to the console otherwise. Never throws.
 */
function logEvent(decisionLogger, payload) {
  safely(() => {
    const line = JSON.stringify(payload);
    if (decisionLogger) decisionLogger(line);
    else console.log(line);
  });
}

/**
 * DecisionIQ as post-turn reflection (v3.0 Logos, third dimension): judges
 * AFTER delivery whether this turn could have used a specialized
 * capability. Observability only — never reroutes or rewrites the turn.
 */
function reflectDecisionIQ({ userText, decisionLogger }) {
  try {
    const text = String(userText || '');
    const signals = [];
    if (/\b(analyseer|analyze|analyse|race condition|architectuur|architecture|refactor|debug)\b/i.test(text)) signals.push('analysis');
    if (/\b(onthoud|remember|weet je nog|vorige|eerder)\b/i.test(text)) signals.push('memory');
    if (/https?:\/\//.test(text)) signals.push('external_reference');
    logEvent(decisionLogger, {
      kind: 'decision.review',
      couldHaveUsedCapability: signals.length > 0 ? signals : null,
      note: 'post-turn reflection only — the delivered reply stands',
    });
  } catch (_) {
    // Observability must never take down a turn.
  }
}

/**
 * The vision fallback: turns images into disclaimer-prefixed descriptions (ocrResolver.js, the same
 * step used when the primary model cannot see) so a turn can be retried as plain text. An image that
 * cannot be described stays in the prompt as "could not be read" rather than vanishing. Never throws.
 * @param {Array<{ filename: string, imageBytes: Buffer, imageMimeType: string }>} images
 * @param {Function} [describeImage]
 * @param {AbortSignal} [signal]
 * @returns {Promise<Array<{ filename: string, content: string|null }>>}
 */
async function describeImagesAsText(images, describeImage, signal) {
  const describe = describeImage
    || ((image) => require('./ocrResolver').resolveImageText(image.imageBytes, image.imageMimeType));
  const out = [];
  for (const image of images) {
    if (signal && signal.aborted) break;
    let content = null;
    try {
      // eslint-disable-next-line no-await-in-loop
      content = (await describe(image)) || null;
    } catch (_) { /* degrade to "could not be read" */ }
    out.push({ filename: image.filename, content });
  }
  return out;
}

/**
 * THE SHARED DIRECT-GENERATION PIPELINE — one implementation, two
 * transports.
 *
 * validate → SOUL/context prompt → gated memory recall → ONE inference
 * call (primary, backup on retryable pre-output failure) → Response
 * Engine. The only transport knob is `onDelta`: present ⇒ streaming
 * generation with SSE delivery; absent ⇒ one JSON body. No Logos
 * pre-flight, no Decision Engine, no Orchestrator, no plan/tool/capability
 * routing in this path — the single exception is the research reach
 * (src/researchReach.js), which SUBMITS a Hermes run alongside recall and
 * returns a job, never the reply: the findings arrive later through the poll
 * endpoint (src/researchJob.js + src/researchRoutes.js).
 *
 * @param {{
 *   messages: Array<{role: string, content: string}>,
 *   documents: Record<string, string>,
 *   hindsight?: object|null,
 *   attachments?: Array<{ filename: string, content: string|null, imageBytes?: Buffer, imageMimeType?: string }>,
 *   traceId?: string,
 *   conversationId?: string,
 *   generator?: { generate: Function, stream?: Function }|null,
 *   backupGenerator?: { generate: Function, stream?: Function }|null,
 *   nativeGenerator?: { generate: Function, stream?: Function }|null,
 *   hermes?: { chat?: Function, stream?: Function }|null,
 *   foundation?: { submitObservation: Function, searchResults: Function }|null,
 *   hypothesisRuntime?: object|null,
 *   decisionStore?: { append: (record: object) => boolean },
 *   reasonIQ?: Function, // background Logos evaluator (legacy param name, kept for tests/callers)
 *   logos?: Function, // preferred alias for reasonIQ above
 *   onDelta?: Function,
 *   userDisplayName?: string,
 *   describeImage?: (image: { filename: string, imageBytes: Buffer, imageMimeType: string }) => Promise<string|null>, // vision fallback; default: ocrResolver
 * }} input
 * @returns {Promise<{ executionResult: object|null, replyText: string|null, timing: object, notConfigured: boolean, startDeferredCognition: () => Promise<void> }>}
 */
/**
 * The recall half of a turn: which doors this turn opens (Foundation, the
 * conversation archive, patterns, a research run) and everything they bring
 * back, fetched together. Every read is fail-soft; nothing here can end a turn.
 */
async function recallForTurn({
  userText, shape, intentDecision, conversationId, traceId, timing, decisionLogger,
  hindsight, foundation, conversationSearch, hypothesisRuntime, researchJobs,
}) {
  // Archive-shaped asks ("wat staat er in foundation…") open a read over
  // Foundation — the raw-record counterpart to Hindsight recall. The signal
  // is pure and lexical, read once above, so no model runs before the one
  // inference call.
  const wantFoundation = Boolean(
    foundation && typeof foundation.searchResults === 'function'
    && shape.looksInRecords
  );

  // Conversation-history read: the literal past. Opened by the signals that
  // point at what was actually said (a lookup, a past-conversation moment, a
  // "what do you remember"), never by default — and never for the current
  // conversation, whose turns are already in the prompt verbatim. This is the
  // honest counterpart to Hindsight: Hindsight holds what was judged worth
  // remembering; the transcript holds what was said.
  const wantConversationHistory = Boolean(
    conversationSearch && typeof conversationSearch.search === 'function'
    && shape.looksInArchive
  );

  // Research with sources is the ONE shape that reaches FOR Hermes (see
  // researchReach.js + researchJob.js): the task shape comes from IntentIQ,
  // the permission from the registry. The run is SUBMITTED, never awaited — a
  // grounded-citations run takes minutes (measured live: still going after 15,
  // 33 tool calls), so this turn answers now and the findings arrive through
  // the poll endpoint. It runs alongside recall so the submit costs nothing.
  //
  // A conversationId is REQUIRED. The findings are written into the
  // conversation, so without one they would have nowhere to land and the
  // client would only ever see "finished" with no content. A turn without a
  // conversation therefore does not reach at all — it simply answers, and the
  // skip is logged so the missing id is visible instead of silent.
  const detectedSkill = researchJobs && typeof researchJobs.start === 'function'
    ? resolveReachSkill(userText)
    : null;
  const reachSkill = detectedSkill && conversationId ? detectedSkill : null;
  if (detectedSkill && !reachSkill) {
    logEvent(decisionLogger, {
      kind: 'research.skipped',
      traceId: traceId || null,
      skill: detectedSkill,
      reason: 'no-conversation',
    });
  }

  // Gated recall — Hindsight only on explicit requests or content
  // triggers, never by default. Pattern recall rides the same gated
  // moment through the hypothesisRuntime adapter seam.
  const wantPatterns = Boolean(
    hypothesisRuntime
    && typeof hypothesisRuntime.recallPatterns === 'function'
    && hindsight
    && shouldAttemptPatternRetrieval(userText, intentDecision, shape)
  );
  timing.start('memory_recall');
  const [reflections, mentalModels, recalledPatterns, knowledgePages, foundationResults, conversationHits, researchJob, openQuestionRows] = await Promise.all([
    hindsight
      ? recallRelevantContext(hindsight, userText, { pastReference: wantConversationHistory, shape })
      : Promise.resolve([]),
    hindsight ? fetchMentalModelContext(hindsight).catch(() => []) : Promise.resolve([]),
    wantPatterns
      ? hypothesisRuntime.recallPatterns(userText).catch((err) => {
        console.warn(`[gaia:patterns] recall failed (non-fatal): ${err.message}`);
        return [];
      })
      : Promise.resolve([]),
    hindsight
      ? searchRelevantKnowledgePages(hindsight, userText, { intentDecision })
      : Promise.resolve([]),
    wantFoundation
      ? foundation.searchResults(userText).catch((err) => {
        console.warn(`[gaia:foundation] recall failed (non-fatal): ${err.message}`);
        return [];
      })
      : Promise.resolve([]),
    // The live search (conversationSearch.createConversationSearch) is synchronous
    // and answers an array; a client may be async. Wrapping the call in a promise
    // chain handles both, and keeps a synchronous throw from escaping Promise.all.
    // (It did escape once: a turn that opened the archive door, 18-10-2026, took
    // the whole process down with "search(...).catch is not a function".)
    wantConversationHistory
      ? Promise.resolve()
        .then(() => conversationSearch.search(userText, { excludeConversationId: conversationId, limit: 5 }))
        .catch((err) => {
          console.warn(`[gaia:conversations] search failed (non-fatal): ${err.message}`);
          return [];
        })
      : Promise.resolve([]),
    reachSkill
      ? Promise.resolve()
        .then(() => researchJobs.start({ question: userText, skillId: reachSkill, conversationId }))
        .catch(() => null)
      : Promise.resolve(null),
    // Independent of the rest, so it rides the same wait instead of adding its
    // own; a failure simply means she raises nothing extra (see below).
    hypothesisRuntime && hypothesisRuntime.openQuestions
      ? Promise.resolve()
        .then(() => hypothesisRuntime.openQuestions.list())
        .catch(() => null)
      : Promise.resolve(null),
  ]);
  timing.end('memory_recall');

  // Dual Recall — de terugweg. A recalled Hindsight item carries the raw
  // Foundation observation ids it was built from (gaia_*_sources, see
  // reasoning/evidenceRecall.js); fetch those literal records so the prompt can
  // lay the evidence beside the interpretation it supports. Gated hard (no
  // sources ⇒ no fetch) and fail-soft: a missing source is silence, never a
  // broken turn.
  timing.start('evidence_recall');
  let dualRecall = null;
  try {
    dualRecall = await fetchEvidenceForReflections(foundation, reflections, {
      pastReference: wantConversationHistory,
    });
  } catch (_) {
    dualRecall = null;
  }
  timing.end('evidence_recall');

  return {
    wantFoundation, wantConversationHistory, wantPatterns, reachSkill,
    reflections, mentalModels, recalledPatterns, knowledgePages, foundationResults,
    conversationHits, researchJob, openQuestionRows, dualRecall,
  };
}

/**
 * One observability line per concern for a turn's recall: the recall measure,
 * the shape reading and (on a research turn) the reach. Counts and booleans
 * only, never content; none of it can take a turn down.
 */
function logRecallObservability({
  userText, shape, traceId, decisionLogger, hindsight, wantPatterns, reachSkill, researchJob,
  reflections, mentalModels, recalledPatterns, knowledgePages,
}) {
  // Meetbasis voor Gaia-geïnitieerde recall: één regel per turn met gate
  // en counts only (nooit user-/memory-inhoud). Blijft werken zonder
  // decisionStore via console.log-default; met store is hij ook duurzaam
  // voor `GET /admin/api/logos/decisions`.
  safely(() => logRecallMeasure({
    traceId: traceId || null,
    gated: shouldRecall(userText, { shape }),
    hasHindsight: Boolean(hindsight),
    reflectionCount: Array.isArray(reflections) ? reflections.length : 0,
    mentalModelCount: Array.isArray(mentalModels) ? mentalModels.length : 0,
    patternCount: Array.isArray(recalledPatterns) ? recalledPatterns.length : 0,
    knowledgePageCount: Array.isArray(knowledgePages) ? knowledgePages.length : 0,
    queryLength: String(userText || '').length,
    wantPatterns,
  }, decisionLogger));

  // Stap 2 van het stroomlijnplan (`plan: de vraag één keer lezen`): het
  // verdict van readTurn naast de bestaande per-poort-regels, zodat stap 3 op
  // echt verkeer kan vergelijken vóór er een consument verhuist. Vorm, ja/nee
  // en signaalnamen alleen — nooit de tekst van de gebruiker. Sinds stap 4 is
  // dit dezelfde lezing die de poorten hierboven al gebruikten.
  safely(() => logTurnShape(
    { ...shape, traceId: traceId || null, queryLength: String(userText || '').length },
    decisionLogger
  ));

  // Reach observability: one line per research turn — which skill Gaia reached
  // for, which job carries it, and whether the run actually got submitted.
  // Ids and booleans only, never content.
  if (reachSkill) {
    logEvent(decisionLogger, {
      kind: 'research.job',
      traceId: traceId || null,
      skill: reachSkill,
      jobId: researchJob ? researchJob.id : null,
      submitted: Boolean(researchJob && researchJob.runId),
    });
  }

}

/**
 * The prompt half of a turn: evidence for the background analysis, pattern
 * usage, every context block and the message list. Both transports build the
 * exact same prompt. `buildAssembled` is returned as well, because the vision
 * fallback rebuilds the messages with the images turned into text.
 */
function buildTurnPrompt({
  userText, messages, documents, attachments, conversationId, traceId, timing, decisionLogger,
  primary, backup, nativeGenerator, hermes, generator, foundation, conversationSearch,
  hindsight, aion, desktop, researchJobs, hypothesisRuntime,
  wantFoundation, wantPatterns, reflections, mentalModels, recalledPatterns, knowledgePages,
  foundationResults, conversationHits, researchJob, openQuestionRows, dualRecall,
}) {
  const textAttachments = (attachments || []).filter((a) => !a.imageBytes);
  const multimodalAttachments = (attachments || []).filter((a) => a.imageBytes && a.imageMimeType);

  // Evidence Assembly: organizes what this turn already has in hand into
  // normalized evidence for the BACKGROUND analysis below. Pure, local.
  let evidence = [];
  timing.start('evidence_assembly');
  try {
    evidence = assembleEvidence({ reflections, mentalModels, attachments: textAttachments });
  } catch (_) {
    // Assembly must never take down a turn.
  }
  timing.end('evidence_assembly');

  // Pattern usage is pure policy over the recalled candidates — no
  // Decision Engine involved. Nothing pattern-shaped enters the prompt
  // on ignore/absent usage.
  let patternUsage = null;
  try {
    const evaluation = evaluatePatternUsage(recalledPatterns, { userInput: userText });
    if (evaluation) {
      patternUsage = {
        mode: evaluation.mode,
        patterns: evaluation.patterns,
        contextPatternIds: evaluation.contextPatternIds,
        mentions: evaluation.mentions,
        decisions: evaluation.decisions,
      };
    }
  } catch (_) {
    patternUsage = null;
  }
  if (wantPatterns) {
    logPatternAwareness(recalledPatterns, patternUsage, decisionLogger);
  }

  // Prompt assembly: canonical SOUL/context documents first, then live
  // capability awareness, standing knowledge, memory, attachments and
  // (gated) pattern guidance. Both transports build the exact same prompt.
  const availableCapabilities = generationCapabilities({ primary: primary, backup }, { nativeGenerator, hermes, generator, foundation, conversationSearch, hindsight, aion, desktop, researchJobs });
  // One clock for the whole turn: the "now" block Gaia is given and the
  // relative ages on recalled memory and earlier conversations all read the
  // same instant, so they can never contradict each other.
  const now = Date.now();
  const nowBlock = renderNowContext(now);
  const systemPrompt = buildSystemPrompt(documents, messages);
  const memoryBlock = renderDualRecallContext(reflections, dualRecall ? dualRecall.evidenceByFactId : null, now);
  const mentalModelBlock = renderMentalModelContext(mentalModels);
  const knowledgePageBlock = renderKnowledgePageContext(knowledgePages);
  const foundationBlock = wantFoundation ? renderFoundationContext(foundationResults) : null;
  const conversationHistoryBlock = renderConversationHistoryContext(conversationHits, now);
  const researchPendingBlock = renderResearchPending(researchJob);

  // v1.4 — the one place Gaia may bring her own unanswered question up: at
  // most one, in the conversation it came from or in a new conversation about
  // the same subject, never more than three times, and only once a silence has
  // passed since the last time. Off unless the deployment switches it on
  // (server.js), and it never blocks the turn: a failure simply means she says
  // nothing extra.
  let openQuestionBlock = null;
  if (hypothesisRuntime && hypothesisRuntime.openQuestions && openQuestionRows) {
    try {
      const picked = pickOpenQuestion(openQuestionRows.map(fromQuestionRow), {
        conversationId,
        policy: hypothesisRuntime.openQuestions.policy,
        now,
        turnText: userText,
      });
      if (picked) {
        openQuestionBlock = renderOpenQuestionRaise(picked);
        // The stamp counts the raising, not her using it, and it is
        // fire-and-forget: a failed stamp costs one count, never a turn.
        Promise.resolve(hypothesisRuntime.openQuestions.markRaised(picked.id)).catch(() => {});
      }
    } catch (_) { /* never blocks a turn */ }
  }
  const patternBlock = renderPatternContextBlock(
    patternUsage,
    new Map(recalledPatterns.filter((c) => c && c.id != null).map((c) => [String(c.id), c]))
  );

  // Built per attempt: the vision fallback below rebuilds it with the images turned into text.
  const buildAssembled = (textAtts, imageAtts) => {
    const attachmentBlock = renderTextAttachmentContext(textAtts);
    const systemMessages = [{ role: 'system', content: systemPrompt }];
    // The moment itself, right after the constitution: she must know what
    // "today" is before she reads anything that says "yesterday".
    if (nowBlock) systemMessages.push({ role: 'system', content: nowBlock });
    const capabilityBlock = renderCapabilityAwareness(availableCapabilities);
    if (capabilityBlock) systemMessages.push({ role: 'system', content: capabilityBlock });
    if (mentalModelBlock) systemMessages.push({ role: 'system', content: mentalModelBlock });
    if (knowledgePageBlock) systemMessages.push({ role: 'system', content: knowledgePageBlock });
    if (foundationBlock) systemMessages.push({ role: 'system', content: foundationBlock });
    if (conversationHistoryBlock) systemMessages.push({ role: 'system', content: conversationHistoryBlock });
    if (researchPendingBlock) systemMessages.push({ role: 'system', content: researchPendingBlock });
    if (openQuestionBlock) systemMessages.push({ role: 'system', content: openQuestionBlock });
    if (memoryBlock) systemMessages.push({ role: 'system', content: memoryBlock });
    if (attachmentBlock) systemMessages.push({ role: 'system', content: attachmentBlock });
    if (patternBlock) systemMessages.push({ role: 'system', content: patternBlock });

    // Conversational tone, empathy and follow-up judgment are left entirely
    // to the inference model, guided by SOUL — no per-turn opportunity /
    // quality-bar / conversational-state injection.
    return assembleMessages(null, [...systemMessages, ...messages.map(({ role, content }) => ({ role, content }))], imageAtts);
  };
  const assembled = buildAssembled(textAttachments, multimodalAttachments);

  const lastUserMsg = assembled.find((m) => m.role === 'user');
  if (lastUserMsg) {
    logEvent(undefined, {
      kind: 'vision.trace',
      traceId,
      stage: 'assembly',
      contentIsArray: Array.isArray(lastUserMsg.content),
      contentTypes: Array.isArray(lastUserMsg.content)
        ? lastUserMsg.content.map((c) => c.type)
        : ['text'],
      imageBlockPresent: Array.isArray(lastUserMsg.content)
        ? lastUserMsg.content.some((c) => c.type === 'image_url')
        : false,
      imageMimeType: multimodalAttachments.length > 0 ? multimodalAttachments[0].imageMimeType : null,
    });
  }

  return { assembled, buildAssembled, evidence, textAttachments, multimodalAttachments, now };
}

/**
 * The one inference call: primary with backup on a retryable pre-output
 * failure, streamed when `onDelta` is given. If the pictures went straight to
 * the model and it could not take them, they are described and the call is
 * retried once as plain text. Never throws, except for an aborted turn.
 * @returns {Promise<{ output: string|null, notConfigured: boolean }>}
 */
async function runGeneration({
  assembled, buildAssembled, textAttachments, multimodalAttachments, messages,
  primary, backup, desktop, onDelta, conversationId, traceId, signal, describeImage, timing,
}) {
  // Direct generation with primary/backup failover. Hermes is never
  // involved unless a legacy caller adapted it as the primary above.
  let output = null;
  let notConfigured = false;
  // The client already left (it disconnected while memory was being recalled): do not start generating.
  if (signal && signal.aborted) throw abortError();
  timing.start('generation');
  // Whether visible text already reached the client: a retry after that would repeat it.
  let streamedVisible = false;
  const trackedDelta = onDelta
    ? (chunk, isReasoning) => {
      if (chunk && !isReasoning) streamedVisible = true;
      onDelta(chunk, isReasoning);
    }
    : undefined;
  // What a live turn may do besides answering: act on the person's machine
  // (desktop, and only when that client declared it can) and read back the
  // conversation it is in (read_back — the thread is already in the prompt, but
  // a quote beats a guess). Both ride the streaming path only.
  const conversationTool = createConversationTool({ messages });
  const turnTools = combineTurnTools(
    desktop && Array.isArray(desktop.tools) ? { tools: desktop.tools, onToolCall: desktop.onToolCall } : null,
    { tools: conversationTool.TOOLS, onToolCall: conversationTool.onToolCall },
  );
  const generate = (messagesForModel) => (trackedDelta
    ? streamWithFailover(messagesForModel, {
      primary, backup, onDelta: trackedDelta,
      ...(conversationId ? { sessionId: conversationId } : {}),
      ...(signal ? { signal } : {}),
      ...(turnTools ? { tools: turnTools.tools, onToolCall: turnTools.onToolCall } : {}),
    })
    : generateWithFailover(messagesForModel, { primary, backup, ...(conversationId ? { sessionId: conversationId } : {}) }));
  try {
    try {
      output = await generate(assembled);
    } catch (err) {
      // Vision fallback. The pictures went straight to the model (GAIA_NATIVE_SUPPORTS_VISION) and the
      // model, or its provider, could not take them. Describe them with the vision model and try once
      // more as plain text — only when nothing was shown yet, and never for an interrupted turn.
      const mayFallBack = multimodalAttachments.length > 0
        && !streamedVisible
        && !(signal && signal.aborted)
        && !isNotConfiguredError(err);
      if (!mayFallBack) throw err;
      const described = await describeImagesAsText(multimodalAttachments, describeImage, signal);
      logEvent(undefined, {
        kind: 'vision.fallback',
        traceId: traceId || null,
        reason: err && err.name ? err.name : 'error',
        images: multimodalAttachments.length,
        described: described.filter((d) => d.content).length,
      });
      output = await generate(buildAssembled([...textAttachments, ...described], []));
    }
    timing.end('generation');
  } catch (err) {
    try { timing.end('generation'); } catch (_) { /* never break a turn */ }
    // An aborted turn is not a failed one: let the caller handle the interruption.
    if (signal && signal.aborted) throw err;
    if (isNotConfiguredError(err)) {
      notConfigured = true;
    }
    output = null;
  }

  return { output, notConfigured };
}

async function runTurnCore({
  messages,
  documents,
  hindsight,
  attachments,
  traceId,
  conversationId,
  generator,
  backupGenerator,
  nativeGenerator,
  hermes,
  researchJobs,
  foundation,
  conversationSearch,
  hypothesisRuntime,
  aion,
  eleos,
  desktop,
  decisionStore,
  reasonIQ = evaluateLogos,
  onDelta,
  onResearchJob,
  userDisplayName,
  signal,
  describeImage,
}) {
  const userText = latestUserText(messages);
  const { primary, backup } = resolveLiveGenerators({ generator, backupGenerator, nativeGenerator, hermes });

  const timing = createTurnTiming(traceId || `trace-${Date.now()}`);
  timing.start('turn');

  const decisionLogger = decisionStore
    ? (line) => {
      console.log(line);
      try {
        decisionStore.append(JSON.parse(line));
      } catch (_) {
        // Never let observability persistence affect a real turn.
      }
    }
    : undefined;

  // Eén keer lezen (stap 4 van "de vraag één keer lezen"): readTurn leest de
  // zin met de woordjeslijsten van alle poorten samen. Elke poort hieronder
  // luistert naar dit ene antwoord in plaats van zelf opnieuw naar dezelfde
  // tekst te kijken — dat is precies waar ze uit elkaar liepen.
  const shape = readTurn(userText);

  // No live interpretation: language understanding happens inside the single
  // inference call. IntentIQ (`logos/intentIQ.js`) can produce a decision, but
  // nothing wires it into the turn, so this is deliberately `null` and every
  // gate below runs on the one `shape` reading above. The `intentDecision`
  // parameters that remain in memoryPolicy, patternAwareness and knowledgePages
  // are there for IntentIQ itself, the eval cases and the Logos path — not for
  // the live conversation.
  const intentDecision = null;

  const recall = await recallForTurn({
    userText, shape, intentDecision, conversationId, traceId, timing, decisionLogger,
    hindsight, foundation, conversationSearch, hypothesisRuntime, researchJobs,
  });
  const {
    reflections, mentalModels, recalledPatterns, knowledgePages, researchJob,
  } = recall;

  // The moment the run exists, tell the transport — a client can then show
  // that something is running in the background while this reply streams,
  // instead of finding out on its next poll.
  if (researchJob && typeof onResearchJob === 'function') {
    try {
      onResearchJob(researchJob);
    } catch (_) {
      // Telling the client is not worth failing a turn over.
    }
  }

  logRecallObservability({
    userText, shape, traceId, decisionLogger, hindsight,
    wantPatterns: recall.wantPatterns, reachSkill: recall.reachSkill, researchJob,
    reflections, mentalModels, recalledPatterns, knowledgePages,
  });

  const { assembled, buildAssembled, evidence, textAttachments, multimodalAttachments, now } = buildTurnPrompt({
    userText, messages, documents, attachments, conversationId, traceId, timing, decisionLogger,
    primary, backup, nativeGenerator, hermes, generator, foundation, conversationSearch,
    hindsight, aion, desktop, researchJobs, hypothesisRuntime,
    ...recall,
  });

  const { output, notConfigured } = await runGeneration({
    assembled, buildAssembled, textAttachments, multimodalAttachments, messages,
    primary, backup, desktop, onDelta, conversationId, traceId, signal, describeImage, timing,
  });

  // Response Engine seam: the one judgment of what generation output
  // means as reply text. Null ⇒ the caller's transport reports the calm
  // failure and no Hindsight reflection runs.
  const executionResult = (typeof output === 'string' && output.length > 0)
    ? { action: 'native', output }
    : null;
  const replyText = resolveReplyText(executionResult);

  timing.end('turn');
  timing.done({
    retrievalMs: timing.getDuration('memory_recall'),
    generationMs: timing.getDuration('generation'),
  });

  // Deferred cognition starts AFTER delivery and is never awaited.
  const startDeferredCognition = () => runDeferredCognition({
    hypothesisRuntime,
    hindsight,
    foundation,
    reasonIQ,
    aion,
    eleos,
    evidence,
    intentDecision,
    // Dezelfde lezing van de vraag als de poorten in de turn zelf gebruikten
    // (stap 4): de reflectiepoort leest de tekst dan niet nog eens.
    shape,
    // The turn's own clock: Logos judges recency against the moment of the
    // conversation, not against whenever the deferred phase happens to run.
    now,
    recalledReflections: reflections,
    executionResult,
    messages,
    userText,
    replyText: typeof replyText === 'string' && replyText.length > 0 ? replyText : null,
    conversationId,
    userDisplayName,
    decisionLogger,
    timing,
  }).catch((err) => {
    try {
      console.warn(`[gaia:deferred] cognition failed (non-fatal): ${err && err.message}`);
    } catch (_) { /* never rethrow */ }
  });

  return {
    executionResult,
    replyText: typeof replyText === 'string' && replyText.length > 0 ? replyText : null,
    timing,
    notConfigured,
    researchJob: researchJob || null,
    startDeferredCognition,
  };
}

/**
 * THE DEFERRED COGNITION PHASE — Gaia's internal learning/reflection
 * lifecycle for one COMPLETED turn, started after the reply exists and
 * never awaited on the response path.
 *
 * Hard boundary: this phase only processes the completed turn and updates
 * Gaia's internal knowledge/memory state. It must never decide, alter or
 * re-render what Gaia already said, never call the client transport, and
 * never reject — every failure is caught and logged here.
 *
 * What runs here, in order:
 *   1. Foundation observation registration (status `observation`, owned by Foundation).
 *   2. Memoryworthiness evaluation (cheap, deterministic).
 *   3. Hypothesis lifecycle preparation (manager state + best-effort
 *      recall) and background Logos reflection (depth heuristic gate; deep ⇒ one
 *      model call here, shallow ⇒ none). Feeds only the hypothesis
 *      lifecycle for FUTURE turns.
 *   4. hypothesisRuntime.manager.applyReasoningResult().
 *   5. Gated pattern formation.
 *   6. Cognitive observations / open questions / relationships retention.
 *   7. Post-turn Hindsight reflection, gated by Memoryworthiness.
 *   8. DecisionIQ review (did this turn need a specialized capability?)
 *      — observability only.
 *
 * @returns {Promise<void>} never rejects
 */
async function runDeferredCognition({
  hypothesisRuntime,
  hindsight,
  foundation,
  reasonIQ = evaluateLogos,
  aion,
  eleos,
  evidence,
  intentDecision,
  shape,
  recalledReflections,
  executionResult,
  messages,
  userText,
  replyText,
  conversationId,
  userDisplayName,
  decisionLogger,
  timing,
  now = Date.now(),
}) {
  // Steps 1, 7b and 7c do not depend on the reasoning chain (3-6), and it does
  // not depend on them, so they are started as soon as their input exists and
  // awaited together at the end. The chain stays sequential, and so does the
  // Hindsight reflection (7): it waits for the hypothesis preparation.
  const sideTasks = [];

  // 1. Foundation: the completed turn as a raw observation (Foundation owns
  //    the status — everything enters as `observation`). A missing client is
  //    silently skipped.
  if (foundation && typeof foundation.submitObservation === 'function' && replyText) {
    sideTasks.push((async () => {
      try {
        await foundation.submitObservation({
          content: userText ? `${userText}\n\n${replyText}` : replyText,
          source: 'gaia',
          turns: [
            ...(userText ? [{ role: 'user', text: userText }] : []),
            { role: 'assistant', text: replyText },
          ],
          tags: ['gaia-turn'],
          occurredAt: new Date().toISOString(),
        });
      } catch (_) {
        // Foundation must never break the deferred phase.
      }
    })());
  }

  // 2. Memoryworthiness 0.1: cheap deterministic judgment of whether this
  //    turn deserves a Hindsight memory at all.
  let memoryDecision = null;
  timing.start('deferred.memory_worthiness');
  try {
    const mwStartMs = Date.now();
    memoryDecision = evaluateMemoryWorthiness({
      userInput: userText,
      assistantReply: replyText,
      intent: intentDecision,
      conversationContext: messages,
      existingMemorySignals: { recalledReflections: recalledReflections || [] },
    });
    memoryDecision = applyCapabilityOutcomeOverride(memoryDecision, executionResult);
    logMemoryWorthiness(memoryDecision, Date.now() - mwStartMs, decisionLogger);
  } catch (_) {
    // A classification failure degrades to null → reflection gated off.
  }
  timing.end('deferred.memory_worthiness');

  // A DISCARDED turn closes the PATTERN FORMATION trigger below.
  // Hypothesis APPLICATION still runs: its lifecycle belongs to
  // HypothesisManager policy, and Memoryworthiness may not judge
  // hypothesis matters.
  const patternGateOpen = !memoryDecision || shouldRetainToHindsight(memoryDecision);

  // 7b. Aion — Gaia's own bank, at her own discretion. UNGATED by
  //     design: the Memoryworthiness gate above governs the `bojan` bank,
  //     not hers. The scheduler decides WHEN it runs (every few turns, and
  //     when the session ends); this only records the turn.
  if (aion && replyText) {
    sideTasks.push((async () => {
      timing.start('deferred.self_memory');
      try {
        const outcome = await aion.noteTurn({
          conversationId,
          messages,
          logger: decisionLogger,
        });
        timing.end('deferred.self_memory', { written: outcome && outcome.written });
      } catch (err) {
        timing.fail('deferred.self_memory', (err && err.constructor && err.constructor.name) || 'Error');
      }
    })());
  }

  // 7c. Eleos — the check-in faculty. It gates on the turn's own words (a
  //     free lexical check), and only on a real signal asks its model whether
  //     there is a moment worth coming back to, recording it as an open loop
  //     for the runtime to deliver later. Never reaches the user now.
  if (eleos && replyText) {
    sideTasks.push((async () => {
      timing.start('deferred.eleos');
      try {
        const outcome = await eleos.noteTurn({
          conversationId,
          messages,
          logger: decisionLogger,
        });
        timing.end('deferred.eleos', { outcome: outcome && (outcome.created || outcome.updated || outcome.cancelled || outcome.skipped) });
      } catch (err) {
        timing.fail('deferred.eleos', (err && err.constructor && err.constructor.name) || 'Error');
      }
    })());
  }

  // 3a. Hypothesis lifecycle preparation.
  let existingHypotheses = [];
  if (hypothesisRuntime) {
    timing.start('deferred.hypothesis_prep');
    try {
      if (typeof hypothesisRuntime.ensureLoaded === 'function') await hypothesisRuntime.ensureLoaded();
      existingHypotheses = hypothesisRuntime.manager.list().map((h) => ({
        id: h.id,
        statement: h.statement,
        status: h.status,
        confidence: h.confidence,
        evidenceFor: h.evidenceFor,
        evidenceAgainst: h.evidenceAgainst,
        persistence: h.persistence,
        updatedAt: h.updatedAt || h.updated_at || null,
      }));
    } catch (_) { /* seeding must never break the deferred phase */ }
    if (typeof hypothesisRuntime.recallHypotheses === 'function') {
      try {
        const recalled = await hypothesisRuntime.recallHypotheses(userText).catch(() => []);
        const known = new Set(existingHypotheses.map((h) => h.id));
        for (const rh of Array.isArray(recalled) ? recalled : []) {
          if (!rh || !rh.id || known.has(rh.id)) continue;
          existingHypotheses.push({
            id: rh.id,
            statement: rh.statement,
            status: rh.status || undefined,
            confidence: rh.confidence != null ? rh.confidence : undefined,
            evidenceFor: rh.evidenceFor || [],
            evidenceAgainst: rh.evidenceAgainst || [],
            persistence: rh.persistence,
            updatedAt: rh.updatedAt || rh.updated_at || null,
          });
        }
      } catch (_) { /* same posture */ }
    }
    timing.end('deferred.hypothesis_prep');
  }
  let existingPatterns = [];
  if (hypothesisRuntime && hypothesisRuntime.patternManager) {
    try {
      existingPatterns = hypothesisRuntime.patternManager.list().map((p) => ({
        id: p.id,
        statement: p.statement,
        status: p.status,
        confidence: typeof p.confidence === 'number' ? p.confidence : null,
        updatedAt: p.updatedAt || p.updated_at || null,
      }));
    } catch (_) { /* context seeding must never break the deferred phase */ }
  }

  // 3b. Background Logos — the depth heuristic (free, local) gates one
  //     model call HERE. Nothing produced can reach the user: the reply
  //     was delivered before this phase started.
  const backgroundReasoningInput = {
    text: userText,
    // The same instant the turn itself was given: Logos reasons about
    // recency against the moment of this conversation, not its own clock.
    now,
    intentHint: intentDecision,
    intentDecision,
    conversationContext: messages,
    evidence: Array.isArray(evidence) ? evidence : [],
    contextId: conversationId,
    correlationId: crypto.randomUUID(),
    assistantReply: typeof replyText === 'string' ? replyText : null,
    ...(hypothesisRuntime ? { existingHypotheses } : {}),
    ...(hypothesisRuntime ? { existingPatterns } : {}),
  };
  const reasoningDepth = decideLogosDepth(backgroundReasoningInput);
  try {
    logLogosGate(
      {
        depth: reasoningDepth,
        reason: explainLogosDepth(backgroundReasoningInput),
        intent: (intentDecision && intentDecision.intent) || null,
        evidenceCount: Array.isArray(evidence) ? evidence.length : 0,
        existingHypothesisCount: existingHypotheses.length,
        contextId: conversationId,
        correlationId: backgroundReasoningInput.correlationId,
      },
      decisionLogger
    );
  } catch (_) { /* observability never breaks the deferred phase */ }
  let reasoningResult = null;
  // A turn that produced no reply has nothing to reflect on: no model call.
  if (reasoningDepth === 'deep' && replyText) {
    timing.start('reasoning_background');
    try {
      reasoningResult = await reasonIQ(backgroundReasoningInput, { logger: decisionLogger });
      timing.end('reasoning_background', { reasoningDepth: reasoningResult && reasoningResult.reasoningDepth });
    } catch (err) {
      reasoningResult = null;
      timing.fail('reasoning_background', (err && err.constructor && err.constructor.name) || 'Error');
    }
  }

  // 4. The structured result flows into the manager.
  if (hypothesisRuntime && reasoningResult) {
    let durableSignaturesBefore = null;
    try {
      durableSignaturesBefore = new Set(
        hypothesisRuntime.manager.list()
          .filter((h) => h.persistence === 'durable')
          .map((h) => `${h.id}:${h.updatedAt}`)
      );
    } catch (_) {}
    try {
      hypothesisRuntime.manager.applyReasoningResult(reasoningResult);
    } catch (err) {
      console.warn(`[gaia:hypotheses] applyReasoningResult failed (non-fatal): ${err.message}`);
    }
    // 5. Gated pattern formation: needs ≥1 DURABLE hypothesis
    //    created/changed by THIS turn AND a non-discarded turn.
    if (hypothesisRuntime.patternManager && durableSignaturesBefore && patternGateOpen) {
      try {
        const changedIds = hypothesisRuntime.manager.list()
          .filter((h) => h.persistence === 'durable' && !durableSignaturesBefore.has(`${h.id}:${h.updatedAt}`))
          .map((h) => h.id);
        if (changedIds.length > 0) {
          hypothesisRuntime.patternManager.maybeFormPatterns({
            hypotheses: hypothesisRuntime.manager.list(),
            changedHypothesisIds: changedIds,
          });
        }
      } catch (err) {
        console.warn(`[gaia:patterns] formation failed (non-fatal): ${err.message}`);
      }
    }
    // 6. Cognitive Analysis Model v1.0 — durable observations, open
    //    questions and relationships persist as ordinary world facts.
    //    Deliberately IGNORES the Memoryworthiness gate: Gaia-knowledge,
    //    not conversational memory.
    if (hypothesisRuntime.cognition && reasoningResult) {
      const { retainObservation, retainOpenQuestion, retainRelationship } = hypothesisRuntime.cognition;
      const observations = Array.isArray(reasoningResult.observations) ? reasoningResult.observations : [];
      const openQuestions = Array.isArray(reasoningResult.openQuestions) ? reasoningResult.openQuestions : [];
      const relationships = Array.isArray(reasoningResult.relationships) ? reasoningResult.relationships : [];
      // The three kinds, and the items inside each, are independent writes to
      // Cognition/Foundation, so they go out together. One failed item is
      // logged and never stops the others.
      const retainAll = async (retain, items, label, timingKey, countKey) => {
        if (typeof retain !== 'function' || items.length === 0) return;
        timing.start(timingKey);
        const settled = await Promise.allSettled(items.map((item) => retain(item)));
        for (const result of settled) {
          if (result.status === 'rejected') {
            const message = result.reason && result.reason.message ? result.reason.message : result.reason;
            console.warn(`[gaia:cognition] ${label} retention failed (non-fatal): ${message}`);
          }
        }
        timing.end(timingKey, { [countKey]: items.length });
      };
      await Promise.all([
        retainAll(retainObservation, observations, 'observation', 'deferred.cognition_observations', 'observationCount'),
        retainAll(retainOpenQuestion, openQuestions, 'open question', 'deferred.cognition_open_questions', 'openQuestionCount'),
        retainAll(retainRelationship, relationships, 'relationship', 'deferred.cognition_relationships', 'relationshipCount'),
      ]);
    }
  }

  // 7. Post-turn Hindsight reflection — gated by Memoryworthiness. A turn
  //    that produced no reply is never reflected. Conversation history
  //    saves EVERY turn regardless; Hindsight is what Gaia remembers.
  if (hindsight && replyText && (!memoryDecision || shouldRetainToHindsight(memoryDecision))) {
    try {
      reflectOnTurn(hindsight, {
        conversationId,
        userText,
        assistantText: replyText,
        metadata: metadataForMemoryDecision(memoryDecision),
        userDisplayName,
        capabilityExecutor: 'generation',
        shape,
      });
    } catch (_) {
      // reflectOnTurn never lets a Hindsight failure escape; this guards
      // the call itself.
    }
  }

  await Promise.all(sideTasks);

  // 8. DecisionIQ review — post-turn only, observability only.
  try {
    reflectDecisionIQ({ userText, decisionLogger });
  } catch (_) { /* never break the deferred phase */ }
}

/**
 * Performs one conversational turn — NON-STREAMING transport.
 *
 * Same direct-generation pipeline as performStreamingTurn (runTurnCore);
 * delivery is one plain JSON `{ reply }`, plus a `research` field when a
 * background research job was submitted on this turn so a client can show
 * that work is still running. No generation configured ⇒ calm 503;
 * configured providers failing ⇒ calm 502 via the Response Engine. Hermes is
 * never called as a generator — only handed a research run it does in the
 * background (src/researchJob.js).
 */
async function performTurn({ messages, documents, ...turn }) {
  const problem = validateMessages(messages);
  if (problem) {
    return { status: 400, body: { error: problem } };
  }

  // `turn` is everything runTurnCore takes besides the two required inputs
  // (generators, stores, runtimes, attachments, ids, ...): it is passed through
  // as is, so a new capability is added in runTurnCore and its caller only.
  const { replyText, timing, notConfigured, researchJob, startDeferredCognition } = await runTurnCore({
    messages,
    documents,
    ...turn,
  });
  void timing;

  // Deferred cognition is deliberately NOT awaited — learning/reflection
  // runs in the background once the response is on its way.
  const deferredCognition = startDeferredCognition();
  void deferredCognition;

  const researchExtras = researchJob ? { research: researchJobView(researchJob) } : {};

  if ((typeof replyText !== 'string' || replyText.length === 0) && notConfigured) {
    return { status: 503, body: { error: toCalmError() } };
  }

  return formatReply(replyText, researchExtras);
}

function abortError() {
  const error = new Error('turn aborted');
  error.name = 'AbortError';
  return error;
}

/**
 * Saves a turn the client cut off. The user's question stands; whatever part of the reply was already
 * streamed is kept and marked `interrupted: true`, so a transcript reader (and the next turn's history)
 * sees exactly what was said, no more. Never throws.
 */
function recordInterruptedTurn({ historyStore, conversationId, messages, partial, traceId }) {
  logEvent(undefined, {
    kind: 'turn.interrupted',
    traceId: traceId || null,
    partialChars: partial ? partial.length : 0,
  });
  if (!historyStore || !conversationId) return;
  try {
    const saved = partial && partial.trim().length > 0
      ? [...messages, { role: 'assistant', content: partial, interrupted: true }]
      : messages;
    historyStore.saveConversation(conversationId, saved);
  } catch (_) {
    // Saving a transcript is never worth failing over.
  }
}

/**
 * Performs one conversational turn, STREAMED. Same direct-generation
 * pipeline as performTurn; delivery is SSE through the Response Engine's
 * emitter. Failover to the backup runs only before the first visible
 * content token — afterwards a failure is reported calmly on the open
 * stream and no second generation starts.
 */
async function performStreamingTurn({
  messages,
  documents,
  res,
  conversationId,
  traceId,
  signal,
  historyStore,
  desktopBroker,
  desktopClient,
  desktopRoots,
  desktopPlaces,
  desktopIndex,
  ...turn
}) {
  const problem = validateMessages(messages);
  if (problem) {
    res.status(400).json({ error: problem });
    return;
  }

  const emitter = createStreamEmitter(res);

  // The desktop is real this turn only when the server runs the broker AND the client declared that
  // it can carry out actions. The frames ride this turn's open stream; nothing else can reach the client.
  const desktop = desktopBroker && desktopClient === true
    ? desktopBroker.forTurn({
      emit: (view) => { if (!res.writableEnded) emitter.desktop(view); },
      conversationId,
      roots: desktopRoots,
      places: desktopPlaces,
      index: desktopIndex,
      ...(signal ? { signal } : {}),
    })
    : undefined;

  let timeToFirstTokenMs = null;
  let contentEmitted = false;
  // What the user has actually been sent so far: the reply as far as it got, if they cut it off.
  let streamed = '';
  const onDelta = trackFirstToken(
    (chunk, isReasoning) => {
      if (chunk && !isReasoning) {
        contentEmitted = true;
        streamed += chunk;
      }
      emitter.delta(chunk, { reasoning: isReasoning });
    },
    { onFirstToken: (ms) => { timeToFirstTokenMs = ms; } }
  );

  let coreResult;
  try {
    // A `remember` that keeps something in the shared memory while she answers is announced to the client
    // as it happens (the frame is only ever written while this stream is open).
    coreResult = await withKeptNotifier(
      (kept) => {
        if (!res.writableEnded) emitter.memory(kept);
      },
      () => runTurnCore({
        messages,
        documents,
        conversationId,
        traceId,
        desktop,
        onDelta,
        onResearchJob: (job) => emitter.research(researchJobView(job)),
        signal,
        ...turn,
      })
    );
  } catch (_) {
    if (signal && signal.aborted) {
      // The client left mid-turn (it interrupted Gaia). There is nobody to write to, and nothing to learn
      // from a reply nobody finished hearing: save what was said, marked interrupted, and stop. No
      // reflection, no deferred cognition.
      recordInterruptedTurn({ historyStore, conversationId, messages, partial: streamed, traceId });
      return;
    }
    emitter.fail();
    return;
  }

  const { replyText, timing, notConfigured, startDeferredCognition } = coreResult;
  void timing;

  if (timeToFirstTokenMs !== null) {
    logEvent(undefined, {
      kind: 'gaia.timing',
      traceId,
      stage: 'generation.first_token',
      timeToFirstTokenMs,
    });
  }

  // Nothing usable was said: calm failure. Unconfigured generation with
  // nothing shipped yet is a 503 JSON; otherwise the Response Engine
  // owns the shape (JSON before headers, error frame after).
  if (typeof replyText !== 'string' || replyText.length === 0) {
    if (notConfigured && !contentEmitted) {
      try {
        res.status(503).json({ error: toCalmError() });
      } catch (_) {
        emitter.fail();
      }
    } else {
      emitter.fail();
    }
    const deferredCognition = startDeferredCognition();
    void deferredCognition;
    return;
  }

  // The reply either already streamed as deltas or is written here as one
  // final delta — exactly once (responseEngine.deliverReply).
  deliverReply(emitter, replyText, { contentEmitted });

  // The conversation's own name: only on its first turn (the store has no
  // title yet — a store that cannot tell us is never asked to guess), and only
  // when the same generator that just answered is available. The exchange is
  // handed over with it, so the name says what the thread is ABOUT instead of
  // repeating the opening sentence; conversationStore.deriveTitle stays the
  // fallback for a name that never comes. The wait is bounded — a slow
  // provider costs the reply nothing but the frame below, and the late name is
  // written into the transcript instead (after the save, further down).
  let title = null;
  let pendingTitle = null;
  if (
    historyStore &&
    conversationId &&
    typeof historyStore.getTitle === 'function' &&
    historyStore.getTitle(conversationId) === null
  ) {
    const titleGenerator = resolveLiveGenerators(turn).primary;
    pendingTitle = generateConversationTitle({ generator: titleGenerator, messages, replyText });
    title = await withDeadline(pendingTitle, TITLE_DEADLINE_MS);
    if (title) emitter.title({ text: title });
  }

  emitter.finish();

  const deferredCognition = startDeferredCognition();
  void deferredCognition;

  // Chat history — the raw transcript, never Hindsight's job. Never
  // allowed to affect the already-sent response.
  if (historyStore && conversationId) {
    try {
      historyStore.saveConversation(
        conversationId,
        [...messages, { role: 'assistant', content: replyText }],
        title ? { title } : {}
      );
      // A name that missed the deadline still belongs on the conversation: it
      // arrives here, after the transcript exists, and only ever fills a title
      // that is still derived (setTitle refuses to rename a chosen one).
      if (!title && pendingTitle) {
        void pendingTitle
          .then((late) => {
            if (late) historyStore.setTitle(conversationId, late);
          })
          // setTitle writes a file; a failure here must not become an unhandled rejection.
          .catch(() => {});
      }
    } catch (_) {
      // Never break a turn that already completed successfully.
    }
  }
}

module.exports = {
  validateMessages,
  assembleMessages,
  performTurn,
  performStreamingTurn,
  renderAttachmentContext,
  renderTextAttachmentContext,
};
