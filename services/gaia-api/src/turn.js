'use strict';

/**
 * Turn handling — the server side of the desktop's `conversation/turn`
 * contract (desktop/src/state/contract.js).
 *
 * COGNITIVE PARITY (this module's load-bearing rule): the non-streaming and
 * streaming paths share ONE cognitive pipeline — `runTurnCore` below — and
 * differ ONLY in delivery/transport. IntentIQ, Hindsight recall, Memory-
 * worthiness, evidence assembly, hypothesis persistence, ReasonIQ, gated
 * pattern formation, Pattern Awareness, the Decision Engine, the prompt
 * assembly and the post-turn Hindsight reflection are byte-for-byte the
 * same judgment calls whichever transport a client uses. What may differ:
 *
 *   - wire shape: SSE deltas (streaming) vs one JSON body (non-streaming)
 *   - hermes invocation: stream(msgs,{onDelta}) vs chat(msgs)
 *   - reply finalization: generateStreamingReply's emitter dance vs
 *     formatReply — both twins of responseEngine.resolveReplyText
 *   - history-save timing: inline after the stream finishes (streaming)
 *     vs a fire-and-forget save in the route handler (non-streaming)
 *
 * The reply returned is plain text — no model names, no provider details,
 * no chain-of-thought ever cross this seam. Whatever a capability produces
 * is always handed to responseEngine.js, which is the only place that
 * decides what actually reaches the client.
 *
 * Chat history (conversationStore.js) is saved as a fire-and-forget side
 * effect AFTER a turn succeeds — deliberately not part of producing the
 * reply. Conversation history remembers everything; Hindsight receives
 * only what Memoryworthiness judged worth remembering.
 */

const { buildSystemPrompt } = require('./foundation');
const { recallRelevantContext, renderMemoryContext, reflectOnTurn, fetchMentalModelContext, renderMentalModelContext } = require('./memory');
const { searchRelevantKnowledgePages, renderKnowledgePageContext } = require('./knowledgePages');
const { assembleEvidence } = require('./reasoning/evidenceAssembler');
const {
  evaluateMemoryWorthiness, shouldRetainToHindsight, metadataForMemoryDecision, logMemoryWorthiness,
} = require('./memoryWorthiness');
const { shouldAttemptPatternRetrieval, renderPatternContextBlock, logPatternAwareness } = require('./reasoning/patternAwareness');
const { renderCapabilityAwareness } = require('./capabilityAwareness');
const { interpret: classifyIntent } = require('./logos/intentIQ');
const { evaluate: evaluateReasoning } = require('./logos/reasonIQ');
const { renderOpportunityGuidance } = require('./logos/conversationalOpportunity');
const { renderConversationalState } = require('./logos/conversationalState');
const {
  formatReply, createStreamEmitter, resolveReplyText,
} = require('./responseEngine');
const { decide: decideAction } = require('./decision/decisionEngine');
const { execute: executeDecision } = require('./orchestration/orchestrator');
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
 * Assembles the message list sent to a capability: system messages first,
 * then the client's history verbatim (role + content only — any client-side
 * fields are already stripped by the desktop contract and dropped again
 * here, so nothing local ever reaches the reasoning path).
 *
 * PATCH: Native Vision Support
 * When multimodalAttachments are present, the last user message is
 * converted to multimodal content format:
 *   content: [
 *     { type: "text", text: "user message" },
 *     { type: "image_url", image_url: { url: "data:image/png;base64,..." } }
 *   ]
 */
