'use strict';

/**
 * NOT A REAL REASONING MODEL.
 *
 * A deterministic stand-in that implements the same `{ chat(messages) }`
 * shape as reasoningModelClient.js, for use where no live reasoning model
 * is configured/reachable: unit tests, and this sandbox's evaluation run
 * (see eval/README.md and the Logos v0.1 implementation report — there
 * is no live LLM credential available here, so `npm run eval:reason`
 * scores this stub, not a real model; that gap is reported explicitly,
 * not hidden).
 *
 * It applies a handful of legible, deliberately simple rules to the last
 * user message (and any supplied evidence) to produce *plausible-shaped*
 * JSON matching Logos's expected output — enough to exercise the full
 * pipeline (prompting, parsing, validation, fallback paths, evaluation
 * scoring) end-to-end without a network call. It is not a reasoning
 * engine and must never be treated as evidence that Logos "works" in
 * the way a real reasoning model's output would.
 */

function extractLatestUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') return messages[i].content || '';
  }
  return '';
}

/**
 * The stub is handed Logos's fully-assembled prompt messages (system +
 * user, per reasonPrompt.js) and pulls out the pieces it needs from the
 * user message's embedded JSON payload — it does not re-derive anything
 * Logos already computed.
 */
function parsePromptPayload(messages) {
  const userText = extractLatestUserText(messages);
  const match = userText.match(/```json\n([\s\S]*?)\n```/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch (_) {
    return null;
  }
}

function stubVerdict(evidenceText, hypothesisStatement) {
  const t = evidenceText.toLowerCase();
  const h = hypothesisStatement.toLowerCase();
  const negation = /\b(not|never|isn'?t|doesn'?t|didn'?t|no longer)\b/.test(t);
  const sharesWords = h.split(/\W+/).filter((w) => w.length > 3).some((w) => t.includes(w));

  if (!sharesWords) return { verdict: 'irrelevant', confidence: 0.6 };
  if (negation) return { verdict: 'contradicts', confidence: 0.7 };
  if (/\b(maybe|might|possibly|sometimes|unclear)\b/.test(t)) return { verdict: 'weakens', confidence: 0.55 };
  return { verdict: 'supports', confidence: 0.75 };
}

/**
 * @param {Array<{role: string, content: string}>} messages
 * @returns {Promise<string>} JSON text mimicking Logos's expected model output
 */
async function chat(messages) {
  const payload = parsePromptPayload(messages);
  const text = payload?.text || extractLatestUserText(messages);
  const evidenceList = payload?.evidence || [];

  const hasQuestionCue = /\b(why|what|how|should|would|could)\b/i.test(text) || text.includes('?');
  const hypotheses = [];

  if (evidenceList.length > 0 || /\b(maybe|might|i think|perhaps|possibly)\b/i.test(text)) {
    const statement = `The user's situation is best explained by: ${text.slice(0, 140)}`;
    const evidenceAssessments = evidenceList.map((e) => {
      const v = stubVerdict(e.content || e, statement);
      return {
        evidence: typeof e === 'string' ? e : e.content,
        verdict: v.verdict,
        confidence: v.confidence,
        reasoning: `stub: keyword overlap heuristic (verdict=${v.verdict})`,
        newConfidence: v.verdict === 'supports' ? 0.75 : v.verdict === 'contradicts' ? 0.2 : v.verdict === 'weakens' ? 0.4 : 0.5,
      };
    });
    hypotheses.push({
      statement,
      confidence: evidenceAssessments.length ? evidenceAssessments[evidenceAssessments.length - 1].newConfidence : 0.5,
      status: 'proposed',
      verificationPlan: 'Gather one more piece of direct evidence before treating this as settled.',
      evidenceAssessments,
    });
  }

  const result = {
    interpretation: hasQuestionCue
      ? `The user is asking about: ${text.slice(0, 160)}`
      : `The user is stating or requesting: ${text.slice(0, 160)}`,
    evidence: evidenceList.map((e) => ({
      content: typeof e === 'string' ? e : e.content,
      type: 'fact',
      origin: 'supplied',
    })),
    hypotheses,
    contradictions: [],
    uncertainties: evidenceList.length === 0 ? ['no supporting evidence was supplied for this turn'] : [],
    informationGaps: [
      ...(text.length < 15 ? ['the request is too short to reason about with confidence'] : []),
      ...(evidenceList.length === 0 ? ['no evidence was supplied to reason against'] : []),
    ],
    conclusions: hypotheses.length === 0
      ? [{ statement: 'No hypothesis was warranted for this turn.', basis: 'inference', confidence: 0.6 }]
      : [],
    sufficientForConclusion: evidenceList.length > 0,
    confidence: evidenceList.length > 0 ? 0.65 : 0.4,
  };

  return JSON.stringify(result);
}

module.exports = { createReasoningModelStub: () => ({ chat, isConfigured: () => true, config: { provider: 'stub' } }), createLogosModelStub: () => ({ chat, isConfigured: () => true, config: { provider: 'stub' } }) };
