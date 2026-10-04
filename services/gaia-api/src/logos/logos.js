'use strict';

/**
 * Logos (V3 unified cognitive faculty) — "what is the user trying to
 * achieve, what does this mean, what follows from the available
 * information, what hypotheses are plausible, and how certain are we?"
 *
 * V3 consolidation (Sep 2026 decision): intent interpretation and
 * reasoning are prompt-level faculties of ONE Logos pass, not separate
 * IntentIQ/ReasonIQ subsystems. This module replaces logos/reasonIQ.js:
 *
 *   USER -> Logos -> Reasoning LLM (provider role "reasoning")
 *        -> LogosResult -> Gaia
 *
 * Logos is a cognitive component, not an agent. It never calls Hermes,
 * Hindsight, or MCP; never selects or executes a tool; never writes to
 * any database; never decides Gaia's final response or action. An
 * optional intent hint (e.g. from IntentIQ, while it still exists) is
 * consumed as a hint to test — never trusted blindly, never required.
 * The model comes from the unified provider roles
 * (providerStore.js role "reasoning", REASONIQ_MODEL_* env fallback),
 * not from a per-faculty store. Everything produced is in-memory only;
 * nothing here persists a hypothesis or a result anywhere — Hindsight
 * persistence belongs to the caller (turn.js) via hypothesisManager.js.
 *
 * Gating: Logos decides for itself, per turn, whether the model needs to
 * be invoked at all — and it only does when there is genuinely something
 * to weigh. Without supplied evidence there is nothing for a model call
 * to reason *over*, so paying for a call there would only reproduce the
 * same honest "nothing to reason over" result the shallow path already
 * gives for free. Deep reasoning is therefore triggered by evidence, not
 * by intent or text length.
 *
 * "Shallow" is not "do nothing" — see shallowResult()/
 * EVIDENCE_DEPENDENT_INTENTS below. Before ever reaching for the model,
 * Logos still reads the cheap signals already on hand to report honest
 * uncertainty and information gaps.
 *
 * Evidence & context: the input's `evidence` list is a real, populated
 * channel (assembled upstream by reasoning/evidenceAssembler.js from what
 * turn.js already fetched — Hindsight recall, mental models, uploads).
 * Deep results link hypotheses/conclusions/contradictions back to stable
 * evidence IDs, validated strictly against the supplied list: invented
 * ids are stripped, never passed upstream.
 *
 * Hypothesis lifecycle: the input may carry `existingHypotheses`
 * (retrieved by the caller; Logos never touches Hindsight), the model can
 * recognize them via existingId instead of duplicating them, and it
 * reports explicit per-evidence `hypothesisUpdates` (relation + bounded
 * confidenceDelta + rationale). Logos itself performs NO state
 * transitions and NEVER promotes to `confirmed` — structured updates flow
 * to reasoning/hypothesisManager.js (Absolute Override: only a human
 * confirms).
 */

const crypto = require('crypto');
const { buildLogosPrompt } = require('./logosPrompt');
const { parseAndValidateReasoningOutput, MalformedReasoningOutputError } = require('./logosValidate');
const { createLogosModelClient, readLogosTimeoutMs } = require('./logosModelClient');
const { resolveRoleConfig } = require('../providerConfigResolver');
const { createProviderStore } = require('../providerStore');
const { SCHEMA_VERSION, REASONER_VERSION } = require('./logosSchema');
const { logLogosResult } = require('./logosLog');

/**
 * Resolves the default Logos model from the unified provider roles —
 * role "reasoning" first, REASONIQ_MODEL_* env vars as fallback (see
 * providerConfigResolver.js). Returns null when nothing is configured;
 * the caller degrades to an honest shallow result instead of failing.
 */
function defaultModelConfig(providerStore, env = process.env) {
  try {
    return resolveRoleConfig('reasoning', providerStore || createProviderStore(), env);
  } catch (_) {
    return null;
  }
}

// --- reasoning depth heuristic --------------------------------------------

/**
 * Intents whose turns never need weighed conclusions from evidence — plain
 * conversation and questions about Gaia herself. Even with evidence in
 * hand (a recalled memory riding along), these stay shallow: their answers
 * are conversational, and the turn answers them natively.
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
 * @param {{ text: string, evidence?: Array, intentHint?: object|null, intentDecision?: object|null }} input
 * @returns {'shallow'|'deep'}
 */
function decideLogosDepth(input) {
  const hasEvidence = Array.isArray(input.evidence) && input.evidence.length > 0;
  if (!hasEvidence) return 'shallow';

  const decision = input.intentHint || input.intentDecision || null;
  if (decision) {
    if (!decision.intent && decision.status === 'unknown') return 'shallow';
    if (decision.status === 'ambiguous') return 'shallow';
    if (decision.intent && CONTEXT_ONLY_INTENTS.has(decision.intent)) return 'shallow';
  }
  return 'deep';
}

/**
 * The explicit reason behind a shallow decideReasoningDepth outcome — the
 * gate's own answer to "why was this turn skipped?". A sister function, not
 * a second heuristic: turn.js logs this next to the depth decision so the
 * decision log shows WHY ReasonIQ let a turn pass, not just that it did —
 * without it, a shallow turn leaves no trace at all and "ReasonIQ never
 * does anything" cannot be distinguished from "the gate is too strict".
 * @param {{ text: string, evidence?: Array, intentHint?: object|null, intentDecision?: object|null }} input
 * @returns {'no_evidence'|'context_only_intent'|'ambiguous_intent'|'unknown_intent'|'deep'}
 */