function assembleMessages(systemPrompt, messages, multimodalAttachments = []) {
  // Build base messages, handling null/undefined systemPrompt
  const baseMessages = [];
  if (systemPrompt) {
    baseMessages.push({ role: 'system', content: systemPrompt });
  }
  baseMessages.push(...messages.map(({ role, content }) => ({ role, content })));

  // PATCH: If no multimodal attachments, return plain text messages
  if (!Array.isArray(multimodalAttachments) || multimodalAttachments.length === 0) {
    return baseMessages;
  }

  // Find the last user message to attach images to
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

  // Convert to multimodal content format
  const userText = baseMessages[lastUserIdx].content;
  const contentBlocks = [
    { type: 'text', text: userText },
  ];

  // Add each image as a content block
  for (const attachment of multimodalAttachments) {
    if (attachment.imageBytes && attachment.imageMimeType) {
      const dataUrl = `data:${attachment.imageMimeType};base64,${attachment.imageBytes.toString('base64')}`;
      contentBlocks.push({
        type: 'image_url',
        image_url: { url: dataUrl },
      });

      // Diagnostic logging (temporary)
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

  // Replace the last user message with multimodal content
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
  // Filter out multimodal attachments (those with imageBytes)
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
 * Adapts a raw web-search client (src/tools/braveSearch.js's
 * `{ search, searchResults }`) into the generic `{ invoke }` capability
 * shape the Orchestrator expects (orchestration/orchestrator.js).
 *
 * Two modes, determined by the input convention:
 *
 *   PLAN MODE (retrieval step): buildPlan uses `input.query`. Returns
 *   structured { results, total } for downstream generation steps. Raw
 *   web results never stream to the client — the native generation step
 *   speaks for Gaia.
 *
 *   LEGACY MODE (documented single-action fallback): input has
 *   `userInput`. Used when the plan was discarded (e.g. native not
 *   registered). Returns formatted text and streams it via onDelta —
 *   the best available output without a generation path.
 *
 * Observability: emits web.search JSON lines (completed/failed + latency)
 * to docker logs — never user content, never capability internals.
 *
 * @param {{ search: Function, searchResults?: Function }} webSearch
 * @returns {{ invoke: (messages: Array, options?: object) => Promise<*> }}
 */
function webCapability(webSearch) {
  return {
    invoke: async (messages, { onDelta, input } = {}) => {
      const startedAt = Date.now();
      try {
        // PLAN MODE: buildPlan convention uses `input.query`.
        // Returns structured { results, total } for downstream generation;
        // no onDelta — raw web results never stream to the client.
        if (typeof input && typeof input.query === 'string') {
          if (typeof webSearch.searchResults !== 'function') {
            // Fallback for older webSearch clients without searchResults:
            // degrade to formatted text wrapped in structured shape.
            const text = await webSearch.search(input.query);
            return { results: [{ text, source: 'web', relevance: 0.5 }], total: 1 };
          }
          const out = await webSearch.searchResults(input.query);
          console.log(JSON.stringify({ kind: 'web.search', stage: 'completed', resultCount: out.total, latencyMs: Date.now() - startedAt }));
          return out;
        }
        // LEGACY MODE (documented single-action fallback): input has
        // `userInput`. Terminal capability; streams formatted text directly.
        const query = (input && input.userInput) || '';
        const text = await webSearch.search(query);
        console.log(JSON.stringify({ kind: 'web.search', stage: 'completed', resultCount: 0, latencyMs: Date.now() - startedAt }));
        if (onDelta) onDelta(text, false);
        return text;
      } catch (err) {
        console.log(JSON.stringify({ kind: 'web.search', stage: 'failed', latencyMs: Date.now() - startedAt }));
        throw err;
      }
    },
  };
}

/**
 * Logs the Decision Engine's plan for this turn — action, the context
 * sources it drew on, its reasoning level, and which capability(ies) it
 * needs (decisionSchema.js's additive plan fields) — never the user's own
 * input text. When `logger` is given (the decisionStore twin), it both
 * console.logs and persists to decisionStore, exactly like IntentIQ/
 * ReasonIQ's own decision lines; otherwise this just console.logs, for
 * live `docker logs` visibility on paths that have no decisionStore wired
 * in. Never allowed to affect the turn.
 */
function logDecisionPlan(decision, logger) {
  try {
    const line = JSON.stringify({
      kind: 'decision.plan',
      action: decision.action,
      capability: decision.capability || null,
      context: decision.context || [],
      reasoning: decision.reasoning || 'none',
      capabilities: decision.capabilities || [],
      generationMode: decision.generationMode || null,
      reason: decision.reason || null,
    });
    if (logger) {
      logger(line);
    } else {
      console.log(line);
    }
  } catch (_) {
    // Observability must never take down a real conversational turn.
  }
}

/**
 * THE SHARED COGNITIVE PIPELINE — one implementation, two transports.
 *
 * Everything from IntentIQ to the post-turn reflection lives here exactly
 * once. The only transport knob is `onDelta`: present ⇒ capabilities may
 * stream (hermes.stream) and the caller renders SSE; absent ⇒ capabilities
 * return final strings (hermes.chat) and the caller renders one JSON body.
 * Cognitive outputs (intentDecision, memoryDecision, recalledPatterns,
 * reasoningResult, decision, assembled prompt, replyText, reflection) are
 * identical for identical requests regardless of that knob.
 *
 * @param {{
 *   messages: Array<{role: string, content: string}>,
 *   documents: Record<string, string>,
 *   hermes: { chat?: Function, stream?: Function },
 *   hindsight?: object|null,
 *   attachments?: Array<{ filename: string, content: string|null, imageBytes?: Buffer, imageMimeType?: string }>,
 *   traceId?: string,
 *   conversationId?: string,
 *   nativeGenerator?: { generate: Function, stream?: Function },
 *   webSearch?: { search: Function },
 *   intentIQ?: Function,
 *   reasonIQ?: Function,
 *   hypothesisRuntime?: { manager: object, recallHypotheses?: Function,
 *                         recallPatterns?: Function, ensureLoaded?: Function }|null,
 *   historyStore?: { saveConversation: Function },
 *   decisionStore?: { append: (record: object) => boolean },
 *   tools?: Record<string, { invoke: Function }>,
 *   decisionEngine?: Function,
 *   orchestrate?: Function,
 *   onDelta?: Function,
 * }} input
 * @returns {Promise<{ decision: object, executionResult: object|null, replyText: string|null }>}
 *   replyText is null exactly when there is nothing to say (capability
 *   produced nothing usable, or execution failed) — the CALLER decides how
 *   its transport reports that (calm 502 body vs emitter.fail()).
 */
async function runTurnCore({
  messages,
  documents,
  hermes,
  hindsight,
  attachments,
  traceId,
  conversationId,
  nativeGenerator,
  webSearch,
  intentIQ = classifyIntent,
  reasonIQ = evaluateReasoning,
  hypothesisRuntime,
  decisionStore,
  tools,
  decisionEngine = decideAction,
  orchestrate = executeDecision,
  onDelta,
  userDisplayName,
}) {
  const userText = latestUserText(messages);

  // Pipeline latency tracing — one timing context per turn, shared across
  // all stages. Zero overhead when no log function is available.
  const timing = createTurnTiming(traceId || `trace-${Date.now()}`);
  timing.start('turn');

  // Both console.log (unchanged, for live `docker logs` tailing) and, when
  // a decisionStore is given, a durable JSONL line (decisionStore.js) —
  // console output alone doesn't survive past Docker's own log retention.
  // Store-write failures are swallowed; observability must never affect a
  // real turn. Identical on both transports.
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

  // Logos: IntentIQ observes the turn and produces an IntentDecision. Its
  // output genuinely drives what Gaia does next (via the Decision Engine
  // below). Awaited: the semantic tier, when configured, is a real model
  // call. Never allowed to throw into the turn path; a failure degrades to
  // `intentDecision: null`, which downstream treats conservatively.
  let intentDecision = null;
  timing.start('intent');
  try {
    intentDecision = await intentIQ(messages, { contextId: conversationId, logger: decisionLogger });
  } catch (_) {
    // Observability must never take down a real conversational turn.
  }
  timing.end('intent');

  // Gaia context layer: recall happens BEFORE ReasonIQ so its output can be
  // assembled into evidence — Hindsight stays the only retriever (memory.js's
  // policy-gated, never-throws seam); ReasonIQ never calls it.
  //
  // Pattern Awareness 0.1 rides the same recall moment: a GATED (cheap,
  // IntentIQ-signal-driven) scoped Hindsight pattern recall through the
  // existing hypothesisRuntime's adapter seam — never a second search
  // engine, never an unconditional call ("Hoi Gaia" opens no gate).
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
    // Knowledge Pages (knowledgePages.js): current CONSOLIDATED understanding,
    // distinct from the raw-memory recall above — gated separately
    // (shouldSearchKnowledgeBase), never throws, never blocks the turn.
    hindsight
      ? searchRelevantKnowledgePages(hindsight, userText, { intentDecision })
      : Promise.resolve([]),
  ]);
  timing.end('memory_recall');

  // Memoryworthiness 0.1 (memoryWorthiness.js): a cheap DETERMINISTIC
  // judgment — no LLM, never user-facing — of whether this turn deserves a
  // Hindsight memory at all. Runs after recall (the recalled reflections
  // power duplicate/correction detection) and before ReasonIQ: on `discard`
  // this turn produces no Hindsight memory and closes the pattern-formation
  // trigger below; conversation history keeps the turn either way — only
  // MEMORY is being judged here.
  let memoryDecision = null;
  timing.start('memory_worthiness');
  try {
    const mwStartMs = Date.now();
    memoryDecision = evaluateMemoryWorthiness({
      userInput: userText,
      intent: intentDecision,
      conversationContext: messages,
      existingMemorySignals: { recalledReflections: reflections },
    });
    logMemoryWorthiness(memoryDecision, Date.now() - mwStartMs, decisionLogger);
  } catch (_) {
    // A classification failure degrades to null → pre-0.1 behavior (the
    // legacy shouldReflect gate still guards the reflection).
  }
  timing.end('memory_worthiness');

  // Categorize attachments: text files become evidence/context, images are
  // model-native input handled at assembly time.
  const textAttachments = (attachments || []).filter((a) => !a.imageBytes);
  const multimodalAttachments = (attachments || []).filter((a) => a.imageBytes && a.imageMimeType);

  // Evidence Assembly (reasoning/evidenceAssembler.js): organize what this
  // turn already has in hand into normalized evidence with stable ids. Pure
  // and local; no retrieval happens here.
  let evidence = [];
  timing.start('evidence_assembly');
  try {
    evidence = assembleEvidence({ reflections, mentalModels, attachments: textAttachments });
  } catch (_) {
    // Assembly must never take down a turn; an empty list just means
    // ReasonIQ runs shallow, exactly as it always has without evidence.
  }
  timing.end('evidence_assembly');

  // Hypothesis Persistence 0.1 (optional runtime, wired by server.js): seed
  // ReasonIQ with Gaia's tracked hypotheses — manager state first, then a
  // best-effort native recall scoped to gaia:hypothesis for anything not
  // loaded yet. Every failure here is non-fatal; without a runtime this is
  // exactly the pre-0.1 behavior.
  let existingHypotheses = [];
  if (hypothesisRuntime) {
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
    } catch (_) { /* seeding must never break the turn */ }
    if (typeof hypothesisRuntime.recallHypotheses === 'function') {
      try {
        const recalled = await hypothesisRuntime.recallHypotheses(userText);
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
  }

  // Logos: ReasonIQ consumes the IntentDecision plus the assembled evidence.
  // Awaited: the Decision Engine needs its output (reasoningDepth,
  // sufficiency, gaps) to route the turn. A reasoning failure degrades to
  // `reasoningResult: null`, same posture as intentDecision above.
  let reasoningResult = null;
  timing.start('reasoniq');
  try {
    reasoningResult = await reasonIQ(
      {
        text: userText,
        intentDecision,
        conversationContext: messages,
        evidence,
        ...(hypothesisRuntime ? { existingHypotheses } : {}),
        contextId: conversationId,
      },
      { logger: decisionLogger }
    );
  } catch (_) {
    // A reasoning failure degrades to `reasoningResult: null`, never
    // allowed to take down the turn.
  }
  timing.end('reasoniq');

  // The structured result flows into the manager (lifecycle/policy/promotion
  // via its injected sink → Hindsight adapter). Best-effort: persistence or
  // policy failures are logged and never affect the already-produced reply.
  //
  // Memoryworthiness §15 boundary: a DISCARDED turn closes the PATTERN
  // FORMATION trigger below — memory-unworthy conversation must not push
  // pattern analysis. Hypothesis APPLICATION deliberately still runs: its
  // lifecycle belongs to HypothesisManager policy (which already ignores
  // empty/shallow results via its own gates), and Memoryworthiness may not
  // judge hypothesis matters — a memory-unworthy REQUEST can still yield
  // legitimate analysis products, which are Gaia-knowledge, not
  // conversational memory.
  let durableSignaturesBefore = null;
  const patternGateOpen = !memoryDecision || shouldRetainToHindsight(memoryDecision);
  if (hypothesisRuntime && reasoningResult) {
    try {
      // Pattern-formation gate input (0.4): which durable hypotheses existed
      // BEFORE applying this turn's updates — a plain conversational turn
      // with no durable change must never trigger pattern analysis.
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
    // Gated pattern formation (ReasonIQ 0.4 + Memoryworthiness §15): needs
    // ≥1 DURABLE hypothesis created/changed by THIS turn AND a turn that
    // was not discarded as memory-unworthy. PatternManager owns the rest
    // of the gate (≥2 durable members etc.) and stays conservative.
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
  }

  // Gaia decides (decision/decisionEngine.js); the Orchestrator executes
  // exactly that decision (orchestration/orchestrator.js) — the Orchestrator
  // itself makes no judgment call about which capability a turn "seems to
  // need". Hermes is registered as one capability among any `tools` the
  // caller supplied, never a hidden default.
  const availableCapabilities = [
    { id: 'hermes' },
    ...Object.keys(tools || {}).map((id) => ({ id })),
  ];
  if (nativeGenerator) availableCapabilities.push({ id: 'native' });
  if (webSearch) availableCapabilities.push({ id: 'web' });

  let decision;
  timing.start('decision');
  try {
    decision = decisionEngine({
      userInput: userText,
      intent: intentDecision,
      context: { reflections, mentalModels, patterns: recalledPatterns },
      reasoning: reasoningResult,
      availableCapabilities,
    });
  } catch (_) {
    // The Decision Engine must never take down a turn either — degrade to
    // the same safe default a missing/failed IntentIQ decision gets.
    decision = {
      action: 'capability',
      capability: 'hermes',
      task: 'respond',
      input: { userInput: userText },
      reason: 'decision engine failed; defaulting to the hermes capability',
    };
  }
  timing.end('decision');
  logDecisionPlan(decision, decisionLogger);

  // Pattern Awareness observability: what was recalled and what the
  // Decision Engine chose to do with it — ids and scores only, never user
  // content or pattern statements. Emitted only when the gated retrieval
  // actually RAN this turn.
  if (wantPatterns) {
    logPatternAwareness(recalledPatterns, decision.patternUsage || null, decisionLogger);
  }

  // Prompt assembly happens AFTER decide(): whether any pattern guidance
  // reaches the capability at all is decided by decision.patternUsage —
  // nothing pattern-shaped enters the prompt on ignore/absent usage
  // (patterns are never automatically user-facing). Both transports build
  // the exact same system messages from the exact same inputs.
  const systemPrompt = buildSystemPrompt(documents, messages);
  const memoryBlock = renderMemoryContext(reflections);
  const mentalModelBlock = renderMentalModelContext(mentalModels);
  const knowledgePageBlock = renderKnowledgePageContext(knowledgePages);

  const attachmentBlock = renderTextAttachmentContext(textAttachments);
  const patternBlock = renderPatternContextBlock(
    decision.patternUsage || null,
    new Map(recalledPatterns.filter((c) => c && c.id != null).map((c) => [String(c.id), c]))
  );

  const systemMessages = [{ role: 'system', content: systemPrompt }];
  // Capability awareness — Gaia's factual self-knowledge about what she can
  // do comes from the LIVE registry, not from (lagging) foundation prose, so
  // she never denies an ability she actually has.
  const capabilityBlock = renderCapabilityAwareness(availableCapabilities);
  if (capabilityBlock) systemMessages.push({ role: 'system', content: capabilityBlock });
  if (mentalModelBlock) systemMessages.push({ role: 'system', content: mentalModelBlock });
  if (knowledgePageBlock) systemMessages.push({ role: 'system', content: knowledgePageBlock });
  if (memoryBlock) systemMessages.push({ role: 'system', content: memoryBlock });
  if (attachmentBlock) systemMessages.push({ role: 'system', content: attachmentBlock });
  if (patternBlock) systemMessages.push({ role: 'system', content: patternBlock });

  // Conversational opportunity — advisory guidance from ReasonIQ to Gaia's
  // response layer. Present only when ReasonIQ saw a natural human reason to
  // show interest; never an instruction to ask a question. Gaia's generator
  // decides whether and how to express it (acknowledgement, reflection,
  // curiosity, empathy, celebration). No-op when absent/present=false, so
  // existing consumers (history, decision store, non-generative paths) never see a difference.
  const opportunityGuidance = renderOpportunityGuidance(
    reasoningResult && reasoningResult.conversationalOpportunity ? reasoningResult.conversationalOpportunity : null
  );
  if (opportunityGuidance) systemMessages.push({ role: 'system', content: opportunityGuidance });

  // Immediate conversational state — lightweight, no Hindsight, for casual
  // conversation as a normal state (not a fallback). Gives the generator
  // the 1-2 turn context it needs to act as a participant: what Gaia just
  // said, what the user just said, whether this is an answer/sharing/casual
  // continuation, and that no task exists. Reuses IntentIQ output, no new
  // classification.
  const conversationalState = renderConversationalState({
    intentDecision,
    messages,
    userText,
  });
  if (conversationalState) systemMessages.push({ role: 'system', content: conversationalState });

  // Use assembleMessages to handle multimodal content
  const assembled = assembleMessages(null, [...systemMessages, ...messages.map(({ role, content }) => ({ role, content }))], multimodalAttachments);

  // Diagnostic logging (temporary) — identical shape on both transports.
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

  // Capability wiring — the ONE place transport shows up inside the core:
  // with an onDelta, hermes streams through it; without one, hermes.chat
  // returns a final string. Either way the Orchestrator sees the same
  // `{ invoke }` shape and the Decision is executed identically.
  //
  // Capability Registry 1.0 — skill forwarding: when a plan step selected a
  // Hermes skill, the adapter says so EXPLICITLY ("Use the Hermes skill …").
  // Hermes loads and executes the skill itself; Gaia never imports skill
  // contents. Without a selected skill the payload is untouched.
  const hermesSkillInstruction = (skill) => ({
    role: 'system',
    content: `Use the Hermes skill "${skill}" for this task. Load and execute that skill yourself.`,
  });
  const withHermesSkill = (msgs, skill) => {
    if (!skill) return msgs;
    const list = Array.isArray(msgs) ? [...msgs] : [];
    let insertAt = 0;
    while (insertAt < list.length && list[insertAt] && list[insertAt].role === 'system') insertAt += 1;
    list.splice(insertAt, 0, hermesSkillInstruction(skill));
    return list;
  };
  const capabilities = {
    hermes: onDelta
      ? { invoke: (msgs, { onDelta: emitDelta, skill } = {}) => hermes.stream(withHermesSkill(msgs, skill), { onDelta: emitDelta }) }
      : { invoke: (msgs, { skill } = {}) => hermes.chat(withHermesSkill(msgs, skill)) },
    ...(webSearch ? { web: webCapability(webSearch) } : {}),
    ...(tools || {}),
  };

  let executionResult;
  timing.start('capability');
  try {
    // Capability-level timing: wrap each capability's invoke to measure
    // individual capability duration without changing behavior.
    const timedCapabilities = {};
    for (const [capId, cap] of Object.entries(capabilities)) {
      if (cap && typeof cap.invoke === 'function') {
        timedCapabilities[capId] = {
          invoke: async (msgs, opts = {}) => {
            timing.start(`capability.${capId}`);
            try {
              const result = await cap.invoke(msgs, opts);
              timing.end(`capability.${capId}`, { capability: capId });
              return result;
            } catch (err) {
              timing.fail(`capability.${capId}`, err.constructor.name || 'Error', { capability: capId });
              throw err;
            }
          },
        };
      } else {
        timedCapabilities[capId] = cap;
      }
    }

    executionResult = await orchestrate(decision, { capabilities: timedCapabilities, nativeGenerator, messages: assembled, onDelta, conversationId });
  } catch (_) {
    executionResult = null;
  }
  timing.end('capability');

  // Response Engine seam: both transports share resolveReplyText's judgment
  // of what the ExecutionResult means as text. Null ⇒ the caller's transport
  // reports the calm failure (502 body / emitter.fail()) and NO reflection
  // or history side effects run — identical memory semantics on failure.
  const replyText = resolveReplyText(executionResult);
  if (typeof replyText !== 'string' || replyText.length === 0) {
    return { decision, executionResult, replyText: null };
  }

  // Post-turn Hindsight reflection — gated by Memoryworthiness 0.1: only
  // turns judged memory-worthy are retained, tagged with the gaia_memory_*
  // ingest-decision metadata (retain_low_priority keeps priority 'low').
  // Conversation history saves EVERY turn regardless (below / in the route)
  // — history is everything; Hindsight is what Gaia chooses to remember.
  // Fire-and-forget on both transports; a null decision (module failure)
  // degrades to the legacy shouldReflect-only gate.
  if (hindsight && (!memoryDecision || shouldRetainToHindsight(memoryDecision))) {
    const capabilityExecutor = decision && decision.capability ? decision.capability : null;
    reflectOnTurn(hindsight, {
      conversationId,
      userText,
      assistantText: replyText,
      metadata: metadataForMemoryDecision(memoryDecision),
      userDisplayName,
      capabilityExecutor,
    });
  }

  // Pipeline latency breakdown — log turn.done with aggregated timings.
  // Capability durations are extracted from individual capability.X events
  // and summarized. No double-counting: each stage measures only its own
  // wall-clock time, not nested stages.
  timing.end('turn');
  const capabilityEvents = timing.getEvents().filter((e) => e.stage && e.stage.startsWith('capability.') && e.stage !== 'capability');
  const capabilitiesSummary = capabilityEvents.map((e) => ({
    name: e.capability || e.stage.replace('capability.', ''),
    durationMs: e.durationMs,
  }));
  timing.done({
    intentMs: timing.getDuration('intent'),
    retrievalMs: timing.getDuration('memory_recall'),
    reasoningMs: timing.getDuration('reasoniq'),
    decisionMs: timing.getDuration('decision'),
    capabilityMs: timing.getDuration('capability'),
    capabilities: capabilitiesSummary.length > 0 ? capabilitiesSummary : undefined,
  });

  return { decision, executionResult, replyText, timing };
}

/**
 * Performs one conversational turn — NON-STREAMING transport.
 *
 * Same cognitive pipeline as performStreamingTurn (runTurnCore above);
 * delivery is Desktop's exact contract: plain messages in, one plain JSON
 * `{ reply }` out, non-streaming, always the full context-aware foundation
 * prompt. Hermes is invoked via chat() (final string, no deltas).
 *
 * @param {{
 *   messages: Array<{role: string, content: string}>,
 *   documents: Record<string, string>,
 *   hermes: { chat: (messages: Array) => Promise<string> },
 *   hindsight?: object,
 *   attachments?: Array<{ filename: string, content: string|null, imageBytes?: Buffer, imageMimeType?: string }>,
 *   traceId?: string,
 *   conversationId?: string,
 *   nativeGenerator?: { generate: Function, stream?: Function },
 *   webSearch?: { search: Function },
 *   intentIQ?: Function,
 *   reasonIQ?: Function,
 *   hypothesisRuntime?: object|null,
 *   decisionStore?: { append: Function },
 *   tools?: Record<string, { invoke: Function }>,
 *   decisionEngine?: Function,
 *   orchestrate?: Function,
 * }} input
 * @returns {Promise<{status: number, body: object}>} an HTTP-shaped result
 */
async function performTurn({
  messages,
  documents,
  hermes,
  hindsight,
  attachments,
  traceId,
  conversationId,
  nativeGenerator,
  webSearch,
  intentIQ,
  reasonIQ,
  hypothesisRuntime,
  decisionStore,
  tools,
  decisionEngine = decideAction,
  orchestrate = executeDecision,
  userDisplayName,
}) {
  const problem = validateMessages(messages);
  if (problem) {
    return { status: 400, body: { error: problem } };
  }

  const { replyText, timing } = await runTurnCore({
    messages,
    documents,
    hermes,
    hindsight,
    attachments,
    traceId,
    conversationId,
    nativeGenerator,
    webSearch,
    ...(intentIQ ? { intentIQ } : {}),
    ...(reasonIQ ? { reasonIQ } : {}),
    hypothesisRuntime,
    decisionStore,
    tools,
    decisionEngine,
    orchestrate,
    userDisplayName,
  });

  // Non-streaming generation timing: log generation.start/done
  // (streaming timing is handled by first_token tracking above)
  if (timing) {
    const genEvents = timing.getEvents().filter((e) => e.stage && e.stage.startsWith('capability.native') || e.stage && e.stage.startsWith('capability.hermes'));
    if (genEvents.length > 0) {
      try {
        console.log(JSON.stringify({
          kind: 'gaia.timing',
          traceId,
          stage: 'generation.done',
          durationMs: genEvents.reduce((sum, e) => sum + e.durationMs, 0),
          mode: 'non-streaming',
        }));
      } catch (_) { /* never break a turn */ }
    }
  }

  return formatReply(replyText);
}

/**
 * Performs one conversational turn, STREAMED — the Phase B parity path.
 * Same cognitive pipeline as performTurn (runTurnCore above); delivery is
 * SSE: headers sent lazily on the first delta, capability content streamed
 * as it arrives, clarify/refuse rendered by the Response Engine's emitter,
 * and a clean JSON error instead of a half-open stream when nothing was
 * said.
 *
 * @param {{
 *   messages: Array<{role: string, content: string}>,
 *   documents: Record<string, string>,
 *   hermes: { stream: Function },
 *   hindsight: object,
 *   res: import('express').Response,
 *   conversationId?: string,
 *   nativeGenerator?: { generate: Function, stream?: Function },
 *   webSearch?: { search: Function },
 *   attachments?: Array,
 *   traceId?: string,
 *   intentIQ?: Function,
 *   reasonIQ?: Function,
 *   hypothesisRuntime?: object|null,
 *   historyStore?: { saveConversation: Function },
 *   decisionStore?: { append: Function },
 *   tools?: Record<string, { invoke: Function }>,
 *   decisionEngine?: Function,
 *   orchestrate?: Function,
 * }} input
 */
async function performStreamingTurn({
  messages,
  documents,
  hermes,
  hindsight,
  res,
  conversationId,
  nativeGenerator,
  webSearch,
  attachments,
  traceId,
  intentIQ,
  reasonIQ,
  hypothesisRuntime,
  historyStore,
  decisionStore,
  tools,
  decisionEngine = decideAction,
  orchestrate = executeDecision,
  userDisplayName,
}) {
  const problem = validateMessages(messages);
  if (problem) {
    res.status(400).json({ error: problem });
    return;
  }

  // A capability (Hermes, a tool) streams internal reasoning/content
  // deltas; it never touches `res`. Every delta is handed to the Response
  // Engine's stream emitter, which is the only thing that owns the wire
  // frame shape, the lazy header-send, and the completion/failure
  // lifecycle (responseEngine.js).
  const emitter = createStreamEmitter(res);

  // First-token tracking: wraps onDelta to capture time-to-first-token
  // for streaming generation.
  let timeToFirstTokenMs = null;
  const onDelta = trackFirstToken(
    (chunk, isReasoning) => { emitter.delta(chunk, { reasoning: isReasoning }); },
    { onFirstToken: (ms) => { timeToFirstTokenMs = ms; } }
  );

  let coreResult;
  try {
    coreResult = await runTurnCore({
      messages,
      documents,
      hermes,
      hindsight,
      attachments,
      traceId,
      conversationId,
      nativeGenerator,
      webSearch,
      ...(intentIQ ? { intentIQ } : {}),
      ...(reasonIQ ? { reasonIQ } : {}),
      hypothesisRuntime,
      historyStore,
      decisionStore,
      tools,
      decisionEngine,
      orchestrate,
      onDelta,
      userDisplayName,
    });
  } catch (_) {
    // The core must never take down a turn — degrade to the same safe
    // default a missing/failed IntentIQ decision gets.
    emitter.fail();
    return;
  }

  const { decision, executionResult, replyText, timing } = coreResult;

  // Log first_token for streaming generation
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

  // Nothing usable was said (execution failed / empty output): report the
  // calm failure through the emitter — before any content shipped this is
  // a normal JSON error, after content it simply ends the stream.
  if (typeof replyText !== 'string' || replyText.length === 0) {
    emitter.fail();
    return;
  }

  // capability/tool/native text was already emitted as deltas during
  // orchestrate(); only clarify/refuse's Gaia-rendered words still need
  // to reach the client here.
  const action = executionResult && executionResult.action;
  if (action === 'clarify' || action === 'refuse') {
    emitter.delta(replyText);
  }
  emitter.finish();

  // Chat history — the raw transcript, never Hindsight's job (see the
  // module comment). Never allowed to affect the already-sent response; a
  // missing/invalid conversationId or a storage failure is silently
  // skipped. (The non-streaming route performs the identical save in its
  // own handler — same semantics, different delivery timing.)
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
