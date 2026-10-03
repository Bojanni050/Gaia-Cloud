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
 * BACKGROUND (Logos is the reflection on the experience): Chronicle
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
 */

const { buildSystemPrompt } = require('./foundation');
const { recallRelevantContext, renderMemoryContext, reflectOnTurn, fetchMentalModelContext, renderMentalModelContext } = require('./memory');
const { searchRelevantKnowledgePages, renderKnowledgePageContext } = require('./knowledgePages');
const { assembleEvidence } = require('./reasoning/evidenceAssembler');
const {
  evaluateMemoryWorthiness, shouldRetainToHindsight, applyCapabilityOutcomeOverride,
  metadataForMemoryDecision, logMemoryWorthiness,
} = require('./memoryWorthiness');
const { shouldAttemptPatternRetrieval, renderPatternContextBlock, logPatternAwareness, evaluatePatternUsage } = require('./reasoning/patternAwareness');
const { renderCapabilityAwareness } = require('./capabilityAwareness');
const { evaluate: evaluateLogos, decideLogosDepth, explainLogosDepth } = require('./logos/logos');
const { logLogosGate } = require('./logos/logosLog');
const { shouldRecall } = require('./memoryPolicy');
const { logRecallMeasure } = require('./recallLog');
const crypto = require('crypto');
const {
  formatReply, createStreamEmitter, resolveReplyText, deliverReply, toCalmError,
} = require('./responseEngine');
const { generateWithFailover, streamWithFailover, isNotConfiguredError } = require('./generation/generationFailover');
const { createTurnTiming, trackFirstToken } = require('./timing');

