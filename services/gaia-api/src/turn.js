'use strict';

/**
 * Turn handling — the server side of the desktop's `conversation/turn`
 * contract (desktop/src/state/contract.js).
 *
 * The client sends plain messages; this service owns everything cognitive
 * the client must not: identity (SOUL as the system prompt) and reasoning
 * orchestration (Hermes). The reply returned is plain text — no model
 * names, no provider details, no chain-of-thought ever cross this seam.
 *
 * This file is Gaia's decision/orchestration layer for a turn: it decides
 * what context Hermes sees (SOUL, recalled memory, mental models) and
 * calls the one capability a turn uses today. It does not itself write to
 * the HTTP response or shape a wire frame — Hermes's result (or failure)
 * is always handed to responseEngine.js, which is the only place that
 * decides what actually reaches the client. See responseEngine.js's own
 * header comment for why that seam exists and what it deliberately does
 * not do.
 *
 * performTurn (below) is Desktop's exact, unchanged *contract* — same
 * input/output shape, non-streaming, always the full SOUL, no memory, no
 * IntentIQ/ReasonIQ. Internally it now goes through the same Decision
 * Engine / Orchestrator seam as performStreamingTurn (decision/
 * decisionEngine.js, orchestration/orchestrator.js) instead of calling
 * Hermes directly — see performTurn's own comment for why that is still
 * byte-identical behavior. performStreamingTurn is additive, built for
 * docs/web-migration-plan.md's Phase B (a faithful parity port of Web's
 * client-side turn lifecycle: context-aware document selection,
 * policy-gated recall/reflection, streaming) — neither path modifies
 * assembleMessages or anything Desktop depends on.
 *
 * performTurn's own contract is extended additively, the same way: an
 * optional `attachments` param (already-resolved library files — see
 * library.js's resolveAttachmentsForPrompt, called by server.js before
 * performTurn is reached) folds into the system prompt only when present.
 * A call that omits it produces byte-identical output to before — nothing
 * about assembleMessages itself changes, and no shape Desktop already
 * depends on is touched.
 *
 * Chat history (conversationStore.js) is saved as a fire-and-forget side
 * effect after a turn succeeds — deliberately NOT inside performTurn
 * itself (that stays the minimal, unchanged reply-producing function;
 * server.js's route handler does the save for the non-streaming path,
 * right after calling performTurn). performStreamingTurn already has this
 * shape for reflectOnTurn, so its own history save lives inline here,
 * alongside it, gated the same optional-param way as hindsight/intentIQ/
 * reasonIQ — omitting `historyStore` skips saving entirely, no behavior
 * change for a caller that doesn't pass one.
 */

const { buildSystemPrompt } = require('./foundation');
const { recallRelevantContext, renderMemoryContext, reflectOnTurn, fetchMentalModelContext, renderMentalModelContext } = require('./memory');
const { interpret: classifyIntent } = require('./logos/intentIQ');
const { evaluate: evaluateReasoning } = require('./logos/reasonIQ');
const { formatReply, createStreamEmitter, generateReply, generateStreamingReply } = require('./responseEngine');
const { decide: decideAction } = require('./decision/decisionEngine');
const { execute: executeDecision } = require('./orchestration/orchestrator');

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
 * Assembles the message list sent to Hermes: the SOUL system prompt first,
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
 * PATCH: Renamed from renderAttachmentContext for clarity.
 * Only handles text attachments; images go through renderMultimodalContent().
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
    "The user has attached the following file(s) from their library as context for this turn.",
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

/**
 * Performs one conversational turn.
 *
 * Desktop's contract carries no IntentIQ/ReasonIQ (no memory, no Logos,
 * exactly as before this seam existed) — this path always hands the
 * Decision Engine `intent: null`, which its safe default routes to native
 * generation when a native generator is available, or to the hermes
 * capability otherwise. The Orchestrator (orchestration/orchestrator.js)
 * then executes exactly that decision.
 *
 * PATCH: Native Vision Support
 * When attachments contain multimodal images (imageBytes present), they
 * are passed to assembleMessages which creates multimodal content blocks.
 *
 * @param {{
 *   messages: Array<{role: string, content: string}>,
 *   systemPrompt: string,
 *   hermes: { chat: (messages: Array) => Promise<string> },
 *   attachments?: Array<{ filename: string, content: string|null, imageBytes?: Buffer, imageMimeType?: string }>,
 *   nativeGenerator?: { generate: Function, stream?: Function },
 *   webSearch?: { search: (query: string) => Promise<string> },
 *   decisionEngine?: (input: object) => import('./decision/decisionSchema').Decision,
 *   orchestrate?: (decision: object, context: object) => Promise<object>,
 * }} input
 * @returns {Promise<{status: number, body: object}>} an HTTP-shaped result
 */
