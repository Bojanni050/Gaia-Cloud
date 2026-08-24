'use strict';

/**
 * Validates and coerces the semantic classifier's raw text output into a
 * well-formed SemanticResult. Deliberately strict about shape (a genuinely
 * malformed or non-JSON response throws MalformedSemanticOutputError,
 * which intentIQ.js's classifySemantic catches and degrades from — the
 * heuristic classifier remains authoritative rather than ever passing bad
 * data upstream), lenient about a model's minor field omissions — the
 * same posture reasonValidate.js already keeps for ReasonIQ.
 */

const { isKnownIntent, SOURCE_OF_TRUTH_VALUES } = require('./intentTaxonomy');
const { SPEECH_ACTS } = require('./intentSemanticPrompt');
const { clampConfidence } = require('./reasonValidate');

class MalformedSemanticOutputError extends Error {
  constructor(reason) {
    super(`malformed semantic classifier output: ${reason}`);
    this.name = 'MalformedSemanticOutputError';
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asString(value, fallback = null) {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function coerceCandidate(item) {
  if (!item || typeof item !== 'object' || !isKnownIntent(item.intent)) return null;
  return { intent: item.intent, confidence: clampConfidence(item.confidence) };
}

/**
 * `resolvedTo: null` is a legitimate, honest answer (see
 * intentSemanticPrompt.js — "never guess"), not a parsing failure; only a
 * missing/empty `expression` invalidates the whole referent. Confidence
 * defaults to 0 (not clampConfidence's usual 0.5 fallback) when the model
 * omits it — an unstated confidence for a referent should never be read as
 * a coin flip's worth of trust.
 */
function coerceReferent(item) {
  if (!item || typeof item !== 'object' || typeof item.expression !== 'string' || item.expression.length === 0) {
    return null;
  }
  const resolvedTo = asString(item.resolvedTo);
  return {
    expression: item.expression,
    resolvedTo,
    confidence: clampConfidence(item.confidence, 0),
    source: resolvedTo ? 'conversation' : null,
  };
}

/**
 * @param {string} rawText raw text content from the semantic classifier model
 * @returns {{
 *   intent: string|null,
 *   confidence: number,
 *   candidates: Array<{intent: string, confidence: number}>,
 *   sourceOfTruth: string,
 *   speechAct: string|null,
 *   referents: Array<{expression: string, resolvedTo: string|null, confidence: number, source: string|null}>,
 *   ambiguous: boolean,
 *   reason: string|null,
 * }}
 * @throws {MalformedSemanticOutputError}
 */
function parseAndValidateSemanticOutput(rawText) {
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new MalformedSemanticOutputError(`not valid JSON: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new MalformedSemanticOutputError('top-level output is not a JSON object');
  }

  const intent = isKnownIntent(parsed.intent) ? parsed.intent : null;

  return {
    intent,
    confidence: intent ? clampConfidence(parsed.confidence) : 0,
    candidates: asArray(parsed.candidates).map(coerceCandidate).filter(Boolean),
    sourceOfTruth: SOURCE_OF_TRUTH_VALUES.includes(parsed.sourceOfTruth) ? parsed.sourceOfTruth : 'unknown',
    speechAct: SPEECH_ACTS.includes(parsed.speechAct) ? parsed.speechAct : null,
    referents: asArray(parsed.referents).map(coerceReferent).filter(Boolean),
    ambiguous: Boolean(parsed.ambiguous),
    reason: asString(parsed.reason),
  };
}

module.exports = { parseAndValidateSemanticOutput, MalformedSemanticOutputError };
