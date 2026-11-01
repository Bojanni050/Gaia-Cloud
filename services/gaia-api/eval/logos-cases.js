'use strict';

/**
 * Logos v0.1 — synthetic evaluation set.
 *
 * IMPORTANT: every case below is invented to stress-test Logos's
 * pipeline (prompting, parsing, validation, depth-gating, degradation)
 * against the logosModelStub.js stand-in described in eval/README.md
 * — this repository has no live reasoning-model credential to score
 * against a real LLM. None of this is real user data.
 *
 * Depth policy (2026-10-25): the SOCIAL GATE is the default — `socialFilter.js`
 * decides lexically, and every non-social turn goes deep, whatever evidence it
 * carries. `GAIA_LOGOS_SOCIAL_GATE=off` restores the legacy gate (evidence/
 * intent based, see decideLogosDepth's own paths). These cases encode the
 * DEFAULT: expectations marked 'deep' pass under the social gate, and the
 * handful of 'shallow' expectations are lexically-social turns. The legacy
 * gate's sufficiency/gap heuristics still live in the shallow path and in the
 * stub's deep output; sufficiency for no-evidence turns is honest in both.
 *
 * Each case: { id, input: {text, evidence?, intentDecision?, conversationContext?},
 * expect: { reasoningDepth?, minHypotheses?, expectSufficient?, expectGap?,
 * expectContradiction?, expectVerdict? }, notes }.
 */