function explainLogosDepth(input) {
  const hasEvidence = Array.isArray(input.evidence) && input.evidence.length > 0;
  if (!hasEvidence) return 'no_evidence';

  const decision = input.intentHint || input.intentDecision || null;
  if (decision) {
    if (!decision.intent && decision.status === 'unknown') return 'unknown_intent';
    if (decision.status === 'ambiguous') return 'ambiguous_intent';
    if (decision.intent && CONTEXT_ONLY_INTENTS.has(decision.intent)) return 'context_only_intent';
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
    // v1.0 Cognitive Analysis Model — additive defaults; deep results fill
    // them from the validated model output, shallow results stay empty.
    observations: [],
    openQuestions: [],
    relationships: [],
    reflection: null,
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

  const hint = input.intentHint || input.intentDecision || null;
  const intent = hint && hint.intent;
  const status = hint && hint.status;

  const uncertainties = [];
  const informationGaps = [];
  let confidence = 0.5;
  let sufficientForConclusion = true;

  if (!hint || status === 'unknown') {
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

// --- public API ------------------------------------------------------------

/**
 * @typedef {Object} LogosInput
 * @property {string} text - the current user input
 * @property {object|null} [intentHint] - optional intent hint (e.g. IntentIQ's decision) — tested, never trusted blindly, never required
 * @property {object|null} [intentDecision] - legacy alias of intentHint, accepted during migration
 * @property {Array<{role: string, content: string}>} [conversationContext] - recent turns — CONTEXT, never mixed into evidence
 * @property {Array<{id?: string, source?: string, type?: string, content: string, relevance?: number}>} [evidence] - evidence assembled upstream (evidenceAssembler.js) from what the context layer already gathered; Logos never fetches anything itself
 * @property {Array<{id: string, statement: string, status?: string, confidence?: number, evidenceFor?: string[], evidenceAgainst?: string[]}>} [existingHypotheses] - hypotheses Gaia is already tracking (retrieved by the CALLER — never by Logos); context only
 * @property {Array<{id: string, statement: string, status?: string, confidence?: number|null}>} [existingPatterns] - patterns Gaia is already tracking (retrieved by the CALLER); context only, for relationship identification
 * @property {string} [assistantReply] - Gaia's already-delivered reply for this turn — analysis context only, never edited
 * @property {string} [correlationId]
 * @property {string} [contextId]
 */

/**
 * Evaluates one turn and returns a LogosResult. Never throws — a
 * model failure or malformed output degrades to an honest
 * `degradedResult`, never taking down a turn.
 *
 * @param {LogosInput} input
 * @param {{ model?: { chat: Function, isConfigured?: Function }, reasoningModel?: { chat: Function, isConfigured?: Function }, providerStore?: object, silent?: boolean, logger?: Function }} [options] `reasoningModel` is the legacy option name, accepted during migration.
 * @returns {Promise<import('./logosSchema').LogosResult>}
 */
async function evaluate(input, options = {}) {
  const correlationId = input.correlationId || crypto.randomUUID();
  const injected = options.model || options.reasoningModel || null;
  let model = injected;
  if (!model) {
    const roleConfig = defaultModelConfig(options.providerStore);
    model = roleConfig
      ? createLogosModelClient({ ...roleConfig, timeoutMs: readLogosTimeoutMs() })
      : { chat: async () => { throw new Error('logos model not configured'); }, isConfigured: () => false };
  }
  const modelConfigured = typeof model.isConfigured === 'function' ? model.isConfigured() : true;

  const depth = decideLogosDepth(input);

  let result;
  if (depth === 'shallow') {
    result = shallowResult(input);
  } else {
    const messages = buildLogosPrompt(input);
    try {
      const raw = await model.chat(messages, {
        logger: options.logger,
        contextId: input.contextId || null,
        correlationId,
      });
      // The supplied evidence list is also the provenance whitelist (0.2
      // §16): any evidence id the model cites that is not in it was
      // invented, and is stripped before the result goes anywhere. 0.3
      // applies the same discipline to hypothesis references: existingId /
      // hypothesisUpdates must point at hypotheses that were in the input
      // context, never at ones the model conjured up.
      const validated = parseAndValidateReasoningOutput(
        raw,
        Array.isArray(input.evidence) ? input.evidence : [],
        Array.isArray(input.existingHypotheses) ? input.existingHypotheses : [],
        Array.isArray(input.existingPatterns) ? input.existingPatterns : []
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

  if (!options.silent) {
    logLogosResult(
      { result, input: input.text, contextId: input.contextId, correlationId },
      options.logger
    );
  }

  return result;
}

// Backward-compat aliases for callers mid-migration.
const decideReasoningDepth = decideLogosDepth;
const explainReasoningDepth = explainLogosDepth;

module.exports = { evaluate, decideLogosDepth, explainLogosDepth, decideReasoningDepth, explainReasoningDepth, SCHEMA_VERSION };
