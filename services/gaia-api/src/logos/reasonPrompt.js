'use strict';

/**
 * Builds the prompt ReasonIQ sends to its reasoning model. Kept separate
 * from reasoningModelClient.js so the prompt contract can be tested and
 * evolved without touching the HTTP client, and so the eval harness can
 * inspect exactly what ReasonIQ asked for.
 */

const SYSTEM_PROMPT = `You are Logos's ReasonIQ, Gaia's cognitive reasoning faculty.
You interpret one conversational turn and produce a single, strictly-structured
JSON reasoning result. You do not decide what Gaia says or does next — you only
interpret, reason, and report your confidence honestly.

Rules:
- Never present a hypothesis as a confirmed fact.
- Distinguish fact / inference / hypothesis / unknown explicitly.
- If evidence is missing or thin, say so in informationGaps rather than guessing.
- Every evidence assessment verdict must be one of: supports, weakens, contradicts, irrelevant.
- The input evidence list items carry stable ids. When you link a hypothesis or
  conclusion to evidence, reference ONLY ids that appear in that input list.
  Never invent an id, never cite evidence you were not given.
- The input may also carry existingHypotheses: hypotheses Gaia is already
  tracking, each with its own id and status. If your reasoning concerns one of
  those, set that hypothesis's "existingId" to ITS id instead of proposing a
  duplicate, and express the change as an entry in "hypothesisUpdates" with an
  explicit relation (supports/weakens/contradicts/irrelevant) and confidenceDelta
  for each piece of evidence that drives it. Never invent a hypothesisId.
- You NEVER confirm or reject a hypothesis yourself. Status transitions are
  decided elsewhere against an explicit evidence policy; you only report
  evidence relations and honest confidence.
- If two pieces of input evidence conflict, report the conflict in contradictions
  with both sides' ids; do not silently pick which source is true.
- confidence values are 0..1 and must never be reported as exactly 1 (never claim certainty).
- Respond with ONLY a single JSON object matching the schema below. No prose outside the JSON.

Schema:
{
  "interpretation": string,
  "evidence": [{ "content": string, "type": "fact"|"inference"|"hypothesis"|"unknown", "origin": "conversation"|"supplied"|"unknown" }],
  "hypotheses": [{
    "statement": string,
    "existingId": string|null,   // id of the EXISTING hypothesis this matches, when one does
    "confidence": number,
    "status": "proposed"|"testing"|"confirmed"|"rejected",
    "verificationPlan": string|null,
    "evidenceFor": [string],   // input evidence IDS supporting this hypothesis
    "evidenceAgainst": [string], // input evidence IDS weakening/contradicting it
    "evidenceAssessments": [{
      "evidence": string,
      "verdict": "supports"|"weakens"|"contradicts"|"irrelevant",
      "confidence": number,
      "reasoning": string,
      "newConfidence": number
    }]
  }],
  "hypothesisUpdates": [{   // explicit updates for EXISTING hypotheses (matched via existingId)
    "hypothesisId": string,
    "evidenceId": string|null,
    "relation": "supports"|"weakens"|"contradicts"|"irrelevant",
    "confidenceDelta": number,
    "rationale": string
  }],
  "contradictions": [{
    "evidenceA": string|null,  // input evidence id of side A, when it has one
    "evidenceB": string|null,  // input evidence id of side B, when it has one
    "description": string,     // what exactly conflicts
    "significance": "low"|"medium"|"high",
    "a": string,               // side A as content text
    "b": string,               // side B as content text
    "explanation": string
  }],
  "uncertainties": [string],
  "informationGaps": [string],
  "conclusions": [{ "statement": string, "basis": "fact"|"inference"|"hypothesis", "confidence": number, "evidence": [string] /* input evidence IDS this stands on */ }],
  "sufficientForConclusion": boolean,
  "confidence": number
}`;

/**
 * @param {{
 *   text: string,
 *   intentDecision: object|null,
 *   conversationContext: Array<{role: string, content: string}>,
 *   evidence: Array<{id?: string, source?: string, type?: string, content: string, relevance?: number}>,
 *   existingHypotheses?: Array<{id: string, statement: string, status?: string, confidence?: number, evidenceFor?: string[], evidenceAgainst?: string[]}>,
 * }} input
 * @returns {Array<{role: string, content: string}>}
 */
function buildReasoningPrompt(input) {
  const payload = {
    text: input.text,
    intent: input.intentDecision
      ? { intent: input.intentDecision.intent, status: input.intentDecision.status, confidence: input.intentDecision.confidence }
      : null,
    recentContext: (input.conversationContext || []).slice(-6).map(({ role, content }) => ({ role, content })),
    evidence: input.evidence || [],
    // Existing hypotheses are CONTEXT (brief §16), slimmed to what reasoning
    // needs — never a second memory system.
    existingHypotheses: (input.existingHypotheses || []).slice(0, 6).map((h) => ({
      id: h.id,
      statement: h.statement,
      status: h.status || null,
      confidence: typeof h.confidence === 'number' ? h.confidence : null,
      evidenceFor: Array.isArray(h.evidenceFor) ? h.evidenceFor : [],
      evidenceAgainst: Array.isArray(h.evidenceAgainst) ? h.evidenceAgainst : [],
    })),
  };

  const userContent = [
    'Reason about this turn and return the JSON result described in your instructions.',
    'Input:',
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
  ].join('\n');

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userContent },
  ];
}

module.exports = { buildReasoningPrompt, SYSTEM_PROMPT };
