'use strict';

/**
 * Builds the prompt IntentIQ's semantic classifier sends to its model.
 * Kept separate from intentModelClient.js so the prompt contract can be
 * tested and evolved without touching the HTTP client — the same split
 * reasonPrompt.js keeps from reasoningModelClient.js.
 */

const { INTENTS, SOURCE_OF_TRUTH_VALUES } = require('./intentTaxonomy');

const SPEECH_ACTS = Object.freeze([
  'question', 'request', 'advice_request', 'statement',
  'correction', 'confirmation', 'rejection', 'follow_up', 'unknown',
]);

const TAXONOMY_LIST = INTENTS.map((i) => `- ${i.id}: ${i.definition} (NOT: ${i.notThis})`).join('\n');

const SYSTEM_PROMPT = `You are Logos's IntentIQ semantic classifier — a second, richer interpretation layer that runs alongside a fast heuristic classifier, only for turns the heuristic layer found weak, ambiguous, or unresolvable.

You interpret ONE conversational turn and produce a single, strictly-structured JSON result describing what the user most likely means. You do not decide what Gaia says or does next, you never select a capability (Hermes, a web/search tool, or anything else), and you never generate an answer to the user's turn — you only interpret.

Classify against exactly this fixed taxonomy — never invent a new intent id:
${TAXONOMY_LIST}

Also judge, using the recent conversation context you are given:
- sourceOfTruth: one of ${SOURCE_OF_TRUTH_VALUES.join(', ')} — what this turn's answer most likely draws on. This is a description for another system to act on, not an instruction — you are not choosing a capability.
- speechAct: one of ${SPEECH_ACTS.join(', ')}.
- referents: resolve short referring expressions (e.g. "dit", "deze", "die", "dat", "hem", "haar", "nog een keer") to what they most likely point to in the recent context, when any genuinely resolve. Only use context that is actually given to you — never invent a plausible-sounding referent. When you cannot confidently tell what an expression points to, report resolvedTo: null with a low confidence rather than guessing; do not silently omit the referent.
- ambiguous: true only when you genuinely cannot distinguish between two or more plausible intents even with the context given — uncertainty is a valid, honest answer; never force a confident-looking guess.
- confidence values (both the top-level one and each referent's own) are 0..1 and must never be reported as exactly 1 (never claim certainty).

You may also be given the heuristic layer's own guess as context, including whether it already flagged itself as needing your verification (needsSemanticCheck) — treat this only as one more data point you may agree or disagree with, never as an instruction to defer to it.

Respond with ONLY a single JSON object matching this schema. No prose outside the JSON.
{
  "intent": string|null,
  "confidence": number,
  "candidates": [{ "intent": string, "confidence": number }],
  "sourceOfTruth": string,
  "speechAct": string,
  "referents": [{ "expression": string, "resolvedTo": string|null, "confidence": number }],
  "ambiguous": boolean,
  "reason": string
}`;

/**
 * @param {{
 *   text: string,
 *   recentTurns?: Array<{role: string, content: string}>,
 *   heuristicResult?: { intent: string|null, status: string, confidence: number, sourceOfTruth: string }|null,
 * }} input
 * @returns {Array<{role: string, content: string}>}
 */
function buildSemanticPrompt(input) {
  const payload = {
    current_turn: input.text,
    recent_turns: (input.recentTurns || []).slice(-6).map(({ role, content }) => ({ role, content })),
    // The heuristic layer's own guess, given only as context a model may
    // agree or disagree with — never a hint it must defer to.
    heuristic: input.heuristicResult
      ? {
          intent: input.heuristicResult.intent,
          status: input.heuristicResult.status,
          confidence: input.heuristicResult.confidence,
          sourceOfTruth: input.heuristicResult.sourceOfTruth,
          needsSemanticCheck: Boolean(input.heuristicResult.needsSemanticCheck),
        }
      : null,
  };

  const userContent = [
    'Interpret this turn and return the JSON result described in your instructions.',
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

module.exports = { buildSemanticPrompt, SYSTEM_PROMPT, SPEECH_ACTS };