async function performTurn({ messages, systemPrompt, hermes, attachments, nativeGenerator, webSearch, traceId, decisionEngine = decideAction, orchestrate = executeDecision }) {
  const problem = validateMessages(messages);
  if (problem) {
    return { status: 400, body: { error: problem } };
  }

  // STAGE 3: Log performTurn input
  console.log(JSON.stringify({
    kind: 'vision.trace',
    traceId,
    stage: 'perform_turn_input',
    attachmentsProvided: !!attachments,
    attachmentCount: attachments ? attachments.length : 0,
    attachments: attachments ? attachments.map((a) => ({
      filename: a.filename,
      hasImageBytes: !!a.imageBytes,
      imageBytesLength: a.imageBytes ? a.imageBytes.length : 0,
      imageMimeType: a.imageMimeType || null,
    })) : [],
  }));

  // PATCH: Categorize attachments into text and multimodal
  const textAttachments = (attachments || []).filter((a) => !a.imageBytes);
  const multimodalAttachments = (attachments || []).filter((a) => a.imageBytes && a.imageMimeType);

  const attachmentBlock = renderTextAttachmentContext(textAttachments);
  const fullSystemPrompt = attachmentBlock ? `${systemPrompt}\n\n---\n\n${attachmentBlock}` : systemPrompt;
  const assembled = assembleMessages(fullSystemPrompt, messages, multimodalAttachments);

  // STAGE 4: Log assembled messages
  const lastUserMsg = assembled.find((m) => m.role === 'user');
  console.log(JSON.stringify({
    kind: 'vision.trace',
    traceId,
    stage: 'assembly',
    totalMessages: assembled.length,
    messageRoles: assembled.map((m) => m.role),
    lastUserContentIsArray: lastUserMsg ? Array.isArray(lastUserMsg.content) : false,
    lastUserContentTypes: lastUserMsg && Array.isArray(lastUserMsg.content)
      ? lastUserMsg.content.map((c) => c.type)
      : ['text'],
    imageBlockPresent: lastUserMsg && Array.isArray(lastUserMsg.content)
      ? lastUserMsg.content.some((c) => c.type === 'image_url')
      : false,
    multimodalAttachmentCount: multimodalAttachments.length,
  }));

  const availableCapabilities = [{ id: 'hermes' }];
  if (nativeGenerator) availableCapabilities.push({ id: 'native' });
  if (webSearch) availableCapabilities.push({ id: 'web' });

  let decision;
  try {
    decision = decisionEngine({
      userInput: latestUserText(messages),
      intent: null,
      context: null,
      reasoning: null,
      availableCapabilities,
    });
  } catch (_) {
    // The Decision Engine must never take down a turn — degrade to the
    // same hermes capability it would otherwise have chosen anyway.
    decision = { action: 'capability', capability: 'hermes', task: 'respond', input: {}, reason: 'decision engine failed; defaulting to the hermes capability' };
  }
  logDecisionPlan(decision);

  // Hermes is a capability: it returns a result, it does not speak to the
  // client. Whatever the Orchestrator returns (or however it fails) is
  // handed to the Response Engine, which is the only thing that decides
  // what becomes the reply and how a failure is phrased — see
  // responseEngine.js.
  const capabilities = {
    hermes: { invoke: (msgs) => hermes.chat(msgs) },
    ...(webSearch ? { web: webCapability(webSearch) } : {}),
  };

  let executionResult;
  try {
    executionResult = await orchestrate(decision, { capabilities, nativeGenerator, messages: assembled });
  } catch (_) {
    executionResult = null;
  }

  const reply = generateReply({ decision, executionResult });
  return formatReply(reply);
}

function latestUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') return messages[i].content || '';
  }
  return '';
}

/**
 * Adapts a raw web-search client (src/tools/braveSearch.js's `{ search }`)
 * into the generic `{ invoke }` capability shape the Orchestrator expects
 * (orchestration/orchestrator.js) — the same adapter role this file
 * already plays for `hermes.chat`/`hermes.stream` below. The web tool is a
 * terminal, single-step capability (see braveSearch.js's own header on
 * why): it has no token-by-token stream of its own, so when the caller
 * wants deltas (`onDelta` given, a streaming turn), this emits the whole
 * formatted answer as one chunk rather than leaving the stream silent —
 * the same "one capability, one wire shape" contract every capability's
 * `invoke` already follows (see turn.test.js's own 'tool turn' test).
 * @param {{ search: (query: string) => Promise<string> }} webSearch
 * @returns {{ invoke: (messages: Array, options?: object) => Promise<string> }}
 */
