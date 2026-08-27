'use strict';

/**
 * Logos.ReasonIQ v0.1 — "what does this mean, what follows from the
 * available information, what hypotheses are plausible, and how certain
 * are we?"
 *
 * Scope for this phase (see the ReasonIQ v0.1 implementation brief):
 *
 *   USER -> IntentIQ -> IntentDecision -> ReasonIQ -> Reasoning LLM
 *        -> ReasoningResult -> Gaia
 *
 * ReasonIQ is a cognitive component, not an agent. It never calls Hermes,
 * Hindsight, or MCP; never selects or executes a tool; never writes to
 * any database; never decides Gaia's final response or action. It
 * consumes an already-produced IntentDecision (logos/intentIQ.js) rather
 * than re-deriving intent, and it owns its own reasoning model — a
 * separate, independently configurable LLM seam (reasoningModelClient.js)
 * that is not Hermes and not a Gaia capability. Everything it produces is
 * in-memory only; nothing here persists a hypothesis or a reasoning
 * result anywhere (Â§8 of the brief — Hindsight is out of scope this
 * phase).
 *
 * Reasoning depth: ReasonIQ decides for itself, per turn, whether the
 * reasoning model needs to be invoked at all (Â§6) — and it only does when
 * there is genuinely something to weigh. Without supplied evidence there
 * is nothing for a model call to reason *over*: no intent, however
 * substantial, turns an empty evidence list into hypotheses or verdicts,
 * so paying for a call there would only ever reproduce the same honest
 * "nothing to reason over" result the shallow path already gives for
 * free. Deep reasoning is therefore triggered by evidence, not by intent
 * or text length — the model *is* the reasoning engine, used only once
 * there is something to use it on.
 *
 * "Shallow" is not "do nothing", though — see shallowResult()/
 * EVIDENCE_DEPENDENT_INTENTS below. Before ever reaching for the model,
 * ReasonIQ still reads the cheap signals already on hand (IntentIQ's own
 * status, and whether an evidence-dependent intent got any evidence at
 * all) to report honest uncertainty and information gaps. Getting more
 * intelligent than that without a model call is future work, not a gap
 * in this pass — see the module's own limitations note in the
 * implementation report.
 *
 * v0.2 — Evidence & Context Reasoning: the input's `evidence` list is now a
 * real, populated channel (assembled upstream by reasoning/
 * evidenceAssembler.js from what turn.js already fetched — Hindsight
 * recall, mental models, uploads). Deep results link hypotheses/
 * conclusions/contradictions back to stable evidence IDs, validated
 * strictly against the supplied list: invented ids are stripped, never
 * passed upstream. Contradictions carry an explicit significance;
 * sufficiency is reported as both sufficientForConclusion and its named
 * alias evidenceSufficient — what Gaia's Decision Engine does with that
 * stays entirely Gaia's call.
 *
 * v0.3 — Hypothesis Lifecycle & Evidence Updates: the input may carry
 * `existingHypotheses` (retrieved by the caller; ReasonIQ still never
 * touches Hindsight), the model can recognize them via existingId instead
 * of duplicating them, and it reports explicit per-evidence
 * `hypothesisUpdates` (relation + bounded confidenceDelta + rationale).
 * ReasonIQ itself performs NO state transitions — structured updates flow
 * to reasoning/hypothesisManager.js, which validates every transition
 * against an explicit lifecycle and evidence policy, with persistence via
 * an injected sink only.
 */

const crypto = require('crypto');
const { buildReasoningPrompt } = require('./reasonPrompt');
const { parseAndValidateReasoningOutput, MalformedReasoningOutputError } = require('./reasonValidate');
const { createReasoningModelClient } = require('./reasoningModelClient');
const { resolveReasoningModelConfig } = require('./reasoningModelConfigResolver');
const { createReasoningModelStore } = require('./reasoningModelStore');
const { SCHEMA_VERSION, REASONER_VERSION } = require('./reasonModels');
const { logReasoningResult } = require('./reasonLog');
const { evaluateConversationalOpportunity } = require('./conversationalOpportunity');

// --- reasoning depth heuristic --------------------------------------------

/**
 * Intents whose turns never need weighed conclusions from evidence — plain
 * conversation and questions about Gaia herself. Even with evidence in
 * hand (a recalled memory riding along), these stay shallow: their answers
 * are conversational, and the Decision Engine already routes them natively.
 */
const CONTEXT_ONLY_INTENTS = new Set([
  'converse',
  'meta.relational',
  'meta.question',
  'meta.correction',
  'meta.capability_question',
]);

