'use strict';

/**
 * Logos ↔ Capability contract (P0 — Gaia-roadmap).
 *
 * Capability-oriented, never capability-specific: Logos formulates WHAT must
 * be achieved; a capability adapter (Hermes today, others later) executes it
 * and translates the raw result back. Logos then judges whether the goal was
 * actually reached.
 *
 *   Logos
 *     ↓ CapabilityRequest { objective, instruction, expected_outcome }
 *   Capability adapter
 *     ↓ execution
 *   CapabilityResult (generic result model)
 *     ↓ evaluateOutcome
 *   OutcomeEvaluation { verdict: success|retry|alternative|ask_user|failure }
 *
 * Boundary: pure data + pure validation/evaluation helpers. Zero requires,
 * zero I/O, zero model calls, zero capability-specific fields. In particular
 * this module never mentions any concrete capability and never imports one —
 * adding a new capability means adding a new adapter, never touching this
 * contract.
 *
 * P1/P2/P3 are explicitly out of scope: no reflectOnTurn changes, no
 * Hindsight outcome-learning, no procedural learning, no capability
 * discovery, no new capability beyond the Hermes adapter.
 */

const OUTCOME_VERDICTS = Object.freeze(['success', 'retry', 'alternative', 'ask_user', 'failure']);

/**
 * Request/response field names that belong to a CONCRETE capability's own
 * interface and must therefore never appear on the generic contract. Checked
 * case-insensitively, top-level and one level inside `context`.
 */
const FORBIDDEN_CONTRACT_FIELDS = Object.freeze([
  'model',
  'provider',
  'baseurl',
  'authtoken',
  'apikey',
  // Concrete invocation-method names — the adapter owns how it calls its
  // capability; the contract only carries objective/instruction/outcome.
  'chat',
  'stream',
]);

const DEFAULT_MAX_ATTEMPTS = 3;
/** Hard ceiling: no caller can configure an unbounded (or absurd) loop. */
const HARD_MAX_ATTEMPTS = 10;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function forbiddenFieldPresent(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const keys = Object.keys(obj).map((k) => String(k).toLowerCase());
  for (const forbidden of FORBIDDEN_CONTRACT_FIELDS) {
    if (keys.includes(forbidden)) return forbidden;
  }
  return null;
}

/**
 * Normalizes `expected_outcome` to its object shape.
 * Accepts a plain description string (shorthand) or:
 *   { description, mustContain?, mustNotContain?, minLength? }
 * Returns the normalized object, or null when invalid.
 */
function normalizeExpectedOutcome(value) {
  if (isNonEmptyString(value)) {
    return { description: value.trim(), mustContain: [], mustNotContain: [], minLength: 0 };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!isNonEmptyString(value.description)) return null;
  const mustContain = value.mustContain === undefined ? [] : value.mustContain;
  const mustNotContain = value.mustNotContain === undefined ? [] : value.mustNotContain;
  if (!Array.isArray(mustContain) || mustContain.some((s) => !isNonEmptyString(s))) return null;
  if (!Array.isArray(mustNotContain) || mustNotContain.some((s) => !isNonEmptyString(s))) return null;
  const minLength = value.minLength === undefined ? 0 : value.minLength;
  if (typeof minLength !== 'number' || !Number.isFinite(minLength) || minLength < 0) return null;
  return {
    description: value.description.trim(),
    mustContain: mustContain.map((s) => s.trim()),
    mustNotContain: mustNotContain.map((s) => s.trim()),
    minLength,
  };
}

/**
 * Validates a CapabilityRequest. Returns null when valid, else a
 * human-readable problem string. Never throws.
 *
 * Shape:
 *   { capabilityId?, objective, instruction, expected_outcome, context? }
 */
function validateCapabilityRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return 'capability request must be an object';
  }
  if (request.capabilityId !== undefined
    && (!isNonEmptyString(request.capabilityId))) {
    return 'capability request "capabilityId" must be a non-empty string when present';
  }
  if (!isNonEmptyString(request.objective)) {
    return 'capability request requires a non-empty "objective" (what must be achieved)';
  }
  if (!isNonEmptyString(request.instruction)) {
    return 'capability request requires a non-empty "instruction" (how the capability should approach it)';
  }
  if (!normalizeExpectedOutcome(request.expected_outcome)) {
    return 'capability request requires an "expected_outcome" (string description or { description, mustContain?, mustNotContain?, minLength? })';
  }
  const forbiddenTop = forbiddenFieldPresent(request);
  if (forbiddenTop) {
    return `capability request must not carry capability-specific field "${forbiddenTop}" — the adapter owns it`;
  }
  if (request.context !== undefined) {
    if (!request.context || typeof request.context !== 'object' || Array.isArray(request.context)) {
      return 'capability request "context" must be a plain object when present';
    }
    const forbiddenCtx = forbiddenFieldPresent(request.context);
    if (forbiddenCtx) {
      return `capability request context must not carry capability-specific field "${forbiddenCtx}" — the adapter owns it`;
    }
  }
  return null;
}

/**
 * Creates a validated CapabilityRequest. Throws on invalid input (fail fast
 * at formulation time); the execution loop itself never throws for bad input
 * and instead reports an honest `failure`.
 */
function createCapabilityRequest(input = {}) {
  const request = {
    ...(isNonEmptyString(input.capabilityId) ? { capabilityId: input.capabilityId.trim() } : {}),
    objective: input.objective,
    instruction: input.instruction,
    expected_outcome: input.expected_outcome,
    ...(input.context !== undefined ? { context: input.context } : {}),
  };
  const problem = validateCapabilityRequest(request);
  if (problem) throw new Error(`Invalid capability request: ${problem}`);
  return Object.freeze({
    ...request,
    objective: request.objective.trim(),
    instruction: request.instruction.trim(),
    expected_outcome: Object.freeze(normalizeExpectedOutcome(request.expected_outcome)),
    ...(request.context !== undefined ? { context: request.context } : {}),
  });
}

/**
 * Normalizes any adapter output to the generic CapabilityResult model:
 *   { ok, technicalSuccess, output, error, requiresUserInput, missingInfo }
 * `ok` false means the execution itself failed (transport error, empty
 * output) — which says nothing yet about the OUTCOME (evaluateOutcome
 * decides that). Never throws.
 */
function toCapabilityResult(raw) {
  if (typeof raw === 'string') {
    const output = raw.trim();
    if (!output) {
      return {
        ok: false, technicalSuccess: false, output: null,
        error: 'capability returned no content', requiresUserInput: false, missingInfo: null,
      };
    }
    return {
      ok: true, technicalSuccess: true, output, error: null,
      requiresUserInput: false, missingInfo: null,
    };
  }
  if (!raw || typeof raw !== 'object') {
    return {
      ok: false, technicalSuccess: false, output: null,
      error: 'capability returned an unusable result', requiresUserInput: false, missingInfo: null,
    };
  }
  const output = isNonEmptyString(raw.output) ? raw.output : null;
  const error = isNonEmptyString(raw.error) ? raw.error.trim()
    : (!output ? 'capability returned no content' : null);
  const ok = raw.ok === true && !error && Boolean(output);
  return {
    ok,
    technicalSuccess: raw.technicalSuccess === true && Boolean(output),
    output,
    error,
    requiresUserInput: raw.requiresUserInput === true,
    missingInfo: isNonEmptyString(raw.missingInfo) ? raw.missingInfo.trim() : null,
  };
}

const MISSING_INFO_SIGNALS = Object.freeze([
  /missing/i,
  /\bneed (more|info|information)\b/i,
  /\bunclear\b/i,
  /\bambiguous\b/i,
  /\bclarif/i,
  /\bwhich .*you mean\b/i,
  /\bplease provide\b/i,
  /\bcould you (clarify|specify|provide|say|tell)\b/i,
  /\bi need .* (to proceed|from you)\b/i,
]);

const PERMANENT_FAILURE_SIGNALS = Object.freeze([
  /not available/i,
  /unknown capability/i,
  /\bunsupported\b/i,
  /\binvalid (request|capability|input)\b/i,
]);