const ALLOWED_ROLES = new Set(['user', 'assistant', 'system']);

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
    adapter.stream = (messages, { onDelta } = {}) => hermes.stream(messages, { onDelta });
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
function generationCapabilities({ primary }, { nativeGenerator, hermes, generator } = {}) {
  if ((generator || nativeGenerator || primary) && !(hermes && !generator && !nativeGenerator)) {
    return [{ id: 'native' }];
  }
  if (hermes) return [{ id: 'hermes' }];
  return [];
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
    const line = JSON.stringify({
      kind: 'decision.review',
      couldHaveUsedCapability: signals.length > 0 ? signals : null,
      note: 'post-turn reflection only — the delivered reply stands',
    });
    if (decisionLogger) decisionLogger(line);
    else console.log(line);
  } catch (_) {
    // Observability must never take down a turn.
  }
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
 * routing in this path.
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
 *   chronicle?: { append: Function }|null,
 *   hypothesisRuntime?: object|null,
 *   decisionStore?: { append: (record: object) => boolean },
 *   reasonIQ?: Function, // background Logos evaluator (legacy param name, kept for tests/callers)
 *   logos?: Function, // preferred alias for reasonIQ above
 *   onDelta?: Function,
 *   userDisplayName?: string,
 * }} input
 * @returns {Promise<{ executionResult: object|null, replyText: string|null, timing: object, notConfigured: boolean, startDeferredCognition: () => Promise<void> }>}
 */
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
  chronicle,
  hypothesisRuntime,
  decisionStore,
  reasonIQ = evaluateLogos,
  onDelta,
  userDisplayName,
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

  // No live interpretation: language understanding happens inside the
  // single inference call. The gate below therefore runs on lexical
  // policy only (memoryPolicy.shouldRecall with no intent decision).
  const intentDecision = null;

  // Gated recall — Hindsight only on explicit requests or content
  // triggers, never by default. Pattern recall rides the same gated
  // moment through the hypothesisRuntime adapter seam.
  const wantPatterns = Boolean(
    hypothesisRuntime
    && typeof hypothesisRuntime.recallPatterns === 'function'
    && hindsight
    && shouldAttemptPatternRetrieval(userText, intentDecision)
  );
  timing.start('memory_recall');
  const [reflections, mentalModels, recalledPatterns, knowledgePages] = await Promise.all([
    hindsight
      ? recallRelevantContext(hindsight, userText, { intentDecision })
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
  ]);
  timing.end('memory_recall');

  // Meetbasis voor Gaia-geïnitieerde recall: één regel per turn met gate
  // en counts only (nooit user-/memory-inhoud). Blijft werken zonder
  // decisionStore via console.log-default; met store is hij ook duurzaam
  // voor `GET /admin/api/logos/decisions`.
  try {
    logRecallMeasure({
      traceId: traceId || null,
      gated: shouldRecall(userText, { intentDecision }),
      hasHindsight: Boolean(hindsight),
      reflectionCount: Array.isArray(reflections) ? reflections.length : 0,
      mentalModelCount: Array.isArray(mentalModels) ? mentalModels.length : 0,
      patternCount: Array.isArray(recalledPatterns) ? recalledPatterns.length : 0,
      knowledgePageCount: Array.isArray(knowledgePages) ? knowledgePages.length : 0,
      queryLength: String(userText || '').length,
      wantPatterns,
    }, decisionLogger);
  } catch (_) {
    // Observability must never take down a turn.
  }

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
  const availableCapabilities = generationCapabilities({ primary: primary, backup }, { nativeGenerator, hermes, generator });
  const systemPrompt = buildSystemPrompt(documents, messages);
  const memoryBlock = renderMemoryContext(reflections);
  const mentalModelBlock = renderMentalModelContext(mentalModels);
  const knowledgePageBlock = renderKnowledgePageContext(knowledgePages);
  const attachmentBlock = renderTextAttachmentContext(textAttachments);
  const patternBlock = renderPatternContextBlock(
    patternUsage,
    new Map(recalledPatterns.filter((c) => c && c.id != null).map((c) => [String(c.id), c]))
  );

  const systemMessages = [{ role: 'system', content: systemPrompt }];
  const capabilityBlock = renderCapabilityAwareness(availableCapabilities);
  if (capabilityBlock) systemMessages.push({ role: 'system', content: capabilityBlock });
  if (mentalModelBlock) systemMessages.push({ role: 'system', content: mentalModelBlock });
  if (knowledgePageBlock) systemMessages.push({ role: 'system', content: knowledgePageBlock });
  if (memoryBlock) systemMessages.push({ role: 'system', content: memoryBlock });
  if (attachmentBlock) systemMessages.push({ role: 'system', content: attachmentBlock });
  if (patternBlock) systemMessages.push({ role: 'system', content: patternBlock });

  // Conversational tone, empathy and follow-up judgment are left entirely
  // to the inference model, guided by SOUL — no per-turn opportunity /
  // quality-bar / conversational-state injection.
  const assembled = assembleMessages(null, [...systemMessages, ...messages.map(({ role, content }) => ({ role, content }))], multimodalAttachments);

  const lastUserMsg = assembled.find((m) => m.role === 'user');
  if (lastUserMsg) {
    console.log(JSON.stringify({
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
    }));
  }

  // Direct generation with primary/backup failover. Hermes is never
  // involved unless a legacy caller adapted it as the primary above.
  let output = null;
  let notConfigured = false;
  timing.start('generation');
  try {
    if (onDelta) {
      output = await streamWithFailover(assembled, { primary, backup, onDelta });
    } else {
      output = await generateWithFailover(assembled, { primary, backup });
    }
    timing.end('generation');
  } catch (err) {
    try { timing.end('generation'); } catch (_) { /* never break a turn */ }
    if (isNotConfiguredError(err)) {
      notConfigured = true;
    }
    output = null;
  }

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
    chronicle,
    reasonIQ,
    evidence,
    intentDecision,
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
 *   1. Chronicle observation registration (status `observation`).
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
  chronicle,
  reasonIQ = evaluateLogos,
  evidence,
  intentDecision,
  recalledReflections,
  executionResult,
  messages,
  userText,
  replyText,
  conversationId,
  userDisplayName,
  decisionLogger,
  timing,
}) {
  // 1. Chronicle: the completed turn as a source fact. Fire-and-forget
  //    inside the deferred phase; a missing client is silently skipped.
  if (chronicle && typeof chronicle.append === 'function' && replyText) {
    try {
      await chronicle.append({
        status: 'observation',
        conversationId,
        userText,
        assistantText: replyText,
      });
    } catch (_) {
      // The archive must never break the deferred phase.
    }
  }

  // 2. Memoryworthiness 0.1: cheap deterministic judgment of whether this
  //    turn deserves a Hindsight memory at all.
  let memoryDecision = null;
  timing.start('deferred.memory_worthiness');
  try {
    const mwStartMs = Date.now();
    memoryDecision = evaluateMemoryWorthiness({
      userInput: userText,
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
      }));
    } catch (_) { /* context seeding must never break the deferred phase */ }
  }

  // 3b. Background Logos — the depth heuristic (free, local) gates one
  //     model call HERE. Nothing produced can reach the user: the reply
  //     was delivered before this phase started.
  const backgroundReasoningInput = {
    text: userText,
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
  if (reasoningDepth === 'deep') {
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
      if (typeof retainObservation === 'function' && observations.length > 0) {
        timing.start('deferred.cognition_observations');
        try {
          for (const o of observations) {
            await retainObservation(o);
          }
        } catch (err) {
          console.warn(`[gaia:cognition] observation retention failed (non-fatal): ${err.message}`);
        }
        timing.end('deferred.cognition_observations', { observationCount: observations.length });
      }
      if (typeof retainOpenQuestion === 'function' && openQuestions.length > 0) {
        timing.start('deferred.cognition_open_questions');
        try {
          for (const q of openQuestions) {
            await retainOpenQuestion(q);
          }
        } catch (err) {
          console.warn(`[gaia:cognition] open question retention failed (non-fatal): ${err.message}`);
        }
        timing.end('deferred.cognition_open_questions', { openQuestionCount: openQuestions.length });
      }
      if (typeof retainRelationship === 'function' && relationships.length > 0) {
        timing.start('deferred.cognition_relationships');
        try {
          for (const r of relationships) {
            await retainRelationship(r);
          }
        } catch (err) {
          console.warn(`[gaia:cognition] relationship retention failed (non-fatal): ${err.message}`);
        }
        timing.end('deferred.cognition_relationships', { relationshipCount: relationships.length });
      }
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
      });
    } catch (_) {
      // reflectOnTurn never lets a Hindsight failure escape; this guards
      // the call itself.
    }
  }

  // 8. DecisionIQ review — post-turn only, observability only.
  try {
    reflectDecisionIQ({ userText, decisionLogger });
  } catch (_) { /* never break the deferred phase */ }
}

