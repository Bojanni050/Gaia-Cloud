'use strict';

/**
 * Validates and coerces a reasoning model's raw text output into a
 * well-formed ReasoningResult body (everything except schemaVersion/
 * reasoningDepth/meta, which reasonIQ.js attaches itself). Deliberately
 * strict about shape, lenient about a model's minor field omissions —
 * a missing optional array becomes [], a missing optional string becomes
 * null — but a genuinely malformed or non-JSON response throws
 * MalformedReasoningOutputError, which reasonIQ.js catches and turns into
 * an honest fallback result rather than ever passing bad data upstream.
 */

const { isValidEpistemicStatus, isValidVerdict, isValidHypothesisStatus, CONTRADICTION_SIGNIFICANCE } = require('./reasonModels');

class MalformedReasoningOutputError extends Error {
  constructor(reason) {
    super(`malformed reasoning model output: ${reason}`);
    this.name = 'MalformedReasoningOutputError';
  }
}

function clampConfidence(value, fallback = 0.5) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(0.95, Math.max(0, n)); // soul.md: never claim certainty
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function coerceEvidenceItem(item) {
  if (!item || typeof item !== 'object') throw new MalformedReasoningOutputError('evidence item is not an object');
  const type = isValidEpistemicStatus(item.type) ? item.type : 'unknown';
  return {
    content: asString(item.content),
    type,
    origin: ['conversation', 'supplied', 'unknown'].includes(item.origin) ? item.origin : 'unknown',
  };
}

function coerceEvidenceAssessment(item) {
  if (!item || typeof item !== 'object') throw new MalformedReasoningOutputError('evidence assessment is not an object');
  if (!isValidVerdict(item.verdict)) {
    throw new MalformedReasoningOutputError(`invalid evidence verdict: ${JSON.stringify(item.verdict)}`);
  }
  return {
    evidence: asString(item.evidence),
    verdict: item.verdict,
    confidence: clampConfidence(item.confidence),
    reasoning: asString(item.reasoning),
    newConfidence: clampConfidence(item.newConfidence, clampConfidence(item.confidence)),
  };
}

function coerceHypothesis(item) {
  if (!item || typeof item !== 'object' || !item.statement) {
    throw new MalformedReasoningOutputError('hypothesis missing a statement');
  }
  const status = isValidHypothesisStatus(item.status) ? item.status : 'proposed';
  return {
    id: require('crypto').randomUUID(),
    statement: asString(item.statement),
    confidence: clampConfidence(item.confidence),
    status,
    verificationPlan: typeof item.verificationPlan === 'string' ? item.verificationPlan : null,
    // ReasonIQ 0.2 provenance: ids into the assembled evidence list. Only
    // ever kept when they survive the known-evidence filter in
    // parseAndValidateReasoningOutput — a model may never invent a source.
    evidenceFor: dedupeIds(asArray(item.evidenceFor)),
    evidenceAgainst: dedupeIds(asArray(item.evidenceAgainst)),
    // 0.3: recognized EXISTING hypothesis (validated against the supplied
    // list in resolveProvenance — invented ids become null here).
    existingId: typeof item.existingId === 'string' && item.existingId.trim() ? item.existingId.trim() : null,
    evidenceAssessments: asArray(item.evidenceAssessments).map(coerceEvidenceAssessment),
  };
}

/**
 * 0.3 (brief §6): one explicit evidence update for an existing hypothesis.
 * The relation must be one of the four verdicts — anything else is a
 * malformed output, not silently coerced, because these drive real state
 * transitions downstream (hypothesisManager.js).
 */
function coerceHypothesisUpdate(item) {
  if (!item || typeof item !== 'object') throw new MalformedReasoningOutputError('hypothesisUpdate is not an object');
  if (!isValidVerdict(item.relation)) {
    throw new MalformedReasoningOutputError(`invalid hypothesisUpdate relation: ${JSON.stringify(item.relation)}`);
  }
  const deltaRaw = Number(item.confidenceDelta);
  let delta = 0;
  if (Number.isFinite(deltaRaw)) delta = Math.min(0.5, Math.max(-0.5, deltaRaw)); // bounded: no arbitrary jumps
  return {
    hypothesisId: typeof item.hypothesisId === 'string' && item.hypothesisId.trim() ? item.hypothesisId.trim() : null,
    statement: asString(item.statement, null),
    evidenceId: typeof item.evidenceId === 'string' && item.evidenceId.trim() ? item.evidenceId.trim() : null,
    relation: item.relation,
    confidenceDelta: delta,
    rationale: asString(item.rationale, null),
  };
}

function coerceSignificance(value) {
  return CONTRADICTION_SIGNIFICANCE.includes(value) ? value : 'medium';
}

function coerceContradiction(item) {
  if (!item || typeof item !== 'object') throw new MalformedReasoningOutputError('contradiction is not an object');
  const description = asString(item.description, null);
  const explanation = asString(item.explanation, null);
  const a = asString(item.a);
  const b = asString(item.b);
  // v0.1 carried only the content sides; 0.2 adds id links + an explicit
  // significance. A contradiction without either content side or an
  // explanation says nothing and is rejected rather than passed upstream.
  if (!a && !b && !description && !explanation) {
    throw new MalformedReasoningOutputError('contradiction has no content on either side');
  }
  return {
    a,
    b,
    explanation,
    evidenceA: typeof item.evidenceA === 'string' && item.evidenceA.trim() ? item.evidenceA.trim() : null,
    evidenceB: typeof item.evidenceB === 'string' && item.evidenceB.trim() ? item.evidenceB.trim() : null,
    description: description || explanation || null,
    significance: coerceSignificance(item.significance),
  };
}

