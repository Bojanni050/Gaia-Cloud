'use strict';

/**
 * Gaia's Response Engine — the single seam between a capability result (or
 * a direct Gaia decision) and what actually reaches the client.
 *
 * architecture.md's cognitive loop puts GAIA INTEGRATION and RESPONSE
 * ENGINE between a capability's RESULT and the user. This module is that
 * seam, made explicit in code: capabilities (Hermes today; Melodiq,
 * SongCompanion, MCP results tomorrow) never write to the HTTP response
 * themselves. They hand this module plain text deltas or a final string;
 * this module owns the wire format, the completion/failure lifecycle, and
 * the one rule that must never be violated anywhere in this codebase — no
 * provider name, model name, transport detail, or stack trace ever
 * reaches a client. `toCalmError` is the only place that mapping happens,
 * so the caller never has to remember it.
 *
 * This module does not reason. It does not decide whether a capability
 * was needed, and it does not touch capability internals (Hermes's own
 * stream framing, retries, provider routing). It only expresses: given a
 * result, produce the response — a direct Gaia answer and a
 * capability-produced answer converge here into the same shape.
 *
 * THE FRAME FAMILY (this module's wire vocabulary): every frame this module
 * writes is one `data:` JSON line ending in a blank line, terminated by
 * `data: [DONE]`. Content frames keep the original OpenAI-compatible
 * `{ choices: [{ delta }] }` shape untouched. Extension frames were added
 * alongside it, all with the same shape:
 *
 *   { choices: [{ delta: {} }], type: 'step',     step: {...} }     plan progress
 *   { choices: [{ delta: {} }], type: 'research', research: {...} } background job
 *   { choices: [{ delta: {} }], type: 'error',    error: '...' }    calm failure
 *   { choices: [{ delta: {} }], type: 'memory',   memory: {...} }   something kept in memory
 *   { choices: [{ delta: {} }], type: 'desktop',  desktop: {...} }  an action on the client's computer
 *   { choices: [{ delta: {} }], type: 'title',    title: {...} }    the conversation's own name
 *
 * Both deliberately carry an EMPTY `choices[0].delta` next to their type:
 * a client written against the original contract reads that as "no content
 * here" and appends nothing (it keeps working unchanged), while a client
 * that knows the extension renders progress or the calm failure. So the
 * extension is additive by construction — old readers ignore it, new readers
 * gain it, and no reader can mistake it for Gaia's answer.
 *
 * Two rules bound every frame this module ever writes, extension or not:
 * (1) only THIS module introduces a frame type — a capability may never
 * invent one, which is what keeps "what reaches the client" in one place;
 * (2) a frame carries Gaia-level facts only. The step frame reports a plan
 * step's position, its type in a plan's own vocabulary
 * (retrieval/reasoning/generation/capability) and its status — never the
 * capability id behind it, never content, never the error behind a failure
 * (that is `toCalmError()`'s text and nothing else). The research frame says
 * that a background job was submitted and carries the job's own metadata for
 * the client's indicator — never the question's answer, which arrives later
 * through the conversation.
 * turn.js calls resolveReplyText to judge what a generation result means
 * as reply text, then expresses it through formatReply (non-streaming) or
 * deliverReply onto the stream emitter (streaming) — the two transports
 * share that one judgment so they can never quietly diverge on what counts
 * as "nothing to say". For `capability`/`tool`/`plan`, the text either
 * already reached the client as deltas during execution (streaming — it
 * was handed this module's own stream emitter as `onDelta`) or it is simply
 * the capability's returned string; in the streaming case the caller reports
 * which of the two happened (`contentEmitted`) and `deliverReply` decides:
 * emit it here when it never streamed, stay silent when it did. That is a
 * reported fact rather than an assumption because streaming is not
 * guaranteed — non-streaming providers return text without ever calling
 * onDelta. For `clarify`/`refuse` — turns deliberately resolved without
 * calling any capability — nothing has been said yet, so this is the one
 * place that renders Gaia's own calm words for them. That is what keeps the
 * invariant true even for capability-free turns: Response Engine, never a
 * capability, speaks for Gaia.
 *
 * PATCH 6: Response Engine override
 * - When the user's intent is meta-question, explanation, correction, or
 *   discussion of previous capability use, the Response Engine MUST override
 *   the capability candidate and answer directly from conversation context.
 * - The capability candidate is advisory, not an execution command.
 *
 * PATCH 8: Model-native vs external capabilities
 * - Vision/multimodal understanding is model-native, not external
 * - Don't convert model-native capabilities into external tool invocations
 */