/**
 * Deep reasoning is warranted when there is evidence to weigh AND the turn
 * is actually trying to do something with it (brief §14's gating: "simple
 * conversational turn → shallow; analysis / decision / contradiction /
 * hypothesis task → evidence-aware reasoning"). Mere evidence PRESENCE is
 * not a task signal: since 0.2 the evidence channel is populated whenever
 * Hindsight happened to recall something, so a personal-memory chat turn
 * carrying one recalled item must not suddenly pay for a model call or get
 * re-routed away from Gaia's native voice. An IntentIQ decision marking the
 * turn unclassified/ambiguous/conversational keeps it shallow; any other
 * intent (or no decision at all — the explicit-evidence eval/CLI shape)
 * lets evidence drive depth as before.
 * @param {{ text: string, evidence?: Array, intentDecision?: object|null }} input
 * @returns {'shallow'|'deep'}
 */
function decideReasoningDepth(input) {
  const hasEvidence = Array.isArray(input.evidence) && input.evidence.length > 0;
  if (!hasEvidence) return 'shallow';

  const decision = input.intentDecision;
  if (decision) {
    if (!decision.intent && decision.status === 'unknown') return 'shallow';
    if (decision.status === 'ambiguous') return 'shallow';
    if (decision.intent && CONTEXT_ONLY_INTENTS.has(decision.intent)) return 'shallow';
  }
  return 'deep';
}

// --- fallback / shallow result construction -------------------------------

/**
 * Evidence metadata for observability (brief Â§18 logs): how many items were
 * supplied and from which source kinds — computed from the INPUT, never
 * invented by a model.
 */
function evidenceMeta(evidence) {
  const items = Array.isArray(evidence) ? evidence : [];
  const sources = [...new Set(items.map((e) => e && e.source).filter(Boolean))];
  return { evidenceCount: items.length, evidenceSources: sources };
}

function baseResult(overrides = {}, evidence = []) {
  const { meta: overrideMeta, ...rest } = overrides;
  const result = {
    schemaVersion: SCHEMA_VERSION,
    interpretation: '',
    reasoningDepth: 'shallow',
    evidence: [],
    hypotheses: [],
    hypothesisUpdates: [],
    contradictions: [],
    uncertainties: [],
    informationGaps: [],
    conclusions: [],
    sufficientForConclusion: false,
    confidence: 0,
    ...rest,
    // Named alias of sufficientForConclusion (ReasonIQ 0.2 brief Â§7) —
    // "is there enough evidence to support a conclusion?" is exactly the
    // same judgment; both fields always carry the same value.
    evidenceSufficient: Boolean(rest.sufficientForConclusion),
    meta: {
      reasonerVersion: REASONER_VERSION,
      reasoningModelConfigured: false,
      fallbackReason: null,
      ...evidenceMeta(evidence),
      ...(overrideMeta || {}),
    },
  };
  return result;
}

// Intents that plausibly need supporting material to actually conclude
// anything — a request to explain, transform, decide, or act on
// something is only as good as what it has to work with. Kept small and
// legible, same posture as intentIQ.js's own signal sets: a heuristic,
// not a claim to have reasoned about the specific turn.
const EVIDENCE_DEPENDENT_INTENTS = new Set(['inform.explain', 'create.transform', 'decide.support', 'act.perform']);

/**
 * A turn ReasonIQ judged not to need the reasoning model — "shallow"
 * means "no model call," not "no judgment." It still reads the signals
 * already on hand (IntentIQ's own status, and whether an evidence-
 * dependent intent got any) to report honest uncertainty and information
 * gaps, rather than flattening every such turn to the same unearned 0.5
 * confidence regardless of what's actually known about it. This is
 * exactly the kind of cheap, pre-LLM judgment Â§6 asks ReasonIQ to make —
 * it just didn't use to make much of one.
 */
function shallowResult(input) {
  const suppliedEvidence = Array.isArray(input.evidence) ? input.evidence : [];
  const text = String(input.text || '').trim();
  if (!text) {
    return baseResult({
      interpretation: 'No interpretable user input was supplied.',
      reasoningDepth: 'shallow',
      uncertainties: ['no input text was supplied'],
      sufficientForConclusion: false,
      confidence: 0,
    }, suppliedEvidence);
  }

  const intent = input.intentDecision && input.intentDecision.intent;
  const status = input.intentDecision && input.intentDecision.status;

  const uncertainties = [];
  const informationGaps = [];
  let confidence = 0.5;
  let sufficientForConclusion = true;

  if (!input.intentDecision || status === 'unknown') {
    uncertainties.push('what the user is trying to achieve for this turn is unclear');
    confidence = 0.25;
    sufficientForConclusion = false;
  } else if (status === 'ambiguous') {
    uncertainties.push('multiple interpretations of this turn are plausible and were not resolved');
    confidence = Math.min(confidence, 0.3);
    sufficientForConclusion = false;
  }

  if (intent && EVIDENCE_DEPENDENT_INTENTS.has(intent)) {
    informationGaps.push('no supporting evidence was supplied for this turn');
    confidence = Math.min(confidence, 0.45);
    sufficientForConclusion = false;
  }

  return baseResult({
    interpretation: `The user said: ${text}`,
    reasoningDepth: 'shallow',
    uncertainties,
    informationGaps,
    sufficientForConclusion,
    confidence,
  }, suppliedEvidence);
}