function coerceConclusion(item) {
  if (!item || typeof item !== 'object' || !item.statement) {
    throw new MalformedReasoningOutputError('conclusion missing a statement');
  }
  const basis = ['fact', 'inference', 'hypothesis'].includes(item.basis) ? item.basis : 'inference';
  return {
    statement: asString(item.statement),
    basis,
    confidence: clampConfidence(item.confidence),
    // Provenance ids; resolved to {id, source} against the supplied
    // evidence list by parseAndValidateReasoningOutput below.
    evidenceIds: dedupeIds(asArray(item.evidence)),
  };
}

function dedupeIds(value) {
  const out = [];
  for (const v of value) {
    if (typeof v !== 'string') continue;
    const id = v.trim();
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Resolves every provenance link against the evidence that was ACTUALLY
 * supplied to ReasonIQ this turn. An id the model invented is dropped —
 * never silently accepted (brief §16: no fabricated sources). When no
 * known-evidence list is supplied (legacy callers), links pass through
 * unresolved with `source: null` rather than being guessed. The same
 * discipline applies to 0.3's hypothesis links: existingId and
 * hypothesisUpdates' hypothesisId must reference hypotheses that were in
 * the input list, or they are nulled/dropped — a model can never conjure a
 * hypothesis into being updated.
 * @param {object} body a parsed-and-coerced result body
 * @param {Array<{id?: string, source?: string}>|undefined} knownEvidence
 * @param {Array<{id: string}>|undefined} knownExisting
 */
function resolveProvenance(body, knownEvidence, knownExisting) {
  const known = new Map();
  for (const e of Array.isArray(knownEvidence) ? knownEvidence : []) {
    if (e && typeof e.id === 'string' && e.id) known.set(e.id, typeof e.source === 'string' ? e.source : null);
  }

  const knownHypIds = new Set((Array.isArray(knownExisting) ? knownExisting : [])
    .map((h) => (h && typeof h.id === 'string' ? h.id : null))
    .filter(Boolean));

  for (const h of body.hypotheses) {
    h.evidenceFor = known.size ? h.evidenceFor.filter((id) => known.has(id)) : h.evidenceFor;
    h.evidenceAgainst = known.size ? h.evidenceAgainst.filter((id) => known.has(id)) : h.evidenceAgainst;
    if (h.existingId != null && knownHypIds.size > 0 && !knownHypIds.has(h.existingId)) {
      h.existingId = null; // invented hypothesis reference — never pass it upstream
    }
  }

  // Updates must route to a hypothesis that actually exists this turn.
  if (knownHypIds.size > 0) {
    body.hypothesisUpdates = body.hypothesisUpdates.filter((u) => u.hypothesisId && knownHypIds.has(u.hypothesisId));
  }
  for (const u of body.hypothesisUpdates) {
    if (u.evidenceId != null && known.size > 0 && !known.has(u.evidenceId)) u.evidenceId = null;
  }

  for (const c of body.contradictions) {
    if (known.size) {
      if (c.evidenceA != null && !known.has(c.evidenceA)) c.evidenceA = null;
      if (c.evidenceB != null && !known.has(c.evidenceB)) c.evidenceB = null;
    }
  }

  body.conclusions = body.conclusions.map((c) => {
    const resolved = {
      statement: c.statement,
      basis: c.basis,
      confidence: c.confidence,
      evidence: c.evidenceIds
        .filter((id) => (known.size ? known.has(id) : true))
        .map((id) => ({ id, source: known.get(id) != null ? known.get(id) : null })),
    };
    delete resolved.evidenceIds;
    return resolved;
  });
  return body;
}

/**
 * @param {string} rawText raw text content from the reasoning model
 * @param {Array<{id?: string, source?: string}>} [knownEvidence] the evidence
 *   actually supplied to ReasonIQ this turn — provenance ids are validated
 *   against it; invented ids are dropped, never passed upstream
 * @param {Array<{id: string}>} [knownExisting] the existing hypotheses
 *   supplied as context (0.3) — existingId/hypothesisUpdates references are
 *   validated against them; invented ones are dropped/nulled
 * @returns {object} a validated ReasoningResult body (no schemaVersion/reasoningDepth/meta)
 * @throws {MalformedReasoningOutputError}
 */
function parseAndValidateReasoningOutput(rawText, knownEvidence, knownExisting) {
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new MalformedReasoningOutputError(`not valid JSON: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new MalformedReasoningOutputError('top-level output is not a JSON object');
  }
  if (typeof parsed.interpretation !== 'string' || parsed.interpretation.trim() === '') {
    throw new MalformedReasoningOutputError('missing or empty interpretation');
  }

  const body = {
    interpretation: parsed.interpretation,
    evidence: asArray(parsed.evidence).map(coerceEvidenceItem),
    hypotheses: asArray(parsed.hypotheses).map(coerceHypothesis),
    hypothesisUpdates: asArray(parsed.hypothesisUpdates).map(coerceHypothesisUpdate),
    contradictions: asArray(parsed.contradictions).map(coerceContradiction),
    uncertainties: asArray(parsed.uncertainties).map((u) => asString(u)).filter(Boolean),
    informationGaps: asArray(parsed.informationGaps).map((g) => asString(g)).filter(Boolean),
    conclusions: asArray(parsed.conclusions).map(coerceConclusion),
    sufficientForConclusion: Boolean(parsed.sufficientForConclusion),
    confidence: clampConfidence(parsed.confidence),
  };
  return resolveProvenance(body, knownEvidence, knownExisting);
}

module.exports = { parseAndValidateReasoningOutput, MalformedReasoningOutputError, clampConfidence };