function matchesAny(patterns, text) {
  const haystack = String(text || '');
  if (!haystack) return false;
  return patterns.some((p) => p.test(haystack));
}

/**
 * Logos outcome evaluation: judges a generic CapabilityResult against the
 * request's `expected_outcome`.
 *
 * A technically successful capability response is NOT automatically a
 * successful task — success means the expected outcome was actually reached.
 *
 * Returns { verdict, reason, missingInfo? } where verdict is one of
 * success|retry|alternative|ask_user|failure. Pure and deterministic (no
 * model call — P0 stays rule-based; richer judgment is future work, not a
 * gap in this contract). Never throws.
 */
function evaluateOutcome(request, result) {
  const problem = validateCapabilityRequest(request);
  if (problem) {
    return { verdict: 'failure', reason: `invalid capability request: ${problem}`, missingInfo: null };
  }
  const res = toCapabilityResult(result);
  const expected = normalizeExpectedOutcome(request.expected_outcome);

  // 1. The capability explicitly (or recognizably) needs the user.
  const missingInfo = res.missingInfo
    || (matchesAny(MISSING_INFO_SIGNALS, res.error) ? res.error : null)
    || (res.ok && matchesAny(MISSING_INFO_SIGNALS, res.output) ? res.output.slice(0, 200) : null);
  if (res.requiresUserInput || missingInfo) {
    return {
      verdict: 'ask_user',
      reason: missingInfo
        ? `capability needs missing information from the user: ${missingInfo}`
        : 'capability needs missing information from the user',
      missingInfo: missingInfo || null,
    };
  }

  // 2. The execution itself failed — retry the same approach, unless the
  // failure is recognizably permanent for this approach (then try another).
  if (!res.ok) {
    if (matchesAny(PERMANENT_FAILURE_SIGNALS, res.error)) {
      return {
        verdict: 'alternative',
        reason: `capability execution failed in a way retrying cannot fix: ${res.error}`,
        missingInfo: null,
      };
    }
    return {
      verdict: 'retry',
      reason: `capability execution failed (transient): ${res.error}`,
      missingInfo: null,
    };
  }

  // 3. Technical success — now the outcome decides. Anything unmet is
  // explicitly NOT success (a good-looking response that misses the goal
  // must never count as done).
  const output = res.output;
  const unmet = [];
  for (const required of expected.mustContain) {
    if (!output.toLowerCase().includes(required.toLowerCase())) {
      unmet.push(`missing required element: "${required}"`);
    }
  }
  for (const forbidden of expected.mustNotContain) {
    if (output.toLowerCase().includes(forbidden.toLowerCase())) {
      unmet.push(`contains excluded element: "${forbidden}"`);
    }
  }
  if (expected.minLength > 0 && output.length < expected.minLength) {
    unmet.push(`output too short (${output.length} < ${expected.minLength} chars)`);
  }
  if (unmet.length > 0) {
    return {
      verdict: 'alternative',
      reason: `expected outcome not reached — ${unmet.join('; ')}`,
      missingInfo: null,
    };
  }
  return { verdict: 'success', reason: 'expected outcome reached', missingInfo: null };
}

/**
 * Clamps a caller-supplied max_attempts to the hard [1, HARD_MAX] window.
 * Guarantees no unbounded loop whatever the caller configures.
 */
function clampMaxAttempts(value) {
  const n = Number(value === undefined ? DEFAULT_MAX_ATTEMPTS : value);
  if (!Number.isFinite(n)) return DEFAULT_MAX_ATTEMPTS;
  return Math.min(HARD_MAX_ATTEMPTS, Math.max(1, Math.floor(n)));
}

module.exports = {
  OUTCOME_VERDICTS,
  FORBIDDEN_CONTRACT_FIELDS,
  DEFAULT_MAX_ATTEMPTS,
  HARD_MAX_ATTEMPTS,
  validateCapabilityRequest,
  createCapabilityRequest,
  normalizeExpectedOutcome,
  toCapabilityResult,
  evaluateOutcome,
  clampMaxAttempts,
};