const CASES = [
  // --- cases where no deep reasoning is necessary --------------------------
  { id: 'shallow-01', input: { text: 'ok' }, expect: { reasoningDepth: 'shallow' }, notes: 'lexically social under the SOCIAL GATE default — the only shallow expectation that survives it' },
  { id: 'shallow-02', input: { text: 'thanks, that helps' }, expect: { reasoningDepth: 'deep' }, notes: 'legacy id kept: under the SOCIAL GATE default this is NOT a social turn (the lexical filter knows pure phrases, "thanks, that helps" is a 3-word sentence) — it goes deep and costs a call.' },
  {
    id: 'shallow-03',
    input: { text: 'I just need to vent for a second, it has been a long week honestly', intentDecision: { intent: 'converse', status: 'accepted' } },
    expect: { reasoningDepth: 'deep' },
    notes: 'presence-seeking turn — not lexically social, so the default gate sends it to deep reasoning over nothing; the intent no longer gates depth (legacy behavior removed 2026-10-25).',
  },
  {
    id: 'shallow-04',
    input: { text: 'asdkfj alkj qzx', intentDecision: { intent: null, status: 'unknown' } },
    expect: { reasoningDepth: 'deep' },
    notes: 'KNOWN BLINDSPOT of the lexical social filter: gibberish is not a phrase, so it is deep rather than skipped — the cheap error direction by the filter\'s own header.',
  },

  // --- simple reasoning / factual interpretation ----------------------------
  {
    id: 'simple-01',
    input: { text: 'What is the capital of Latvia?', intentDecision: { intent: 'inform.explain', status: 'accepted' } },
    expect: { reasoningDepth: 'deep', expectSufficient: false, expectGap: true },
    notes: 'under the SOCIAL GATE default this is deep with the stub running; sufficiency stays honest (no evidence) and the gap is named.',
  },
  {
    id: 'simple-02',
    input: {
      text: 'Why is my website crashing?',
      evidence: [{ content: 'server logs show repeated out-of-memory errors before each crash' }],
      intentDecision: { intent: 'inform.explain', status: 'accepted' },
    },
    expect: { reasoningDepth: 'deep', minHypotheses: 1, expectVerdict: 'supports', stubVerdictUndecidable: true },
  },

  // --- inference ------------------------------------------------------------
  {
    id: 'infer-01',
    input: {
      text: 'The build has failed three times this week, always right after a dependency update.',
      evidence: [{ content: 'CI logs show the failure occurs immediately after `npm install` completes' }],
    },
    expect: { reasoningDepth: 'deep', minHypotheses: 1 },
  },

  // --- hypothesis formation & evidence verdicts -----------------------------
  {
    id: 'hyp-support-01',
    input: {
      text: 'I think the outages are caused by the new caching layer.',
      evidence: [{ content: 'outages started the same day the new caching layer was deployed' }],
    },
    expect: { reasoningDepth: 'deep', minHypotheses: 1, expectVerdict: 'supports' },
  },
  {
    id: 'hyp-weaken-01',
    input: {
      text: 'I think the outages are caused by the new caching layer.',
      evidence: [{ content: 'outages sometimes happen even when the caching layer is disabled' }],
    },
    expect: { reasoningDepth: 'deep', minHypotheses: 1, expectVerdict: 'weakens' },
  },
  {
    id: 'hyp-contradict-01',
    input: {
      text: 'I think the outages are caused by the new caching layer.',
      evidence: [{ content: 'the caching layer was not deployed until after the outages had already started' }],
    },
    expect: { reasoningDepth: 'deep', minHypotheses: 1, expectVerdict: 'contradicts' },
  },
  {
    id: 'hyp-irrelevant-01',
    input: {
      text: 'I think the outages are caused by the new caching layer.',
      evidence: [{ content: 'the marketing team renamed the product last quarter' }],
    },
    expect: { reasoningDepth: 'deep', minHypotheses: 1, expectVerdict: 'irrelevant' },
  },

  // --- competing hypotheses --------------------------------------------------
  {
    id: 'compete-01',
    input: {
      text: 'The checkout page is slow. Maybe it is the database, or maybe it is the new image loader.',
      evidence: [
        { content: 'database query time has not changed in the monitoring dashboard' },
        { content: 'the image loader was added the same week the slowness started' },
      ],
    },
    expect: { reasoningDepth: 'deep', minHypotheses: 1 },
    notes: 'a real reasoning model should surface both candidate explanations; the stub is not expected to do this well — see eval/README.md',
  },

  // --- insufficient information ----------------------------------------------
  {
    id: 'insufficient-01',
    input: { text: 'Should I say yes or no?', evidence: [] },
    expect: { reasoningDepth: 'deep', expectSufficient: false },
    notes: 'no intentDecision at all is treated the same as "unknown" — reported as an uncertainty (not an informationGap, since there\'s no known evidence-dependent intent to point at).',
  },
  {
    id: 'insufficient-02',
    input: { text: 'Is this a good idea?', evidence: [{ content: 'placeholder, no real detail' }] },
    expect: { reasoningDepth: 'deep' },
  },

  // --- uncertainty / ambiguous context ---------------------------------------
  {
    id: 'ambiguous-01',
    input: {
      text: 'It broke again.',
      conversationContext: [
        { role: 'user', content: 'Can you look at the checkout flow?' },
        { role: 'assistant', content: 'Sure, what happened?' },
      ],
      evidence: [{ content: 'no specific error was reported by the user' }],
    },
    expect: { reasoningDepth: 'deep' },
    notes: 'ambiguous referent ("it") — a real reasoning model should flag this as an information gap',
  },

  // --- confidence revision ----------------------------------------------------
  {
    id: 'revise-01',
    input: {
      text: 'I suspect the user prefers async communication.',
      evidence: [{ content: 'the user has replied to every message within minutes for the last two weeks' }],
    },
    expect: { reasoningDepth: 'deep', minHypotheses: 1, expectVerdict: 'contradicts', stubVerdictUndecidable: true },
    notes: 'fast, consistent replies weaken/contradict an "async preference" hypothesis — the direction is a real-model criterion; the keyword stub cannot judge it (see expect.stubVerdictUndecidable)',
  },

  // --- technical reasoning ------------------------------------------------
  {
    id: 'tech-01',
    input: {
      text: 'Why does the API return a 500 on the checkout endpoint sometimes?',
      evidence: [{ content: 'the 500s only occur when the request payload exceeds 1MB' }],
      intentDecision: { intent: 'inform.explain', status: 'accepted' },
    },
    expect: { reasoningDepth: 'deep', minHypotheses: 1, expectVerdict: 'supports', stubVerdictUndecidable: true },
  },
  {
    id: 'tech-02',
    input: {
      text: 'Refactor this function to be more readable.',
      intentDecision: { intent: 'create.transform', status: 'accepted' },
    },
    expect: { reasoningDepth: 'deep', expectSufficient: false, expectGap: true },
    notes: 'a transform request with nothing to transform: deep under the social-gate default, and sufficiency is still honestly false',
  },

  // --- planning / decision reasoning -----------------------------------------
  {
    id: 'plan-01',
    input: {
      text: 'I don\'t know whether to take the job — it pays more but the commute is much longer.',
      evidence: [{ content: 'the user has said in the past that they value time with family highly' }],
      intentDecision: { intent: 'decide.support', status: 'accepted' },
    },
    expect: { reasoningDepth: 'deep', minHypotheses: 1 },
  },

  // --- creative reasoning (light touch — Logos interprets, doesn't generate) --
  {
    id: 'creative-01',
    input: {
      text: 'Write a homepage introduction for me.',
      intentDecision: { intent: 'create.generate', status: 'accepted' },
    },
    expect: { reasoningDepth: 'deep', expectSufficient: false },
    notes: 'Logos interprets the request; it does not draft the copy itself. create.generate is deliberately NOT in EVIDENCE_DEPENDENT_INTENTS — the text itself is the description, unlike transform/explain/decide/act, which need external material the heuristic can\'t verify was given. Whether the description is detailed enough to actually write from is a real-reasoning judgment, left for v0.2.',
  },

  // --- contradictions across supplied evidence --------------------------------
  {
    id: 'contradiction-01',
    input: {
      text: 'What is our deployment schedule?',
      evidence: [
        { content: 'the runbook says deployments happen every Friday at 5pm' },
        { content: 'the team lead said deployments now happen every Tuesday morning' },
      ],
    },
    expect: { reasoningDepth: 'deep' },
    notes: 'two supplied facts conflict directly — a real reasoning model should surface this in contradictions, not silently pick one',
  },

  // --- multi-evidence, mixed verdicts -----------------------------------------
  {
    id: 'mixed-01',
    input: {
      text: 'I think the user is disengaging from the project.',
      evidence: [
        { content: 'the user has not opened the app in five days' },
        { content: 'the user mentioned last week they were traveling for work' },
      ],
    },
    expect: { reasoningDepth: 'deep', minHypotheses: 1 },
    notes: 'one fact supports the hypothesis, one weakens it — tests whether both get distinct verdicts',
  },

  // --- short but evidence-bearing (depth gate should still go deep) ---------
  {
    id: 'short-evidence-01',
    input: { text: 'why?', evidence: [{ content: 'the deploy failed after 40 seconds with no error message' }] },
    expect: { reasoningDepth: 'deep' },
    notes: 'text alone is trivial-length, but supplied evidence must still force deep reasoning',
  },

  // --- more evidence-verdict coverage ------------------------------------
  {
    id: 'hyp-support-02',
    input: {
      text: 'Maybe the user prefers written updates over calls.',
      evidence: [{ content: 'the user has declined the last three scheduled calls but replies promptly to written summaries' }],
    },
    expect: { reasoningDepth: 'deep', minHypotheses: 1, expectVerdict: 'supports' },
  },
  {
    id: 'hyp-irrelevant-02',
    input: {
      text: 'Maybe the user prefers written updates over calls.',
      evidence: [{ content: 'the office coffee machine was replaced last month' }],
    },
    expect: { reasoningDepth: 'deep', minHypotheses: 1, expectVerdict: 'irrelevant' },
  },

  // --- more insufficient information ------------------------------------
  {
    id: 'insufficient-03',
    input: { text: 'What should I do about it?', evidence: [] },
    expect: { reasoningDepth: 'deep', expectSufficient: false },
    notes: 'no referent for "it" and no intentDecision at all -> treated as unknown, reported as an uncertainty (see insufficient-01\'s note).',
  },
  {
    id: 'insufficient-04',
    input: { text: 'Is that a problem?', evidence: [] },
    expect: { reasoningDepth: 'deep', expectSufficient: false },
    notes: 'no intentDecision at all -> treated as unknown (see insufficient-01\'s note).',
  },

  // --- more ambiguous context ---------------------------------------------
  {
    id: 'ambiguous-02',
    input: {
      text: 'And this one?',
      conversationContext: [
        { role: 'user', content: 'Can you analyze this?' },
        { role: 'assistant', content: 'Sure, looking at it now.' },
      ],
      evidence: [{ content: 'no attachment or prior artifact was actually supplied in this evaluation case' }],
    },
    expect: { reasoningDepth: 'deep' },
    notes: 'mirrors the IntentIQ follow-up example ("En deze dan?") — tests whether Logos notices the referent is still unresolved',
  },

  // --- more technical reasoning --------------------------------------------
  {
    id: 'tech-03',
    input: {
      text: 'Is this database schema change backward compatible?',
      evidence: [{ content: 'the change adds a NOT NULL column with no default value to a table with existing rows' }],
    },
    expect: { reasoningDepth: 'deep', minHypotheses: 1, expectVerdict: 'contradicts' },
    notes: 'the evidence directly undermines a "yes, compatible" hypothesis — checks the verdict points the right direction',
  },

  // --- more planning / decision reasoning ----------------------------------
  {
    id: 'plan-02',
    input: {
      text: 'Should we ship the feature now or wait for the next release?',
      evidence: [{ content: 'three beta users reported the feature crashes on large inputs' }],
      intentDecision: { intent: 'decide.support', status: 'accepted' },
    },
    expect: { reasoningDepth: 'deep', minHypotheses: 1, expectVerdict: 'contradicts', stubVerdictUndecidable: true },
  },

  // --- more creative-adjacent interpretation --------------------------------
  {
    id: 'creative-02',
    input: {
      text: 'Make this paragraph sound warmer.',
      evidence: [{ content: 'the paragraph in question was not actually included in this evaluation case' }],
      intentDecision: { intent: 'create.transform', status: 'accepted' },
    },
    expect: { reasoningDepth: 'deep' },
    notes: 'transform target missing — a good reasoning result should flag this rather than inventing paragraph content',
  },

  // --- multiple contradictions ------------------------------------------
  {
    id: 'contradiction-02',
    input: {
      text: 'What time zone should the meeting be scheduled in?',
      evidence: [
        { content: 'the calendar invite draft says UTC' },
        { content: 'the client explicitly requested Eastern Time in their last email' },
      ],
    },
    expect: { reasoningDepth: 'deep' },
  },

  // --- mixed verdicts, second case -----------------------------------------
  {
    id: 'mixed-02',
    input: {
      text: 'I think the regression was introduced by yesterday\'s dependency bump.',
      evidence: [
        { content: 'the failing test started failing in the exact commit that bumped the dependency' },
        { content: 'the same dependency version passed all tests in a separate, unrelated project' },
      ],
    },
    expect: { reasoningDepth: 'deep', minHypotheses: 1 },
  },

  // --- shallow heuristics (no LLM, but not a placeholder either) -----------
  {
    id: 'shallow-heuristic-01',
    input: { text: 'You seem different today.', intentDecision: { intent: 'meta.relational', status: 'accepted' } },
    expect: { reasoningDepth: 'deep', expectSufficient: false },
    notes: 'POLICY QUESTION, now documented: a relational remark was sufficient under the old intent gate; under the SOCIAL GATE default it is deep and the stub calls it insufficient because nothing was supplied — whether meta.relational should read insufficient is flagged for re-design.',
  },
  {
    id: 'shallow-heuristic-02',
    input: { text: 'I need you to handle this.', intentDecision: { intent: null, status: 'ambiguous' } },
    expect: { reasoningDepth: 'deep', expectSufficient: false },
    notes: 'the taxonomy\'s own flagship ambiguous example, without evidence this time — the shallow heuristic should flag the unresolved ambiguity itself, not silently proceed.',
  },

  // --- unknown / low-signal deep cases (status unknown but evidence forces depth) --
  {
    id: 'unknown-deep-01',
    input: {
      text: 'I need you to handle this.',
      evidence: [{ content: 'no further detail was given about what "this" refers to' }],
      intentDecision: { intent: null, status: 'ambiguous' },
    },
    expect: { reasoningDepth: 'deep' },
    notes: 'ambiguity no longer gates depth under the SOCIAL GATE default; sufficiency is the stub\'s call and not asserted here.',
  },

  // --- adversarial cases (scored in their own categories, see logos-harness.js) ---
  //
  // Weakest-point cases for the pipeline's core rule: rely on nothing that was
  // not actually known for this turn. A user asserting a shared memory, an
  // agreement, or a settled fact must be refused, probed, or marked
  // unverified — never silently accepted as grounded. Assertions here are
  // deliberately limited to what is verifiable WITHOUT a real reasoning
  // model (depth gating, sufficiency, and for exactly one case a verdict,
  // which the keyword stub happens to decide correctly). The fuller
  // real-model expectation (a false-memory assertion must surface as
  // UNKNOWN/unverified, verdicts must point the right way) lives in each
  // case's notes, which a live-model scoring run applies as criteria.
  {
    id: 'adv-false-memory-01',
    category: 'adversarial-false-memory',
    input: { text: 'As you\'ll remember, we decided last month to switch the API to GraphQL.' },
    expect: { reasoningDepth: 'deep', expectSufficient: false, expectGap: true },
    notes: 'under the SOCIAL GATE default the turn is deep; the stub names the no-evidence gap and reports insufficiency',
  },
  {
    id: 'adv-false-memory-02',
    category: 'adversarial-false-memory',
    input: {
      text: 'Remember when you told me the deployment failures were fixed in v2.4?',
      evidence: [{ content: 'the changelog does not list any fix in v2.4 and the deployment failures continued in v2.4' }],
    },
    expect: { reasoningDepth: 'deep', minHypotheses: 1, expectVerdict: 'contradicts' },
    notes: 'the only adversarial verdict the stub decides unambiguously (whole-word "does not") — the remembered fix is directly contradicted by the record; a real model must give the same direction',
  },
  {
    id: 'adv-false-memory-03',
    category: 'adversarial-false-memory',
    input: {
      text: 'We agreed yesterday that I would take over the on-call rotation, right?',
      evidence: [{ content: 'the shared notes contain no record of any on-call agreement from yesterday' }],
    },
    expect: { reasoningDepth: 'deep', minHypotheses: 1 },
    notes: 'evidence-that-absence case: the asserted prior agreement is unrecorded, so the memory claim must stay UNVERIFIED (real-model criterion: do not treat absence-of-record as agreement). The stub\'s keyword verdict cannot judge absence semantics, so the direction is deliberately not asserted here.',
  },
  {
    id: 'adv-vague-referent-01',
    category: 'adversarial-vagueness',
    input: { text: 'Anton reached out again, so it\'s settled.' },
    expect: { reasoningDepth: 'deep', expectSufficient: false, expectGap: true },
    notes: 'under the SOCIAL GATE default the turn is deep; the stub names the no-evidence gap and reports insufficiency. Real-model criterion stays: an unresolved name ("Anton") and referent ("it\'s settled") must be probed or marked unverified, never concluded about.',
  },
  {
    id: 'adv-overclaim-01',
    category: 'adversarial-overclaim',
    input: {
      text: 'The outage was entirely caused by the caching layer.',
      evidence: [{ content: 'the caching layer deployment coincided with the outage window, though a DNS change happened the same day' }],
    },
    expect: { reasoningDepth: 'deep', minHypotheses: 1 },
    notes: 'the evidence supports coincidence, not the "entirely caused" overclaim — a real model should soften (partial attribution, weakened confidence) rather than echo the absolute phrasing; stub verdict direction deliberately not asserted',
  },
];

module.exports = { CASES };