/** The reasoning model was warranted but unavailable or produced unusable output — never silently substitute a guess. */
function degradedResult(reason, modelConfigured, evidence = []) {
  return baseResult({
    interpretation: 'Reasoning could not be completed for this turn.',
    reasoningDepth: 'deep',
    informationGaps: ['the reasoning model could not be reached or returned an unusable result'],
    sufficientForConclusion: false,
    confidence: 0,
    meta: { reasonerVersion: REASONER_VERSION, reasoningModelConfigured: modelConfigured, fallbackReason: reason },
  }, evidence);
}

// --- conversational opportunity (advisory, never an instruction) --------

function attachConversationalOpportunity(result, input) {
  try {
    const opp = evaluateConversationalOpportunity({
      text: input.text,
      conversationContext: input.conversationContext,
      intentDecision: input.intentDecision,
    });
    result.conversationalOpportunity = opp;
  } catch (_) {
    // Advisory only — never break reasoning
    result.conversationalOpportunity = {
      present: false,
      strength: 0,
      subject: null,
      reason: null,
      naturalResponse: 'none',
      suggestedFollowUp: null,
    };
  }
  return result;
}

// --- public API ------------------------------------------------------------

/**
 * @typedef {Object} ReasonIQInput
 * @property {string} text - the current user input
 * @property {object|null} [intentDecision] - IntentIQ's IntentDecision for this turn (logos/intentIQ.js) — consumed, never re-derived
 * @property {Array<{role: string, content: string}>} [conversationContext] - recent turns — CONTEXT (§10), never mixed into evidence
 * @property {Array<{id?: string, source?: string, type?: string, content: string, relevance?: number}>} [evidence] - evidence assembled upstream (evidenceAssembler.js) from what the context layer already gathered; ReasonIQ never fetches anything itself
 * @property {Array<{id: string, statement: string, status?: string, confidence?: number, evidenceFor?: string[], evidenceAgainst?: string[]}>} [existingHypotheses] - 0.3: hypotheses Gaia is already tracking (retrieved by the CALLER — never by ReasonIQ); context only (brief §16)
 * @property {string} [correlationId]
 * @property {string} [contextId]
 */

/**
 * Evaluates one turn and returns a ReasoningResult. Never throws — a
 * reasoning-model failure or malformed output degrades to an honest
 * `degradedResult`, exactly like intentIQ.js never lets its own failure
 * modes take down a turn.
 *
 * @param {ReasonIQInput} input
 * @param {{ reasoningModel?: { chat: Function, isConfigured?: Function }, silent?: boolean, logger?: Function }} [options]
 * @returns {Promise<import('./reasonModels').ReasoningResult>}
 */
async function evaluate(input, options = {}) {
  const correlationId = input.correlationId || crypto.randomUUID();
  const model = options.reasoningModel || createReasoningModelClient(resolveReasoningModelConfig({ store: createReasoningModelStore() }));
  const modelConfigured = typeof model.isConfigured === 'function' ? model.isConfigured() : true;

  const depth = decideReasoningDepth(input);

  let result;
  if (depth === 'shallow') {
    result = shallowResult(input);
  } else {
    const messages = buildReasoningPrompt(input);
    try {
      const raw = await model.chat(messages);
      // The supplied evidence list is also the provenance whitelist (0.2
      // §16): any evidence id the model cites that is not in it was
      // invented, and is stripped before the result goes anywhere. 0.3
      // applies the same discipline to hypothesis references: existingId /
      // hypothesisUpdates must point at hypotheses that were in the input
      // context, never at ones the model conjured up.
      const validated = parseAndValidateReasoningOutput(
        raw,
        Array.isArray(input.evidence) ? input.evidence : [],
        Array.isArray(input.existingHypotheses) ? input.existingHypotheses : []
      );
      const { evidenceCount, evidenceSources } = evidenceMeta(input.evidence);
      result = {
        schemaVersion: SCHEMA_VERSION,
        reasoningDepth: 'deep',
        ...validated,
        evidenceSufficient: Boolean(validated.sufficientForConclusion),
        meta: {
          reasonerVersion: REASONER_VERSION,
          reasoningModelConfigured: modelConfigured,
          fallbackReason: null,
          evidenceCount,
          evidenceSources,
        },
      };
    } catch (err) {
      const reason = err instanceof MalformedReasoningOutputError ? 'malformed_model_output' : 'reasoning_model_unavailable';
      result = degradedResult(reason, modelConfigured, input.evidence);
    }
  }

  // Conversational opportunity is advisory guidance for Gaia's response
  // layer — computed deterministically, never a model call, never a
  // decision to ask a question. Attached on every path (shallow, deep,
  // degraded) for backwards compatibility (optional field).
  attachConversationalOpportunity(result, input);

  if (!options.silent) {
    logReasoningResult(
      { result, input: input.text, contextId: input.contextId, correlationId },
      options.logger
    );
  }

  return result;
}

module.exports = { evaluate, decideReasoningDepth, SCHEMA_VERSION };