function webCapability(webSearch) {
  return {
    invoke: async (messages, { onDelta, input } = {}) => {
      const query = (input && input.userInput) || '';
      const text = await webSearch.search(query);
      if (onDelta) onDelta(text, false);
      return text;
    },
  };
}

/**
 * Logs the Decision Engine's plan for this turn — action, the context
 * sources it drew on, its reasoning level, and which capability(ies) it
 * needs (decisionSchema.js's additive plan fields) — never the user's own
 * input text. When `logger` is given (performStreamingTurn's
 * decisionLogger), it both console.logs and persists to decisionStore,
 * exactly like IntentIQ/ReasonIQ's own decision lines; otherwise this
 * just console.logs, for live `docker logs` visibility on paths (like
 * performTurn) that have no decisionStore wired in. Never allowed to
 * affect the turn — a logging failure is swallowed, same posture as
 * every other observability call in this file.
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
 * Performs one conversational turn, streamed — the Phase B parity path.
 * Recall happens first (best-effort, policy-gated, never throws); the
 * system prompt is context-aware (foundation.js's buildSystemPrompt,
 * ported from Web's deriveIntent+FoundationSelector) rather than always
 * the full SOUL. SSE headers are sent lazily, on the first delta only —
 * if Hermes fails before producing any content, the caller still gets a
 * normal JSON error response instead of a half-open stream.
 *
 * Gaia decides what to do with the turn (decision/decisionEngine.js) before
 * any capability is touched: IntentIQ and ReasonIQ are consumed, not just
 * observed, and their combined output is what the Decision Engine routes
 * on — never a `useHermes`-shaped flag. The Orchestrator
 * (orchestration/orchestrator.js) then executes exactly that Decision:
 * `capability`/`tool` calls the named capability (Hermes is registered as
 * one capability among any others passed in via `tools`, never a hidden
 * default engine); `clarify`/`refuse` call no capability at all. Whatever
 * the Orchestrator returns is handed to responseEngine.js's
 * generateStreamingReply, which is the only place that renders Gaia's own
 * words for a capability-free turn (clarify/refuse) or reports back what a
 * capability already streamed — the same Response Engine seam either way.
 *
 * @param {{
 *   messages: Array<{role: string, content: string}>,
 *   documents: Record<string, string>,
 *   hermes: { stream: Function },
 *   hindsight: { recall: Function, reflect: Function, getMentalModel: Function },
 *   res: import('express').Response,
 *   conversationId?: string,
 *   nativeGenerator?: { generate: Function, stream?: Function },
 *   webSearch?: { search: (query: string) => Promise<string> },
 *   intentIQ?: (messages: Array, options: object) => object,
 *   reasonIQ?: (input: object, options: object) => Promise<object>,
 *   historyStore?: { saveConversation: (id: string, messages: Array) => void },
 *   decisionStore?: { append: (record: object) => boolean },
 *   tools?: Record<string, { invoke: (messages: Array, options?: object) => Promise<*> }>,
 *   decisionEngine?: (input: object) => import('./decision/decisionSchema').Decision,
 *   orchestrate?: (decision: object, context: object) => Promise<object>,
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
  intentIQ = classifyIntent,
  reasonIQ = evaluateReasoning,
  historyStore,
  decisionStore,
  tools,
  decisionEngine = decideAction,
  orchestrate = executeDecision,
}) {
  const problem = validateMessages(messages);
  if (problem) {
    res.status(400).json({ error: problem });
    return;
  }

  const userText = latestUserText(messages);

  // Both console.log (unchanged, for live `docker logs` tailing) and, when
  // a decisionStore is given, a durable JSONL line (decisionStore.js) —
  // console output alone doesn't survive past Docker's own log retention,
  // and "why did Gaia classify this the way it did" is exactly the kind of
  // question that gets asked well after the fact. Store-write failures are
  // swallowed the same way logIntentDecision/logReasoningResult already
  // swallow nothing being wrong with logging itself — append() never
  // throws, but wrapped anyway since this must never affect the turn.
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

  // Logos: IntentIQ (2.0 — heuristic + semantic, logos/intentIQ.js's
  // interpret()) observes the turn and produces an IntentDecision. Its
  // output now genuinely drives what Gaia does next (via the Decision
  // Engine below) — not just a dev-logged observation. Awaited: the
  // semantic tier, when it runs, is a real model call. Never allowed to
  // throw into the turn path; a failure here degrades to `intentDecision:
  // null`, which the Decision Engine treats as "route to Hermes" (its
  // safest default), not as a hard failure.
  let intentDecision = null;
  try {
    intentDecision = await intentIQ(messages, { contextId: conversationId, logger: decisionLogger });
  } catch (_) {
    // Observability must never take down a real conversational turn.
  }

  // Logos: ReasonIQ consumes that same IntentDecision — the handoff this
  // seam exists to prove (see logos/index.js's runLogos(), which tests
  // this composition directly). Awaited now, unlike before: the Decision
  // Engine needs its output (reasoningDepth, sufficiency, gaps) to route
  // the turn, so "fire-and-forget with nothing downstream reading it" no
  // longer applies. This stays cheap in practice: ReasonIQ's own
  // reasoningDepth gate (reasonIQ.js) only calls a real reasoning model
  // when evidence is supplied, and Gaia doesn't hand ReasonIQ any evidence
  // yet — today's calls resolve shallow, in-process, with no network call.
  let reasoningResult = null;
  try {
    reasoningResult = await reasonIQ(
      { text: userText, intentDecision, conversationContext: messages, evidence: [], contextId: conversationId },
      { logger: decisionLogger }
    );
  } catch (_) {
    // A reasoning failure degrades to `reasoningResult: null`, same posture
    // as intentDecision above — never allowed to take down the turn.
  }

  const systemPrompt = buildSystemPrompt(documents, messages);
  const [reflections, mentalModels] = await Promise.all([
    recallRelevantContext(hindsight, userText),
    fetchMentalModelContext(hindsight).catch(() => []),
  ]);
  const memoryBlock = renderMemoryContext(reflections);
  const mentalModelBlock = renderMentalModelContext(mentalModels);

  // PATCH: Categorize attachments for streaming path
  const textAttachments = (attachments || []).filter((a) => !a.imageBytes);
  const multimodalAttachments = (attachments || []).filter((a) => a.imageBytes && a.imageMimeType);

  const attachmentBlock = renderTextAttachmentContext(textAttachments);
  
  const systemMessages = [{ role: 'system', content: systemPrompt }];
  if (mentalModelBlock) systemMessages.push({ role: 'system', content: mentalModelBlock });
  if (memoryBlock) systemMessages.push({ role: 'system', content: memoryBlock });
  if (attachmentBlock) systemMessages.push({ role: 'system', content: attachmentBlock });
  
  // PATCH: Use assembleMessages to handle multimodal content
  const assembled = assembleMessages(null, [...systemMessages, ...messages.map(({ role, content }) => ({ role, content }))], multimodalAttachments);
  
  // Diagnostic logging (temporary)
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

  // A capability (Hermes, a tool) streams internal reasoning/content
  // deltas; it never touches `res`. Every delta is handed to the Response
  // Engine's stream emitter, which is the only thing that owns the wire
  // frame shape, the lazy header-send, and the completion/failure
  // lifecycle (responseEngine.js). This is what makes any capability's
  // stream converge on the exact same user-facing shape, with no
  // capability-specific branching here.
  const emitter = createStreamEmitter(res);
  const onDelta = (chunk, isReasoning) => {
    emitter.delta(chunk, { reasoning: isReasoning });
  };

  // Gaia decides (decision/decisionEngine.js), then the Orchestrator
  // executes exactly that decision (orchestration/orchestrator.js) — the
  // Orchestrator itself makes no judgment call about which capability a
  // turn "seems to need". Hermes is registered as one capability among
  // any `tools` the caller supplied, never a hidden default.
  const availableCapabilities = [
    { id: 'hermes' },
    ...Object.keys(tools || {}).map((id) => ({ id })),
  ];
  if (nativeGenerator) availableCapabilities.push({ id: 'native' });
  if (webSearch) availableCapabilities.push({ id: 'web' });
  let decision;
  try {
    decision = decisionEngine({
      userInput: userText,
      intent: intentDecision,
      context: { reflections, mentalModels },
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
  logDecisionPlan(decision, decisionLogger);

  const capabilities = {
    hermes: { invoke: (msgs, { onDelta: emitDelta } = {}) => hermes.stream(msgs, { onDelta: emitDelta }) },
    ...(webSearch ? { web: webCapability(webSearch) } : {}),
    ...(tools || {}),
  };

  let executionResult;
  try {
    executionResult = await orchestrate(decision, { capabilities, nativeGenerator, messages: assembled, onDelta });
  } catch (_) {
    emitter.fail();
    return;
  }

  const fullText = generateStreamingReply({ decision, executionResult, emitter });
  if (typeof fullText !== 'string' || fullText.length === 0) {
    emitter.fail();
    return;
  }

  emitter.finish();

  reflectOnTurn(hindsight, { conversationId, userText, assistantText: fullText });

  // Chat history — the raw transcript, never Hindsight's job (see this
  // file's module comment). Never allowed to affect the already-sent
  // response; a missing/invalid conversationId or a storage failure is
  // silently skipped, exactly like reflectOnTurn's own failure mode.
  if (historyStore && conversationId) {
    try {
      historyStore.saveConversation(conversationId, [...messages, { role: 'assistant', content: fullText }]);
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