/**
 * Performs one conversational turn — NON-STREAMING transport.
 *
 * Same direct-generation pipeline as performStreamingTurn (runTurnCore);
 * delivery is one plain JSON `{ reply }`. No generation configured ⇒
 * calm 503; configured providers failing ⇒ calm 502 via the Response
 * Engine. Hermes is never called.
 */
async function performTurn({
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
  chronicle,
  hypothesisRuntime,
  decisionStore,
  reasonIQ,
  userDisplayName,
}) {
  const problem = validateMessages(messages);
  if (problem) {
    return { status: 400, body: { error: problem } };
  }

  const { replyText, timing, notConfigured, startDeferredCognition } = await runTurnCore({
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
    chronicle,
    hypothesisRuntime,
    decisionStore,
    ...(reasonIQ ? { reasonIQ } : {}),
    userDisplayName,
  });
  void timing;

  // Deferred cognition is deliberately NOT awaited — learning/reflection
  // runs in the background once the response is on its way.
  const deferredCognition = startDeferredCognition();
  void deferredCognition;

  if (typeof replyText !== 'string' || replyText.length === 0) {
    if (notConfigured) {
      return { status: 503, body: { error: toCalmError() } };
    }
    return formatReply(replyText);
  }

  return formatReply(replyText);
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
  hindsight,
  res,
  conversationId,
  generator,
  backupGenerator,
  nativeGenerator,
  hermes,
  chronicle,
  attachments,
  traceId,
  reasonIQ,
  hypothesisRuntime,
  historyStore,
  decisionStore,
  userDisplayName,
}) {
  const problem = validateMessages(messages);
  if (problem) {
    res.status(400).json({ error: problem });
    return;
  }

  const emitter = createStreamEmitter(res);

  let timeToFirstTokenMs = null;
  let contentEmitted = false;
  const onDelta = trackFirstToken(
    (chunk, isReasoning) => {
      if (chunk && !isReasoning) contentEmitted = true;
      emitter.delta(chunk, { reasoning: isReasoning });
    },
    { onFirstToken: (ms) => { timeToFirstTokenMs = ms; } }
  );

  let coreResult;
  try {
    coreResult = await runTurnCore({
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
      chronicle,
      hypothesisRuntime,
      decisionStore,
      ...(reasonIQ ? { reasonIQ } : {}),
      onDelta,
      userDisplayName,
    });
  } catch (_) {
    emitter.fail();
    return;
  }

  const { replyText, timing, notConfigured, startDeferredCognition } = coreResult;
  void timing;

  if (timeToFirstTokenMs !== null) {
    try {
      console.log(JSON.stringify({
        kind: 'gaia.timing',
        traceId,
        stage: 'generation.first_token',
        timeToFirstTokenMs,
      }));
    } catch (_) { /* never break a turn */ }
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
  emitter.finish();

  const deferredCognition = startDeferredCognition();
  void deferredCognition;

  // Chat history — the raw transcript, never Hindsight's job. Never
  // allowed to affect the already-sent response.
  if (historyStore && conversationId) {
    try {
      historyStore.saveConversation(conversationId, [...messages, { role: 'assistant', content: replyText }]);
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