const CALM_FALLBACK = 'gaia could not answer right now';
const CLARIFY_FALLBACK = "could you say a bit more about what you're looking for? I want to make sure I answer the right thing.";
const REFUSE_FALLBACK = "gaia isn't able to help with that.";

// PATCH 1-3: Image availability responses (model-native vision)
const IMAGE_UNAVAILABLE_RESPONSE = "Nee, ik krijg de afbeelding niet mee in mijn huidige input.";
const IMAGE_UNAVAILABLE_RESPONSE_EN = "No, I can't see the image in my current input.";
const IMAGE_UNKNOWN_RESPONSE = "Ik weet niet zeker of er een afbeelding is meegestuurd.";
const IMAGE_UNKNOWN_RESPONSE_EN = "I'm not sure if an image was included.";

/**
 * Maps any capability failure to Gaia's own calm, generic language. Never
 * forwards the underlying error message, stack, or capability name —
 * that's exactly how transport/provider details would leak to a client.
 */
function toCalmError() {
  return CALM_FALLBACK;
}

/**
 * Turns a capability's final text into the non-streaming HTTP-shaped
 * result. `text` is expected to be a plain string on success; anything
 * else (missing, empty, or the caller already caught a capability error)
 * becomes a calm 502 — the same outcome whether the capability threw or
 * simply returned nothing usable.
 * @param {string|null|undefined} text
 * @param {object} [extras] extra top-level fields for a successful reply — a
 *   Gaia-level fact about the turn that is not the reply itself (today: the
 *   research job that was submitted, so a client can show it is working in
 *   the background). Never applied to the error shape.
 * @returns {{status: number, body: object}}
 */
function formatReply(text, extras = {}) {
  if (typeof text !== 'string' || text.length === 0) {
    return { status: 502, body: { error: toCalmError() } };
  }
  return { status: 200, body: { reply: text, ...extras } };
}

/**
 * Creates a streaming emitter bound to one HTTP response. A capability
 * calls delta()/step()/finish()/fail() — never
 * res.write()/res.end() directly — so the SSE wire shape and the
 * completion/failure lifecycle live in exactly one place.
 *
 * Headers are sent lazily, on the first frame of any kind: if the turn
 * fails before producing a single byte, the caller still gets a clean JSON
 * error instead of a half-open stream. The first step frame therefore also
 * opens the stream — progress is only progress if it arrives while the
 * plan is still running — and from that moment on a failure is reported as
 * an `error` frame inside the stream (see fail()) rather than as JSON.
 * @param {import('express').Response} res
 */
