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
 * so turn.js's orchestration code never has to remember it.
 *
 * This module does not reason. It does not decide whether a capability
 * was needed, and it does not touch capability internals (Hermes's own
 * stream framing, retries, provider routing). It only expresses: given a
 * result, produce the response — a direct Gaia answer and a
 * capability-produced answer converge here into the same shape.
 *
 * turn.js calls resolveReplyText to judge what an ExecutionResult means
 * as reply text, then expresses it through formatReply (non-streaming) or
 * the stream emitter (streaming) — the two transports share that one
 * judgment so they can never quietly diverge on what counts as "nothing to
 * say". For `capability`/`tool`, the text either already reached the client
 * as deltas during orchestrator.execute() (streaming — it was handed this
 * module's own stream emitter as `onDelta`) or is simply the capability's
 * returned string (non-streaming). For `clarify`/`refuse` — turns the
 * Orchestrator deliberately executed *without* calling any capability —
 * turn.js emits Gaia's own calm words through this module's emitter. That
 * is what keeps the invariant true even for capability-free turns:
 * Response Engine, never a capability, speaks for Gaia.
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
 * @returns {{status: number, body: object}}
 */
function formatReply(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { status: 502, body: { error: toCalmError() } };
  }
  return { status: 200, body: { reply: text } };
}

/**
 * Creates a streaming emitter bound to one HTTP response. A capability
 * (or Gaia orchestrating one) calls delta()/finish()/fail() — never
 * res.write()/res.end() directly — so the SSE wire shape and the
 * completion/failure lifecycle live in exactly one place.
 *
 * Headers are sent lazily, on the first delta: if the capability fails
 * before producing any content, the caller still gets a clean JSON error
 * instead of a half-open stream.
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
   * Emits one piece of Gaia's reply. `reasoning: true` marks a
   * reasoning-trace delta rather than user-facing content — still routed
   * through this one wire shape, never a capability-specific one.
   * @param {string} content
   * @param {{ reasoning?: boolean }} [options]
   */
  function delta(content, { reasoning = false } = {}) {
    if (!content) return;
    ensureHeaders();
    const frame = reasoning ? { reasoning_content: content } : { content };
    res.write(`data: ${JSON.stringify({ choices: [{ delta: frame }] })}\n\n`);
  }

  /** Finalizes a successful stream. */
  function finish() {
    ensureHeaders();
    res.write('data: [DONE]\n\n');
    res.end();
  }

  /**
   * Finalizes a failed stream, calmly. Before any content shipped, this is
   * a normal JSON error response. After content is already on the wire,
   * there is no calm way to inject an "error" frame a client would need
   * capability-specific logic to render — so the stream simply ends.
   */
  function fail() {
    if (!headersSent) {
      res.status(502).json({ error: toCalmError() });
    } else {
      res.end();
    }
  }

  return { delta, finish, fail };
}

/**
 * The one place that judges what an ExecutionResult (orchestration/
 * orchestrator.js) means as reply text. Called by turn.js's turn core, so
 * both transports share this judgment and can never quietly diverge on
 * what counts as "nothing to say".
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
 * @param {import('./orchestration/orchestrator').ExecutionResult|null|undefined} executionResult
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
    case 'plan': // Decision Engine 3.0: the last successful step's output (normally Gaia's own generation, or a terminal capability result)
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

module.exports = {
  formatReply,
  createStreamEmitter,
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