function createStreamEmitter(res) {
  let headersSent = false;

  function ensureHeaders() {
    if (headersSent) return;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    headersSent = true;
  }

  /**
   * Emits one piece of Gaia's reply. `reasoning: true` marks a reasoning
   * delta separately from user-facing content so clients can render it in
   * their collapsible reasoning field rather than appending it to the reply.
   * @param {string} content
   * @param {{ reasoning?: boolean }} [options]
   */
  function delta(content, { reasoning = false } = {}) {
    if (!content) return;
    ensureHeaders();
    const frame = reasoning ? { reasoning_content: content } : { content };
    res.write(`data: ${JSON.stringify({ choices: [{ delta: frame }] })}\n\n`);
  }

  /**
   * Reports one plan step's progress as an extension frame (module header:
   * THE FRAME FAMILY). Progress only — `payload` is a Gaia-level fact
   * (`{ id, index, total, type, status }`, status: start|done|failed),
   * never content and never a capability id, so a step frame can never be
   * mistaken for something Gaia says. A missing/empty payload is a no-op
   * (it must not open the stream for nothing).
   * @param {{ id: string, index: number, total: number, type: string, status: 'start'|'done'|'failed' }} payload
   */
  function step(payload) {
    if (!payload || typeof payload !== 'object') return;
    ensureHeaders();
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {} }], type: 'step', step: payload })}\n\n`);
  }

  /**
   * Reports that a background research job was started, as an extension frame
   * in the same family as `step`: a fact about the turn, never content. A
   * client uses it to show that something is still running after the reply —
   * `GET /research/jobs` is the durable version of the same fact, so a client
   * that misses this frame loses nothing but immediacy.
   * @param {object} payload
   */
  function research(payload) {
    if (!payload || typeof payload !== 'object') return;
    ensureHeaders();
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {} }], type: 'research', research: payload })}\n\n`);
  }

  /**
   * Reports that Gaia kept something in the shared memory (the `bojan` bank) during this turn, as an
   * extension frame in the same family as `step` and `research`: a fact about the turn, never content.
   * A client uses it to show a small light next to the reply. `payload` is `{ bank, kind, text }`: what
   * was kept is the statement she wrote down, never the person's message or anything from the bank.
   * @param {{ bank: string, kind?: string, text?: string }} payload
   */
  function memory(payload) {
    if (!payload || typeof payload !== 'object') return;
    ensureHeaders();
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {} }], type: 'memory', memory: payload })}\n\n`);
  }

  /**
   * Announces a desktop action (or a change in its status) to the client, as an extension frame in the
   * same family as `memory` and `research`. The client shows a confirmation prompt for
   * `awaiting_confirmation`, runs the action locally once `approved`, and clears the prompt on any
   * terminal status. `payload` is the broker's action view: ids, skill, policy, status, summary, input.
   * @param {object} payload
   */
  function desktop(payload) {
    if (!payload || typeof payload !== 'object') return;
    ensureHeaders();
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {} }], type: 'desktop', desktop: payload })}\n\n`);
  }

  /**
   * Names the conversation, as an extension frame in the same family as
   * `memory` and `research`: the one-line title Gaia wrote for this thread
   * when it was first named (conversationTitle.js). A fact about the
   * conversation, never content, and only ever said once — the client puts it
   * on the thread it is already showing, and the durable copy is the store's
   * (`GET /conversations`), so a client that misses the frame has lost
   * immediacy, not the name. `payload` is `{ text }`.
   * @param {{ text: string }} payload
   */
  function title(payload) {
    if (!payload || typeof payload !== 'object') return;
    ensureHeaders();
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {} }], type: 'title', title: payload })}\n\n`);
  }

  /** Finalizes a successful stream. */
  function finish() {
    ensureHeaders();
    res.write('data: [DONE]\n\n');
    res.end();
  }

  /**
   * Finalizes a failed stream, calmly. Before any frame shipped, this is a
   * normal JSON error response. Once the stream is open (content — or just
   * progress frames — already went out), the same calm text goes out as an
   * `error` frame and the stream ends WITHOUT `[DONE]`, so the client can
   * tell a failure from a finished reply instead of reading a silently
   * truncated stream as complete. The wording is always toCalmError()'s —
   * the underlying error never crosses this seam, on either path.
   */
  function fail() {
    if (!headersSent) {
      res.status(502).json({ error: toCalmError() });
      return;
    }
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {} }], type: 'error', error: toCalmError() })}\n\n`);
    res.end();
  }

  return { delta, step, research, memory, desktop, title, finish, fail };
}

/**
 * The one place that judges what an execution result means as reply text.
 * Called by turn.js's turn core, so both transports share this judgment
 * and can never quietly diverge on what counts as "nothing to say".
 *
 * - capability/tool: whatever the capability returned, as long as it's a
 *   non-empty string; null if it returned nothing usable, or the
 *   capability/tool was unavailable.
 * - native: whatever the native generator returned, as long as it's a
 *   non-empty string; null if it returned nothing usable, or the native
 *   generator was not available.
 * - clarify: Gaia's own calm clarifying words.
 * - refuse: Gaia's own calm refusal words.
 * - image_unavailable: PATCH 1-3 - image is not available in model input
 * - image_unknown: PATCH 1-3 - image availability is unknown
 *
 * PATCH 6: Response Engine override
 * When the user's intent is meta-question, explanation, correction, or
 * discussion of previous capability use, the Response Engine MUST override
 * the capability candidate and answer directly from conversation context.
 *
 * @param {object|null|undefined} executionResult a resolved execution result ({ action, output })
 * @param {{ intent?: object, decision?: object }} [context] - additional context for override logic
 * @returns {string|null}
 */
function resolveReplyText(executionResult, context = {}) {
  if (!executionResult) return null;

  // PATCH 6: Response Engine override for meta-intents
  // When the user is asking about Gaia's own behavior, previous response,
  // or capability choice, answer directly from conversation context.
  if (context.intent && context.intent.intent) {
    const metaIntents = new Set(['meta.question', 'meta.correction', 'meta.capability_question']);
    if (metaIntents.has(context.intent.intent)) {
      // For meta-intents, the capability candidate should be overridden
      // The Response Engine answers directly, not through a capability
      return null; // Let the native handler or conversation context answer
    }
  }

  switch (executionResult.action) {
    case 'capability':
    case 'tool':
    case 'native':
    case 'plan': // the last successful step's output (normally Gaia's own generation, or a terminal capability result)
      return typeof executionResult.output === 'string' && executionResult.output.length > 0
        ? executionResult.output
        : null;

    case 'clarify':
      return CLARIFY_FALLBACK;

    case 'refuse':
      return REFUSE_FALLBACK;

    // PATCH 1-3: Image availability responses
    case 'image_unavailable':
      return IMAGE_UNAVAILABLE_RESPONSE;

    case 'image_unknown':
      return IMAGE_UNKNOWN_RESPONSE;

    default:
      return null;
  }
}

/**
 * Streaming twin of formatReply: delivers an ALREADY-resolved reply text
 * onto the stream — exactly once.
 *
 * The rule this one function owns: a reply reaches the client either (a) as
 * deltas DURING execution, when the capability/generator actually streamed
 * (`contentEmitted: true`), or (b) here, as one final delta. Never twice,
 * never zero times. That matters because (a) is an assumption, not a
 * guarantee — clarification/refusal wording is rendered here, and plenty of
 * executions return text without ever calling onDelta (retrieval tools, a
 * plan whose last step hands back a terminal result, a non-streaming
 * generator fallback). Before this rule existed, those turns ended with an
 * empty stream while conversation history held the full reply.
 *
 * @param {ReturnType<typeof createStreamEmitter>} emitter
 * @param {string|null|undefined} replyText resolved reply text (resolveReplyText)
 * @param {{ contentEmitted?: boolean }} [options] true when content deltas
 *   already reached the client during execution
 * @returns {boolean} true when this call wrote the text to the stream
 */
function deliverReply(emitter, replyText, { contentEmitted = false } = {}) {
  if (typeof replyText !== 'string' || replyText.length === 0) return false;
  if (contentEmitted) return false;
  emitter.delta(replyText);
  return true;
}

module.exports = {
  formatReply,
  createStreamEmitter,
  deliverReply,
  resolveReplyText,
  toCalmError,
  CALM_FALLBACK,
  CLARIFY_FALLBACK,
  REFUSE_FALLBACK,
  IMAGE_UNAVAILABLE_RESPONSE,
  IMAGE_UNAVAILABLE_RESPONSE_EN,
  IMAGE_UNKNOWN_RESPONSE,
  IMAGE_UNKNOWN_RESPONSE_EN,
};
