'use strict';

/**
 * Logos.IntentIQ 2.0 — "what is the user trying to achieve?"
 *
 * Boundary (architecture.md §4.2 — Logos is Gaia's cognitive layer; Hermes
 * is a standalone capability Gaia may task, never a home for IntentIQ).
 * IntentIQ interprets a turn and hands back an IntentDecision. It never chooses a
 * model or provider, never calls Hermes or any other capability, never
 * writes memory, never generates the final response, and never makes
 * Gaia's agency decision. This module has no dependency on hermesClient.js
 * or hindsightClient.js, and returns nothing shaped like a capability
 * routing hint — that boundary is asserted directly in
 * test/intentIQ.test.js, not just described here.
 *
 * Two interpretation tiers, cascaded:
 *
 *   1. Heuristic (classify(), unchanged from v0.1) — deterministic,
 *      synchronous, free. Trivial/empty input -> unknown immediately;
 *      bilingual (EN/NL) pattern-cue scoring per intent; follow-up
 *      inheritance for signal-free continuations ("En deze dan?");
 *      naive compound-turn detection ("draft it and send it").
 *   2. Semantic (classifySemantic() + interpret(), new in 2.0) — a real,
 *      independently-configured model call, tried only when the heuristic
 *      tier did NOT produce a confident ("accepted") match. See this
 *      module's own cost posture below.
 *
 * `classify()` still returns exactly what it always has — the same
 * synchronous, model-free function, unit-testable and callable with zero
 * config. `interpret()` is the new, richer, async entry point (what
 * turn.js now calls): it runs classify() first, and only escalates to
 * classifySemantic() when the heuristic result is weak, ambiguous, or
 * unknown. The two results are merged by combineConsensus() — agreement
 * raises confidence, disagreement is reported honestly as `ambiguous:
 * true` rather than silently picking one (soul.md: "she never pretends
 * certainty"). A strong heuristic match never triggers a semantic call,
 * so semantic classification adds no latency/cost to the common case.
 *
 * IntentIQ 2.0 still only interprets. `sourceOfTruth` describes what a
 * turn's answer likely draws on ("this looks like it needs current
 * external information") — it is never a routing instruction ("therefore
 * call the web tool"), and neither classify() nor interpret() ever
 * imports or references Hermes, the web tool, the Decision Engine, or the
 * Orchestrator (asserted directly in tests, not just described here).
 *
 * IntentIQ 2.2 adds calibration on top of the same two tiers, without a
 * third tier, a new agent, or an extra arbitration model call:
 *
 *   - A heuristic match is no longer trusted just for being the sole
 *     candidate. Each signal pattern is tagged strong (a specific phrase or
 *     anchored regex) or weak (a bare single-word cue, via boundary());
 *     a single weak-only match, an overlapping-but-resolved multi-candidate
 *     match, or a context-inherited match all set `needsSemanticCheck:
 *     true` on an otherwise-`accepted` heuristic decision, and interpret()
 *     escalates to the semantic tier on that flag exactly as it already
 *     does for `status !== 'accepted'`. A confident-looking but wrong
 *     regex match no longer silently skips verification.
 *   - `rawScore` (the underlying raw signal — a heuristic hit count, or a
 *     model's own self-reported number) is now reported alongside
 *     `confidence` (the calibrated belief after arbitration/capping) —
 *     they are not the same number.
 *   - `confidenceLevel` ('high'|'medium'|'low', via a fixed threshold
 *     policy) and `interpretationStatus`
 *     ('resolved'|'uncertain'|'ambiguous'|'insufficient_context') make the
 *     decision's own honesty about itself explicit, without inventing a
 *     new `status` value — `status` keeps its original three values for
 *     backward compatibility; `interpretationStatus` is the richer,
 *     additive read of the same decision.
 *   - `recordOutcome()` (intentFeedback.js) is a structured, durable
 *     feedback seam for later analysis (threshold tuning, example
 *     collection) — never online training, never a mutation of a past
 *     IntentDecision, never a persistent per-user profile (that boundary
 *     stays Hindsight's).
 *
 * IntentIQ 2.3 adds NO new classification behavior — the two tiers, the
 * consensus rules, and every threshold are exactly as 2.2 left them. What
 * it adds is observability: each heuristic pattern now carries a stable
 * name, and a direct-signal decision reports which named signals fired
 * (`meta.matchedSignals`), so the offline feedback analyzer can attribute
 * misclassifications to specific heuristics. Analysis lives in
 * intentFeedbackAnalyzer.js (pure functions) and eval/evaluationRunner.js
 * (offline only) — nothing here reads feedback back or tunes itself at
 * runtime.
 *
 * IntentIQ 2.4 is targeted refinement driven by the measured 2.3 findings,
 * not a redesign: (a) bare interrogative turns ("why?", "waarom dan?")
 * resolve against conversation context instead of keyword-riding to a
 * context-free intent; (b) an accepted match whose only support is a weak
 * cue can no longer report high confidence (the two measured overconfident
 * traps: draft, schedule) while keeping status + needsSemanticCheck;
 * (c) three measured signal gaps got narrow, structurally-framed signals:
 * inverted explanation order ("Leg uit hoe..."), personhood questions
 * ("Ben je een echt persoon?"), and clause-final cause-seeking (", why?").
 * No taxonomy change, no new tier, no threshold tuning beyond that cap.
 */

const crypto = require('crypto');
const { INTENT_IDS, isKnownIntent, TAXONOMY_VERSION } = require('./intentTaxonomy');
const { logIntentDecision } = require('./intentLog');
const { buildSemanticPrompt } = require('./intentSemanticPrompt');
const { parseAndValidateSemanticOutput, MalformedSemanticOutputError } = require('./intentSemanticValidate');
const { createFromEnv: createIntentModelFromEnv } = require('./intentModelClient');

const SCHEMA_VERSION = 'intentiq.v1';
// heuristic-v0.4: declarative status updates resolve as accepted converse
// without a semantic check — a user statement about their own actions can
// no longer be bounced into clarification by the consensus tier.
const CLASSIFIER_VERSION = 'heuristic-v0.4';
const SEMANTIC_CLASSIFIER_VERSION = 'semantic-v2.0';

// --- tiny local text helpers (deliberately not shared with memoryPolicy.js
// — "is this trivial for the purpose of recall/reflection" and "is this
// trivial for the purpose of recognizing presence-seeking" are different
// judgments that happen to look similar, per the taxonomy report's
// `converse` card). -----------------------------------------------------

const FILLER = new Set([
  'ok', 'okay', 'k', 'kk', 'sure', 'yes', 'yep', 'yup', 'no', 'nope',
  'thanks', 'thank you', 'thx', 'ty', 'cool', 'nice', 'great', 'got it',
  'gotcha', 'lol', 'haha', 'hi', 'hello', 'hey', 'bye', 'ja', 'nee', 'oke',
  'oki', 'top', 'prima', 'goed', 'dank je', 'dankje', 'bedankt',
]);

function normalize(text) {
  return String(text || '').trim().toLowerCase().replace(/[.!?,]+$/g, '');
}

function isEmptyOrFiller(text) {
  const n = normalize(text);
  return !n || FILLER.has(n);
}

// A bare single-word cue is a generic, higher false-positive-risk match —
// tagged `.weak` at construction time so scoring can tell "one bare keyword
// fired" apart from "a specific, multi-word phrase or anchored pattern
// fired" without a second hand-maintained list. phrase() and any regex
// written out by hand (multi-word or anchored) are strong by construction.
function boundary(word) {
  const re = new RegExp(`\\b${word}\\b`, 'i');
  re.weak = true;
  return re;
}

function phrase(words) {
  return new RegExp(words.trim().replace(/\s+/g, '\\s+'), 'i');
}

// Anaphora / continuation cues — used only to decide whether a signal-free
// turn is a follow-up worth inheriting context for, never scored as an
// intent on their own. heuristic-v0.3 adds the Dutch pronominal adverbs
// ("daar", "daarmee", ...) — deictic references to what was just said,
// including what GAIA just said, exactly like the pronouns beside them.
const CONTINUATION_SIGNALS = [
  boundary('this'), boundary('that'), boundary('these'), boundary('those'),
  boundary('it'), boundary('dit'), boundary('deze'), boundary('dat'), boundary('die'),
  boundary('daar'), boundary('daarmee'), boundary('hier'), boundary('hiermee'),
  boundary('ermee'), boundary('eraan'),
  phrase('and (this|that|these)'), phrase('en (deze|dat|die)'),
];

// --- per-intent signal sets (EN/NL) -------------------------------------
// Deliberately small and legible. Replace or extend per-intent as real
// usage surfaces gaps — do not silently fold a miss into a neighboring
// intent's list just to make one example pass.

const SIGNALS = {
  'converse': [
    phrase('just (want|wanted) to (talk|say|vent)'), boundary('vent'),
    phrase("not (really )?looking for advice"), phrase('just checking'),
    phrase('gewoon (even )?praten'), phrase('ik wil het er over hebben'),
    // A bare greeting (optionally with a short name, "Hoi Gaia") is
    // presence-seeking, not an information request — without this, "Hoi
    // Gaia" scored zero signal anywhere and fell through to "unknown",
    // which (for IntentIQ 2.0's cascade) would trigger a needless semantic
    // classifier call for the single most common turn shape there is.
    // Deliberately anchored to the whole message so it does not also fire
    // on "Hello, why is my site down?" (still correctly inform.explain).
    /^(hi|hey|hello|hoi|hallo|goedemorgen|goedemiddag|goedenavond)\b(\s+\w{2,15})?[!.]*$/i,
  ],
  'inform.explain': [
    phrase('why (is|does|did|are|isn\'?t)'), phrase("what('|i)?s the"),
    phrase('what is'), phrase('how (does|do|did)'), boundary('explain'),
    phrase('tell me about'), phrase('what happened'), phrase("what'?s wrong with"),
    boundary('analyze'), boundary('analyse'),
    phrase('waarom'), phrase('wat is'), phrase('hoe werkt'), phrase('leg .* uit'),
    // ('uitleggen' moved from a weak boundary cue to the strong
    // /\buitleggen\b/ match below in 2.4 — kept as one signal, not two,
    // so its weight per turn is unchanged from the classifier's view.)
    boundary('analyseer'), boundary('analyseren'),
    // "Look/search for a [thing]" delegated-lookup phrasing — deliberately
    // scoped to an indefinite article/determiner near the look/search verb
    // ("look into a provider", "kijk eens naar een aanbieder"), not a bare
    // "kijk naar"/"look at", which would also match "look at this code" /
    // "kijk naar mijn tekst" (reviewing something already at hand, not a
    // lookup). Added after a real incident: "Je mag wel even kijken naar
    // een Nederlandse text-to-speech aanbieder" resolved sourceOfTruth
    // "unknown" and fell through to native generation, which then
    // hallucinated tool-call syntax trying to "search" on its own (see
    // docs/evolution.md's SOUL amendment for the other half of that fix).
    /\b(kijk|zoek|check|look)\w*\b.{0,30}\b(een|an?)\b/i,
    // IntentIQ 2.4 (from the 2.3 evaluation): the imperative-explanation
    // frame in its inverted word order. The existing 'leg .* uit' only
    // covers "leg X uit"; "Leg uit hoe DNS werkt" scored zero signal.
    // Word-bounded so "beleg uitslagen"-style substrings can't fire it,
    // and a strong (specific-frame) match by construction.
    /\bleg\s+uit\b/i,
    // Same finding, second half: the bare-word 'uitleggen' boundary cue is
    // weak by construction, which left "Kun je uitleggen hoe X werkt?"
    // stuck at capped weak-cue confidence. A specific Dutch explanation
    // infinitive is real evidence — promoted to an explicit strong match
    // (same posture as create.transform's own conjugation literals).
    /\buitleggen\b/i,
    // A declarative clause closed by a bare ", why?" / ", waarom?" is a
    // cause-seeking request about that clause ("Write protection is
    // enabled on the drive, why?") — explanation, anchored to the
    // comma+end so it cannot fire on a why-question mid-sentence. A turn
    // consisting ONLY of such a token never reaches this signal — see
    // isBareInterrogativeFollowUp below; context decides there, not here.
    /,\s*(?:why|waarom)\s*\??\s*$/i,
    // Explicit research/retrieval requests directed AT Gaia — sentence-
    // initial imperatives ("Zoek uit hoe …", "Zoek dit even voor me op.",
    // "Onderzoek wat de huidige API hiervoor is.") and "kun je (uit|op)zoek*/
    // onderzoek*" requests. Anchored to the sentence start / request frame so
    // a first-person mention of the same verbs ("ik zoek het zelf wel uit",
    // "ik ga onderzoeken waarom dit gebeurt") can never fire them: those
    // shapes are claimed upstream by the self-directed investigation branch
    // as USER statements, never requests to Gaia. Requiring the separable
    // particle (uit/op) or the research verb keeps plain "Zoek de
    // verschillen"-style comparison asks out of the retrieval frame.
    /^\s*(?:even\s+|nu\s+|eens\s+|eens\s+even\s+)?zoek\w*\b[\s\S]{0,40}\b(?:uit|op)\b/i,
    /^\s*(?:even\s+|nu\s+|eens\s+)?onderzoek\w*\b/i,
    // "kun je <research verb>" requests — vetoed when the actual requested
    // action is HELPING ("kun jij me helpen dit uit te zoeken?" is a help/
    // decide ask, not a retrieval request), so the search verb must be the
    // requested action itself.
    /\bkun(?:nen)?\s+(?:je|jij|u)\b(?![\s\S]{0,40}\bhelp(?:t|en)?\b)[\s\S]{0,40}\b(?:uit|op)?zoek\w*\b/i,
    /\bkun(?:nen)?\s+(?:je|jij|u)\b(?![\s\S]{0,40}\bhelp(?:t|en)?\b)[\s\S]{0,40}\bonderzoek\w*\b/i,
  ],
  'create.generate': [
    phrase('write (a|an|me|us)'), boundary('draft'), boundary('compose'),
    boundary('generate'), phrase('come up with'), phrase('create a'),
    phrase('schrijf (een|me)'), phrase('stel .* op'), boundary('bedenk'),
    phrase('maak een'),
  ],
  'create.transform': [
    boundary('rewrite'), boundary('shorten'), boundary('improve'), boundary('refactor'),
    phrase('fix (this|the|it)'), boundary('translate'),
    /\bmake (it|this|the)\b.{0,25}\b(more|sound|warmer|shorter|clearer|softer|formal|casual|better)\b/i,
    phrase('clean up'), phrase('edit (this|it|the)'),
    // Dutch conjugations, not whole-word matches — "herschrijf" alone
    // missed the infinitive "herschrijven" ("Kun je dit herschrijven?"
    // scored zero signal anywhere, a real gap found during live
    // validation). A plain \w* stem wildcard doesn't fix "herschrijf" or
    // "vertaal": Dutch's open/closed-syllable spelling alternation changes
    // the stem's own last letter(s) in the infinitive (herschrijf -> herschrijV-en;
    // vertaAAl -> vertAAl loses a vowel -> vertal-en) — matched as
    // explicit alternations instead. "verbeter" has no such alternation
    // (verbeter-en), so \w* alone already covers it.
    /\b(herschrijf|herschrijft|herschrijven)\b/i,
    /\bverbeter\w*\b/i,
    /\b(vertaal|vertaalt|vertaald|vertalen)\b/i,
    /\bmaak (dit|het)\b.{0,25}\b(korter|warmer|duidelijker)\b/i, phrase('pas .* aan'),
  ],
  'decide.support': [
    phrase('should i'), phrase('what would you do'), phrase("don'?t know whether"),
    phrase('talk me out of'), phrase('what am i missing'), phrase('help me decide'),
    phrase('which (one|option)'),
    phrase('zou ik'), phrase('wat zou jij doen'), phrase('ik weet niet of'),
    phrase('help me kiezen'),
    // "What do you think I should do with this" phrasing — distinct from
    // "wat zou jij doen" (hypothetical, about Gaia) in that it asks Gaia's
    // opinion on the user's own next move. Added after a concrete gap: this
    // exact Dutch phrasing scored zero signal anywhere.
    phrase('wat (denk je|vind je) dat ik'), phrase('what do you think i should'),
    // "which choice" — distinct from "which (one|option)" above; added for
    // IntentIQ 2.2's needs_semantic_check test coverage, where it
    // deliberately creates a genuine two-way overlap with inform.explain's
    // "leg .* uit" on the same turn ("Leg uit welke keuze ik volgens jou
    // moet maken.") rather than a signal-free miss.
    phrase('welke keuze'),
  ],
  'memory.inspect': [
    phrase('what (have you|do you) (noticed|know|remember)'),
    phrase('why do you think that'), phrase('what do you understand about me'),
    phrase('wat weet je (over|van) mij'), phrase('wat heb je gemerkt'),
    // "What do you still know/remember about my [preferences/etc]" — the
    // "nog" (still) plus a possessive noun phrase ("mijn voorkeuren") after
    // "van/over" wasn't covered by the "van mij" pattern above, which
    // requires the bare pronoun immediately after van/over.
    phrase('wat weet je nog (van|over)'),
  ],
  'memory.correct': [
    phrase('forget (what|that|this)'), phrase("that'?s not right"),
    phrase('delete (everything|what) you know'), phrase('i actually (prefer|meant)'),
    phrase('vergeet (wat|dat)'), phrase('dat klopt niet'),
    phrase('verwijder wat je weet'),
  ],
  'act.perform': [
    boundary('send'), phrase('add .* to (my )?calendar'), phrase('turn (on|off)'),
    phrase('post (this|that|it)'), boundary('schedule'), phrase('remind me'),
    phrase('set a reminder'),
    boundary('stuur'), phrase('zet .* in (mijn )?agenda'), phrase('plan (het|dit)'),
    phrase('herinner me'),
  ],
  'meta.relational': [
    phrase('who are you'), phrase('are you (a person|human|real)'),
    phrase('do you (remember|actually) me'), phrase('you seem'),
    phrase("i'?m sorry"), phrase('do you get tired'),
    phrase('wie ben je'), phrase('ben je (een mens|echt)'), phrase('het spijt me'),
    // IntentIQ 2.4 (2.3 evaluation: "Ben je een echt persoon?" scored
    // zero): the personhood question frame, structural rather than a
    // keyword list — an anchored "ben je/jij" plus optional
    // articles/intensifiers and a personhood head noun; "ben jij echt"
    // only at clause end ("Ben jij echt van plan?" stays clear); and the
    // "praat ik met een (echte) persoon" variant. Deliberately NOT keyed
    // on bare 'persoon'/'mens'/'echt' — "Is dit echt een probleem?" and
    // "een tekst over een persoon" must never land here.
    /\bben\s+(?:je|jij)\s+(?:(?:een\s+|'n\s+)?(?:(?:echt|werkelijk)e?\s+)?)+(?:mens|persoon|robot|machine)\b/i,
    /\bben\s+(?:je|jij)\s+(?:echt|werkelijk)[\s?!.]*$/i,
    /\bpraat\s+ik\s+met\s+(?:een\s+)?(?:(?:echt|werkelijk)e?\s+)?(?:mens|persoon)\b/i,
  ],
  'meta.question': [
    // Questions about Gaia's own behavior, previous response, or reasoning.
    // These are NOT new information requests — the target is Gaia's own action.
    phrase('waarom (koos je|deed je|zei je|vraag je|antwoord je|gebruikte je)'),
    phrase('why (did you|chose you|said you|asked you|answered you|used you)'),
    phrase('hoe (kwam je|bedacht je|interpreteerde je)'),
    phrase('how (did you come|did you interpret|did you decide)'),
    phrase('wat (deed je|zei je|bedoelde je)'),
    phrase('what (did you do|did you say|did you mean)'),
    phrase('welke (tool|capability|keuze) gebruikte je'),
    phrase('which (tool|capability|choice) did you use'),
    phrase('waarom (heb je|was dat)'),
    phrase('why (did you|was that)'),
    phrase('leg (je|dit) uit'), phrase('explain (this|that|yourself)'),
    phrase('wat was je reden'), phrase('what was your reason'),
    phrase('hoe(zo| come)'), phrase('how come'),
  ],
  'meta.correction': [
    // Signals that Gaia misunderstood or gave a wrong response.
    // These correct the conversational state, not new information requests.
    phrase('nee,? ik bedoel'), phrase('no,? i mean'),
    phrase('dat is niet wat ik (vroeg|bedoelde)'),
    phrase("that'?s not what i (asked|meant)"),
    phrase('je zit (verkeerd|ernaast)'),
    phrase('you (got it wrong|are wrong|misunderstood)'),
    phrase('kijk naar mijn vorige bericht'),
    phrase('look at my (previous|last) (message|question)'),
    phrase('nee,? kijk'), phrase('no,? look'),
    phrase('dat was niet (bedoeld|wat ik wilde)'),
    phrase("that wasn'?t (what i meant|the point)"),
    phrase('je begrijpt me (verkeerd|niet)'),
    phrase('you (misunderstood|don\'?t understand) me'),
    phrase('nee,? dat klopt niet'),
    phrase('no,? that\'?s not right'),
    phrase('dat is fout'), phrase('that is wrong'),
    phrase('je antwoord is (verkeerd|niet goed)'),
    phrase('your answer is (wrong|not right)'),
  ],
  'meta.capability_question': [
    // Questions about why Gaia used a specific capability — not requesting it again.
    phrase('waarom koos je (voor|om)'),
    phrase('why did you (choose|use|pick)'),
    phrase('waarom gebruikte je'),
    phrase('why did you use'),
    phrase('waarom riep je'),
    phrase('why did you call'),
    phrase('welke tool gebruikte je'),
    phrase('which tool did you use'),
    phrase('wat deed je (met|daarmee)'),
    phrase('what did you (do with|use that for)'),
    phrase('hoe(zo| come) (koos je|gebruikte je|deed je)'),
    phrase('how come (did you|chose you|use)'),
    phrase('leg uit waarom je'),
    phrase('explain why you'),
  ],
};

for (const id of Object.keys(SIGNALS)) {
  if (!isKnownIntent(id)) {
    throw new Error(`intentIQ signal set references unknown taxonomy intent: ${id}`);
  }
}

/**
 * IntentIQ 2.3 telemetry: every signal pattern carries a stable, readable
 * name (derived from its own regex source — `\bdraft\b`, `why\s+(is|does…)`)
 * so offline analysis can attribute misclassifications to *specific*
 * heuristics ("which rule fails most?") instead of only counting raw hits.
 * Purely metadata on the RegExp objects, exactly like the existing `.weak`
 * tag — no scoring or classification logic reads it.
 */
function normalizeSignalName(re) {
  return re.source.replace(/\\b/g, '').replace(/\\s\+/g, ' ').replace(/\\\./g, '.');
}

for (const id of Object.keys(SIGNALS)) {
  for (const p of SIGNALS[id]) {
    if (!p.signalName) p.signalName = `${id}:${normalizeSignalName(p)}`;
  }
}

/** Source-of-truth cue sets — a separate judgment from intent (principles.md — Source First). */
const SOURCE_SIGNALS = {
  memory: [
    boundary('remember'), boundary('recall'), phrase('you said'), phrase('i told you'),
    phrase('last time'), phrase('previously'), phrase('what do you know about'),
    phrase('weet je nog'), phrase('je zei'), phrase('eerder'), boundary('vorige'),
  ],
  tool: SIGNALS['act.perform'],
};

// --- scoring --------------------------------------------------------------

function scoreText(text, patterns) {
  return patterns.reduce((n, p) => n + (p.test(text) ? 1 : 0), 0);
}

/**
 * Like scoreText, but also tracks whether at least one *strong* (non-weak)
 * pattern matched — a single bare-keyword hit and a specific-phrase hit
 * both score `raw: 1`, but only the second is safe to trust without
 * verification (see computeNeedsSemanticCheck, below) — and, for 2.3
 * telemetry, the names of the patterns that actually fired.
 * @returns {{ raw: number, hasStrongMatch: boolean, matched: string[] }}
 */
function scoreIntentSignals(text, patterns) {
  let raw = 0;
  let hasStrongMatch = false;
  const matched = [];
  for (const p of patterns) {
    if (p.test(text)) {
      raw += 1;
      if (!p.weak) hasStrongMatch = true;
      if (p.signalName) matched.push(p.signalName);
    }
  }
  return { raw, hasStrongMatch, matched };
}

/** @returns {Array<{intent: string, raw: number, hasStrongMatch: boolean, matched: string[]}>} sorted desc, zero scores excluded */
function scoreAllIntents(text) {
  const scored = INTENT_IDS
    .filter((id) => SIGNALS[id])
    .map((id) => {
      const { raw, hasStrongMatch, matched } = scoreIntentSignals(text, SIGNALS[id]);
      return { intent: id, raw, hasStrongMatch, matched };
    })
    .filter((s) => s.raw > 0);
  scored.sort((a, b) => b.raw - a.raw);
  return scored;
}

/**
 * IntentIQ 2.3 telemetry: which named signals fired, per intent, bounded —
 * enough to attribute a later-corrected decision back to the heuristic(s)
 * that produced it, never an unbounded dump. Attached to
 * `decision.meta.matchedSignals` on the direct-signal path only; purely
 * additive metadata nothing downstream branches on.
 */
const MAX_MATCHED_SIGNALS = 5;

function collectMatchedSignals(scored) {
  const out = [];
  for (const s of scored) {
    for (const signal of s.matched || []) {
      if (out.length >= MAX_MATCHED_SIGNALS) return out;
      out.push({ intent: s.intent, signal });
    }
  }
  return out;
}

function toNormalizedCandidates(scored) {
  const total = scored.reduce((sum, s) => sum + s.raw, 0);
  if (total === 0) return [];
  return scored.map((s) => ({ intent: s.intent, score: Math.round((s.raw / total) * 100) / 100 }));
}

function looksLikeContinuation(text) {
  const words = normalize(text).split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 8) return false;
  return CONTINUATION_SIGNALS.some((p) => p.test(text));
}

// --- IntentIQ 2.4: bare interrogative follow-ups ("why?", "waarom dan?") ---
//
// A turn consisting ONLY of an interrogative token has no standalone
// intent: "why?" after a decision question asks for reasoning about the
// decision; after an explanation it probes the explanation. The 2.3 live
// check exposed the asymmetry — bare "Waarom?" was keyword-scored to a
// confident inform.explain with NO context (phrase('waarom') matches any
// occurrence), while bare "why?" fell straight through to unknown. Both
// now route through context first: inherit the nearest resolvable prior
// turn's intent, or report honest insufficient_context. Deliberately a
// tight token list and a whole-turn shape — "Waarom werkt dit zo?" is a
// real question with its own signals and never enters this branch.

const INTERROGATIVE_HEADS = new Set(['why', 'waarom', 'hoezo', 'wrm']);
const INTERROGATIVE_MODIFIERS = new Set([
  'why', 'waarom', 'hoezo', 'wrm',
  'exactly', 'precies', 'dan', 'eigenlijk', 'not', 'niet', 'so', 'then',
]);

function isBareInterrogativeFollowUp(text) {
  const words = normalize(text).replace(/[?!.]+$/g, '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 3) return false;
  if (!INTERROGATIVE_HEADS.has(words[0])) return false;
  return words.every((w) => INTERROGATIVE_MODIFIERS.has(w));
}

// --- heuristic-v0.4: declarative status updates -----------------------------
//
// A first-person statement about something the user just DID ("ik heb de
// capability toegevoegd maar kennelijk werkt het nog niet") is a report, not
// a request. Such turns carry no request-shaped signal, so the heuristic
// tier reports unknown — and when a semantic classifier is configured, the
// consensus tier then gets a second opinion on an un-opinionated turn, which
// can come back "ambiguous" and bounce a plain status update into a
// clarification loop. That was a real production failure mode.
//
// The frame below is deliberately TIGHT: first person, past-tense completion
// verb, and NEVER a question. When it matches, the speech act is already
// clear (statement → converse), so the decision is accepted WITHOUT a
// semantic check — a second opinion on "is this a statement?" is exactly
// the ambiguity factory this branch exists to close.

const STATUS_UPDATE_VERBS = /(?:toegevoegd|toegevoeg|erbij gezet|geüpdatet|geupdate|bijgewerkt|aangepast|veranderd|gebouwd|gemaakt|ingeschakeld|uitgeschakeld|verwijderd|neergezet|geschreven)/i;

function isDeclarativeStatusUpdate(text) {
  const raw = String(text || '');
  if (raw.includes('?')) return false; // questions are never status reports
  const t = normalize(raw);
  if (!t) return false;
  const nlFrame = new RegExp(`^ik heb\\b[\\s\\S]{0,100}${STATUS_UPDATE_VERBS.source}`, 'i').test(t);
  const enFrame = /^i (?:just |also |finally )?(?:added|updated|built|implemented|shipped|enabled|removed|wrote)\b/i.test(t)
    || /^(?:added|updated|built|implemented|shipped)\b/i.test(t);
  return Boolean(nlFrame || enFrame);
}

// --- compound conversational turns ---------------------------------------
// A social opener is filler only when it is the whole turn. If it is followed
// by a meaningful social question, the second clause determines the intent.
const SOCIAL_OPENER = /^(?:dank(?:\s*je(?:\s+wel)?)?|bedankt|goedemorgen|goedemiddag|goedenavond|hoi|hallo|fijn je weer te spreken)$/i;
const CONVERSATIONAL_QUESTION = /^(?:hoe gaat het|hoe is het|how are you|how is it)\??$/i;

function splitConversationalCompound(text) {
  const clauses = String(text || '').split(/(?:[.!?]+|,)/).map((c) => c.trim()).filter(Boolean);
  if (clauses.length !== 2) return null;
  const opener = clauses[0].replace(/[.!?]+$/g, '').trim();
  const question = clauses[1].replace(/[.!?]+$/g, '').trim();
  if (!SOCIAL_OPENER.test(opener) || !CONVERSATIONAL_QUESTION.test(question)) return null;
  return { opener, question };
}

function conversationalCompoundDecision(text) {
  if (!splitConversationalCompound(text)) return null;
  return {
    schemaVersion: SCHEMA_VERSION,
    intent: 'converse',
    status: 'accepted',
    confidence: capConfidence(0.95),
    candidates: [{ intent: 'converse', score: 1 }],
    entities: extractEntities(text),
    sourceOfTruth: 'conversation',
    needsClarification: false,
    rawScore: 1,
    needsSemanticCheck: false,
    speechAct: 'question',
    meta: {
      taxonomyVersion: TAXONOMY_VERSION,
      classifierVersion: CLASSIFIER_VERSION,
      reason: 'acknowledgement_or_greeting_plus_conversational_question',
    },
  };
}

// --- self-directed investigation statements ---------------------------------
//
// "Ik ga nu even uitzoeken waarom jij traag reageert." is a STATEMENT about
// the user's own next action: the embedded "waarom"-clause is the OBJECT of
// the user's own investigation, not a request to Gaia. Scoring such a turn on
// the bare 'waarom' cue resolved it as inform.explain + sourceOfTruth
// "external_knowledge", which pushed a personal remark into the web-search
// branch — a measured false positive. The structural rule below is the
// mirror of the assistant-directed request: FIRST-PERSON SUBJECT +
// INTENTION/INVESTIGATION VERB, and never an assistant-directed marker.
// Imperatives ("Zoek uit waarom…") and explicit requests ("Kun je opzoeken…",
// "Onderzoek dit voor me") carry no first-person intention frame and keep
// their existing routing untouched.
const SELF_INVESTIGATION_FRAMES = [
  // NL: "ik ga [nu/even/zelf/… ] … (uit|op)zoek*/onderzoek*/kijk*"
  /\bik\s+ga\b[\s\S]{0,60}\b(?:uit|op)?zoek\w*\b/i,
  /\bik\s+ga\b[\s\S]{0,60}\bonderzoek\w*\b/i,
  /\bik\s+ga\b[\s\S]{0,60}\bkijk\w*\b/i,
  // NL: "ik zoek/zoekt [het|dit|wel|even|…] … uit"
  /\bik\s+zoe(?:k|kt)\b[\s\S]{0,40}\buit\b/i,
  // NL: "ik zal … (uit|op)zoek*/onderzoek*"
  /\bik\s+zal\b[\s\S]{0,60}\b(?:uit|op)?zoek\w*\b/i,
  /\bik\s+zal\b[\s\S]{0,60}\bonderzoek\w*\b/i,
  // EN mirrors: "I('ll) / I('m) going to … look/find/dig/check/investigate/research"
  /\bi(?:\s*'ll|\s+will|\s*'m\s+going\s+to|\s+am\s+going\s+to|\s+gonna)\b[\s\S]{0,40}\b(?:look|find|dig|check|investigate|research)\w*\b/i,
];

/**
 * Assistant-directed request markers — when one is present the action is
 * being asked OF Gaia, so the turn can never be a self-directed statement,
 * whatever else it contains ("Kun je opzoeken…", "Onderzoek dit voor me").
 */
const ASSISTANT_REQUEST_MARKERS = [
  /\bkun(?:nen)?\s+(?:je|jij|u)\b/i,
  /\bwil(?:len)?\s+(?:je|jij|u)\b/i,
  /\bzou\s+(?:je|jij|u)\b/i,
  /\bvoor\s+(?:me|mij)\b/i,
  /\bcan\s+you\b/i,
  /\bcould\s+you\b/i,
  /\bwill\s+you\b/i,
  /\bwould\s+you\b/i,
  /\bfor\s+me\b/i,
];

/**
 * True when the turn is a first-person statement of the user's OWN
 * investigation intention ("ik ga … uitzoeken", "I'm going to look into…")
 * rather than a request directed at Gaia. Structural: subject + intention
 * verb frames, vetoed by assistant-directed markers. Never fires on bare
 * imperatives (no first-person subject) — those keep their existing routing.
 * @param {string} text
 * @returns {boolean}
 */
function isSelfDirectedInvestigation(text) {
  const t = String(text || '');
  if (!t.trim()) return false;
  if (ASSISTANT_REQUEST_MARKERS.some((m) => m.test(t))) return false;
  return SELF_INVESTIGATION_FRAMES.some((f) => f.test(t));
}

/**
 * The accepted-converse decision for a self-directed investigation statement.
 * Same posture as the declarative status update branch: the speech act is
 * certain by construction (statement about one's own next action), so the
 * decision is accepted WITHOUT a semantic check — a second opinion would
 * only re-open the false external_knowledge routing this branch closes.
 * @param {string} text
 */
function selfDirectedInvestigationDecision(text) {
  return {
    schemaVersion: SCHEMA_VERSION,
    intent: 'converse',
    status: 'accepted',
    confidence: capConfidence(0.7),
    candidates: [{ intent: 'converse', score: 0.7 }],
    entities: extractEntities(text),
    sourceOfTruth: 'conversation',
    needsClarification: false,
    rawScore: 1,
    needsSemanticCheck: false,
    speechAct: 'statement',
    meta: {
      taxonomyVersion: TAXONOMY_VERSION,
      classifierVersion: CLASSIFIER_VERSION,
      reason: 'self_directed_investigation_statement',
    },
  };
}

// --- creative artifact requests ---------------------------------------------
//
// "Wat is een goede songtekst om te zingen?" asks for something to be
// PRODUCED; the generic 'wat is' cue alone resolved it as a concept-
// explanation request (inform.explain @0.95 → sourceOfTruth
// external_knowledge → the Decision Engine's web branch) — a measured false
// positive. The frames below read the OBJECT of the question/wish — a
// generative artifact noun, optionally with a purpose clause — not the bare
// cue. "Wat is Hindsight?", "Wat is de hoofdstad van Frankrijk?" and "Wat is
// een goede uitleg van Hindsight?" carry no artifact object and keep their
// existing inform.explain routing untouched.
//
// PRECEDENCE (documented, enforced by the cascade): a creative-artifact
// frame outranks the generic explain cues ('wat is', 'hoe werkt') because
// the task meaning — produce an artifact — beats a bare lexical cue. The
// branch sits AFTER compound detection so a genuine multi-intent turn
// ("Schrijf een liedje en zoek uit hoe …") keeps its ambiguous semantics.
const GENERATIVE_ARTIFACT = String.raw`(?:songtekst\w*|gedicht\w*|titel\w*|naam\w*|verhaal\w*|slogan\w*|hook\w*|melodie\w*|refrein\w*|couplet\w*|jingle\w*|bio\b|biografie\w*|captions?\b|lyrics?\b|teksten?\b)`;

const CREATIVE_ARTIFACT_FRAMES = [
  // Question with an artifact object: "wat is een (goede|…) <artifact>"
  new RegExp(String.raw`(?:wat|welk\w*)\s+is\s+(?:een|'n)\s+(?:(?:goede?|korte?|leuke?|mooie?|sterke?|lekkere?|pakkende?|bijzondere?|goede)\s+)?(?:` + GENERATIVE_ARTIFACT + `)`, 'i'),
  // First-person wish: "ik wil (een|een korte|…) <artifact>"
  new RegExp(String.raw`\bik\s+wil\b[\s\S]{0,60}(?:` + GENERATIVE_ARTIFACT + `)`, 'i'),
  // Reformulation ask: "een goede manier om dit te formuleren/zeggen/…"
  /\b(?:goede?|betere?)\s+manier\s+om\b[\s\S]{0,50}\bte\s+(?:formuleren|zeggen|schrijven|vertellen|brengen|verwoorden|omschrijven)\b/i,
  // Generation-verb request: "kun je … schrijven/dichten/componeren"
  /\bkun(?:nen)?\s+(?:je|jij|u)\b[\s\S]{0,60}\b(?:schrij\w*|dichten|componeren)\b/i,
  // EN mirrors of the two main shapes
  /(?:what|which)\s+is\s+an?\s+(?:(?:good|short|nice|catchy|strong)\s+)?(?:lyrics?|titles?|names?|poems?|stor(?:y|ies)|slogans?|hooks?|melod(?:y|ies)|captions?)/i,
  /\bi\s+(?:want|need)\b[\s\S]{0,60}\b(?:lyrics?|titles?|names?|poems?|stor(?:y|ies)|slogans?|hooks?|melod(?:y|ies)|captions?)/i,
];

/**
 * A first-person wish to KNOW something ("ik wil weten wat een songtekst
 * is") reads as explanation, never generation — vetoed before the artifact
 * frames can fire on the shared noun.
 */
const CREATIVE_WISH_VETOES = [
  /\bik\s+wil\s+(?:graag\s+|echt\s+)?(?:weten|begrijpen|snappen|zien)\b/i,
  /\bi\s+want\s+to\s+(?:know|understand|see)\b/i,
];

/**
 * True when the turn's object is a generative artifact — a question, wish or
 * request whose answer is something Gaia should PRODUCE (a lyric, a title, a
 * formulation) rather than a concept to explain. Structural: artifact-noun
 * frames with an explicit know-veto; no bare-cue routing.
 * @param {string} text
 * @returns {boolean}
 */
function isCreativeArtifactRequest(text) {
  const t = String(text || '');
  if (!t.trim()) return false;
  if (CREATIVE_WISH_VETOES.some((v) => v.test(t))) return false;
  return CREATIVE_ARTIFACT_FRAMES.some((f) => f.test(t));
}

/**
 * The accepted create.generate decision for a creative-artifact request.
 * sourceOfTruth 'conversation': the artifact is produced in-conversation —
 * resolveSourceOfTruth's inform.explain → external_knowledge rule can never
 * apply, because the intent is create.generate, not inform.explain.
 * @param {string} text
 */
function creativeArtifactRequestDecision(text) {
  return {
    schemaVersion: SCHEMA_VERSION,
    intent: 'create.generate',
    status: 'accepted',
    confidence: capConfidence(0.8),
    candidates: [{ intent: 'create.generate', score: 0.8 }],
    entities: extractEntities(text),
    sourceOfTruth: 'conversation',
    needsClarification: false,
    rawScore: 1,
    needsSemanticCheck: false,
    speechAct: 'request',
    meta: {
      taxonomyVersion: TAXONOMY_VERSION,
      classifierVersion: CLASSIFIER_VERSION,
      reason: 'creative_artifact_request',
    },
  };
}



/**
 * Naive compound-turn split on a top-level "and"/"en" — only trusted when
 * both halves independently carry a non-empty signal for a *different*
 * top intent. This deliberately does not try to parse real syntax.
 */
function detectCompoundIntents(text) {
  const parts = text.split(/\b(?:and|en)\b/i).map((p) => p.trim()).filter((p) => p.split(/\s+/).length >= 2);
  if (parts.length < 2) return null;
  const perPart = parts.map((p) => scoreAllIntents(p)[0]).filter(Boolean);
  if (perPart.length < 2) return null;
  const distinct = new Set(perPart.map((p) => p.intent));
  if (distinct.size < 2) return null;
  return perPart.map((p) => ({ intent: p.intent, raw: p.raw }));
}

// --- entities (deliberately minimal — see module comment) -----------------

/**
 * Lightweight, replaceable entity extraction. Not NER: pulls quoted spans
 * and an explicit recipient after "to/aan/voor <Name>". Anything more
 * (dates, real names in running text, document references) is out of
 * scope for v0.1 and should not be faked here.
 * @param {string} text
 */
function extractEntities(text) {
  const entities = [];
  const quoteRe = /"([^"]{1,80})"/g;
  let m;
  while ((m = quoteRe.exec(text))) {
    entities.push({ type: 'quoted_text', value: m[1] });
  }
  const recipientRe = /\b(?:to|aan|voor)\s+([A-Z][a-zA-Z]{1,30})\b/;
  const rm = recipientRe.exec(text);
  if (rm) entities.push({ type: 'recipient', value: rm[1] });
  return entities;
}

// --- source of truth --------------------------------------------------

/**
 * @param {string} text
 * @param {{ hasAttachment?: boolean, isContinuation?: boolean }} ctx
 * @returns {'conversation'|'memory'|'upload'|'external_knowledge'|'tool'|'unknown'}
 */
function resolveSourceOfTruth(text, ctx, resolvedIntent) {
  if (ctx.hasAttachment) return 'upload';
  if (scoreText(text, SOURCE_SIGNALS.memory) > 0) return 'memory';
  if (resolvedIntent === 'act.perform') return 'tool';
  if (ctx.isContinuation) return 'conversation';
  if (resolvedIntent === 'inform.explain') return 'external_knowledge';
  if (resolvedIntent) return 'conversation';
  return 'unknown';
}

// --- ambiguity threshold ------------------------------------------------

const AMBIGUITY_SHARE_THRESHOLD = 0.6; // top candidate must hold >=60% of signal weight
const AMBIGUITY_RAW_MARGIN = 1; // or lead the runner-up by more than this many raw matches
// Semantic-tier ambiguity reconciliation: a model-reported `ambiguous: true`
// flag is overridden by candidate-margin evidence — the interpretation is
// accepted when the top semantic candidate leads the runner-up by MORE than
// this many confidence points. A margin at or below this is a genuine tie; a
// margin above it is a clear winner. Kept in sync with intentCalibrationConfig
// RUNTIME_CONSTANTS.ambiguityConfidenceMargin.
const AMBIGUITY_CONFIDENCE_MARGIN = 0.05;
const MAX_CONFIDENCE = 0.95; // soul.md: "she never pretends certainty" — never report 1.0
// IntentIQ 2.4, from the 2.3 calibration findings: when an accepted match's
// ONLY support is a bare weak cue ("draft" the NBA kind of hit), the raw
// 1/1 normalization would report ~0.95 — measured overconfident (both live
// traps were wrong at that confidence). Such decisions keep status/nsc but
// may not claim high confidence; semantic verification is their designed path.
const WEAK_SIGNAL_CONFIDENCE_CAP = 0.7;

function capConfidence(value) {
  return Math.min(value, MAX_CONFIDENCE);
}

function decideStatus(candidates, rawScored) {
  if (candidates.length === 0) return 'unknown';
  if (candidates.length === 1) return 'accepted';
  const [top, second] = rawScored;
  const shareOk = candidates[0].score >= AMBIGUITY_SHARE_THRESHOLD;
  const marginOk = (top.raw - second.raw) > AMBIGUITY_RAW_MARGIN;
  return (shareOk || marginOk) ? 'accepted' : 'ambiguous';
}

// --- IntentIQ 2.2: "safe to trust" and calibration -------------------------
//
// A heuristic decision reaching `status: 'accepted'` is not automatically
// safe to skip semantic verification for — see the module comment. This is
// deliberately a separate, additive judgment from decideStatus() above,
// not a rewrite of it: `status` keeps meaning exactly what it always has
// (a real regression concern — see test/intentIQ.test.js's schema-shape
// test, which still only allows the original three status values).

/**
 * @param {{ candidates: Array<{intent: string, score: number}>, rawScored: Array<{raw: number, hasStrongMatch: boolean}> }} args
 * @returns {boolean}
 */
function computeNeedsSemanticCheck({ candidates, rawScored }) {
  // More than one intent matched at all, even though one dominated by
  // share/margin — "strong but overlapping signals" from the brief.
  if (candidates.length > 1) return true;
  // The sole candidate's only support is a bare, generic keyword — a
  // confident-looking count that is still a weak, false-positive-prone
  // match (e.g. "draft" firing create.generate inside "the NBA draft").
  const top = rawScored[0];
  return !(top && top.hasStrongMatch);
}

const CONFIDENCE_LEVEL_HIGH = 0.85;
const CONFIDENCE_LEVEL_MEDIUM = 0.6;

/** @returns {'high'|'medium'|'low'} */
function confidenceLevelFor(confidence) {
  if (confidence >= CONFIDENCE_LEVEL_HIGH) return 'high';
  if (confidence >= CONFIDENCE_LEVEL_MEDIUM) return 'medium';
  return 'low';
}

/**
 * The richer, additive read of a decision's own honesty about itself.
 * Never changes `status` or drives any behavior downstream of IntentIQ —
 * purely a clearer label for the same judgment `status`/`confidence`/
 * `candidates` already encode.
 * @returns {'resolved'|'uncertain'|'ambiguous'|'insufficient_context'}
 */
function interpretationStatusFor(decision) {
  if (decision.status === 'ambiguous') return 'ambiguous';
  if (decision.status === 'unknown') {
    return decision.candidates.length === 0 ? 'insufficient_context' : 'uncertain';
  }
  // accepted
  return decision.confidenceLevel === 'low' ? 'uncertain' : 'resolved';
}

// --- public API ------------------------------------------------------------

/**
 * @typedef {Object} IntentDecision
 * @property {'intentiq.v1'} schemaVersion
 * @property {string|null} intent
 * @property {'accepted'|'ambiguous'|'unknown'} status
 * @property {number} confidence
 * @property {Array<{intent: string, score: number}>} candidates
 * @property {Array<{type: string, value: string}>} entities
 * @property {'conversation'|'memory'|'upload'|'external_knowledge'|'tool'|'unknown'} sourceOfTruth
 * @property {boolean} needsClarification
 * @property {{ taxonomyVersion: string, classifierVersion: string }} meta
 * @property {boolean} ambiguous
 * @property {string|null} speechAct
 * @property {Array<{expression: string, resolvedTo: string|null, confidence: number, source: string|null}>} referents
 * @property {number} rawScore the raw, uncalibrated signal magnitude behind `confidence` (a heuristic hit count, or a semantic model's own self-reported number) — never the same number as `confidence` once arbitration/capping has run
 * @property {boolean} needsSemanticCheck true only on a heuristic-tier decision that resolved `status: 'accepted'` but is not yet safe to trust without semantic verification; always false once a final (post-consensus) decision has actually been through that verification
 * @property {'high'|'medium'|'low'} confidenceLevel
 * @property {'resolved'|'uncertain'|'ambiguous'|'insufficient_context'} interpretationStatus
 */

/** @returns {IntentDecision} */
function emptyDecision(reason) {
  return {
    schemaVersion: SCHEMA_VERSION,
    intent: null,
    status: 'unknown',
    confidence: 0,
    candidates: [],
    entities: [],
    sourceOfTruth: 'unknown',
    needsClarification: false,
    rawScore: 0,
    needsSemanticCheck: false,
    meta: { taxonomyVersion: TAXONOMY_VERSION, classifierVersion: CLASSIFIER_VERSION, reason },
  };
}

/**
 * Same shape as emptyDecision, but for the "there is real text, it just
 * doesn't match any intent signal" case — sourceOfTruth and entities are
 * independent judgments from intent (principles.md — Source First) and
 * must still be attempted even when no intent resolves. Without this, a
 * message like "Remember what I told you about the database?" would
 * report sourceOfTruth "unknown" just because its *intent* is unclear,
 * which is a different, unjustified kind of uncertainty.
 * @returns {IntentDecision}
 */
function unknownWithSourceAttempt(text, options, reason) {
  return {
    schemaVersion: SCHEMA_VERSION,
    intent: null,
    status: 'unknown',
    confidence: 0,
    candidates: [],
    entities: extractEntities(text),
    sourceOfTruth: resolveSourceOfTruth(text, { hasAttachment: options.hasAttachment }, null),
    needsClarification: false,
    rawScore: 0,
    needsSemanticCheck: false,
    meta: { taxonomyVersion: TAXONOMY_VERSION, classifierVersion: CLASSIFIER_VERSION, reason },
  };
}

function latestUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i] && messages[i].role === 'user') return messages[i].content || '';
  }
  return '';
}

/**
 * Inspects conversation context to detect meta-intents — where the user is
 * referring to Gaia's own behavior, previous response, or capability choice
 * rather than making a new standalone request.
 *
 * Returns the detected meta-intent type, or null if no meta-context is found.
 * This is a context-layer judgment, separate from keyword scoring — it
 * answers "is the user talking about Gaia's own actions?" not "what words
 * did they use?"
 *
 * v2.2 spec §1-2: conversational context has priority over capability intents.
 *
 * PATCH 1-3: Model-native vision handling
 * - Image availability is determined from actual model input, not user statements
 * - Vision is a model-native capability, not an external tool
 * - Don't route image understanding through websearch/Hindsight/Hermes
 *
 * @param {Array<{role: string, content: string}>} messages
 * @param {{ hasImage?: boolean, imageAvailable?: boolean }} [inputContext] - actual model input context
 * @returns {{ type: string, target: string, contextReference: string }|null}
 */
function detectMetaIntent(messages, inputContext = {}) {
  if (!Array.isArray(messages) || messages.length < 2) return null;

  const lastUserIdx = messages.length - 1;
  // Find the last user message
  let currentUserIdx = lastUserIdx;
  while (currentUserIdx >= 0 && messages[currentUserIdx].role !== 'user') {
    currentUserIdx -= 1;
  }
  if (currentUserIdx < 0) return null;

  const currentUser = messages[currentUserIdx].content || '';
  const normalizedUser = normalize(currentUser);

  // Find the previous assistant message (before the current user turn)
  let prevAssistantIdx = currentUserIdx - 1;
  while (prevAssistantIdx >= 0 && messages[prevAssistantIdx].role !== 'assistant') {
    prevAssistantIdx -= 1;
  }
  if (prevAssistantIdx < 0) return null;

  const prevAssistant = messages[prevAssistantIdx].content || '';

  // PATCH 3: Check if user is asking about image availability
  // "Kun je de foto zien?" / "Can you see the photo?" / "Zie je de afbeelding?"
  const asksAboutImageVisibility = /(?:kun\s+je|can\s+you)\s+(?:de\s+)?(?:foto|afbeelding|image|photo|plaatje)\s+(?:zien|see|bekijken|look\s+at)/i.test(currentUser)
    || /(?:zie\s+je|do\s+you\s+see)\s+(?:de\s+)?(?:foto|afbeelding|image|photo)/i.test(currentUser)
    || /(?:kun\s+je|can\s+you)\s+(?:deze|this)\s+(?:foto|afbeelding|image|photo)\s+(?:zien|see)/i.test(currentUser);

  if (asksAboutImageVisibility) {
    // PATCH 2: Determine availability from ACTUAL MODEL INPUT, not user statements
    if (inputContext.hasImage === true && inputContext.imageAvailable === true) {
      // Image is available - model can inspect it natively
      return null; // Let native vision handle it
    } else if (inputContext.hasImage === true && inputContext.imageAvailable === false) {
      // Image was provided but is unavailable to the model
      return {
        type: 'meta.question',
        target: 'image_availability',
        contextReference: 'model_input',
      };
    } else {
      // Image availability unknown - don't claim visibility either way
      return {
        type: 'meta.question',
        target: 'image_availability',
        contextReference: 'model_input',
      };
    }
  }

  // PATCH 4: Check if user is asking why Gaia used/didn't use a capability
  // This includes questions about why image was/wasn't analyzed
  const asksAboutCapabilityUse = (/(?:waarom|why)\s+(?:koos|gebruikte|riep|heb\s+je|did\s+you)\s+(?:je|did\s+you)/i.test(currentUser)
      || /(?:waarom|why)\s+did\s+you\s+(?:choose|chose|use|pick|call)/i.test(currentUser)
      || /(?:waarom|why)\s+(?:heb\s+je|did\s+you)\s+.{0,30}(?:niet|not)\s+(?:gekeken|bekeken|looked\s+at|viewed|analyzed|bekijken)/i.test(currentUser)
      || /(?:waarom|why)\s+(?:heb\s+je|did\s+you)\s+(?:deze|this|de|the)\s+(?:foto|afbeelding|image|photo)\s+(?:niet|not)/i.test(currentUser)
      || /(?:waarom|why)\s+(?:heb\s+je|did\s+you)\s+(?:deze|this|de|the)\s+(?:foto|afbeelding|image|photo)\s+(?:niet|not)\s+(?:gezien|seen|bekeken|analyzed)/i.test(currentUser))
    && /(?:tool|websearch|hindsight|hermes|capability|web|foto|afbeelding|image|photo)/i.test(currentUser);

  if (asksAboutCapabilityUse) {
    return {
      type: 'meta.capability_question',
      target: 'capability_choice',
      contextReference: 'previous_action',
    };
  }

  // Check if user is asking about Gaia's previous response/reasoning
  // "Waarom deed je dat?" / "Why did you do that?" — refers to prev assistant action
  const refersToGaiaAction = /(?:waarom|why)\s+(?:koos|deed|zei|vraag|antwoord|gebruik|riep)\s+(?:je|did\s+you|chose|use)/i.test(currentUser)
    || /(?:hoe|how)\s+(?:kwam|bedacht|interpreteerde|come|decide|interpret)/i.test(currentUser)
    || /(?:wat|what)\s+(?:deed|zei|bedoelde|did|say|mean)/i.test(currentUser);

  // Check if user is correcting Gaia's interpretation
  const isCorrection = /(?:nee|no)[,!]?\s+(?:ik\s+bedoel|i\s+mean)/i.test(currentUser)
    || /(?:dat\s+is\s+niet|that'?s\s+not)\s+(?:wat|what)/i.test(currentUser)
    || /(?:je\s+zit|you\s+(?:got|are))\s+(?:verkeerd|wrong)/i.test(currentUser)
    || /(?:begrijpt|understand)\s+(?:me\s+verkeerd|me\s+wrong)/i.test(currentUser)
    || /(?:nee|no)[,!]?\s+(?:kijk|look)/i.test(currentUser)
    || /(?:dat\s+klopt|that'?s\s+not\s+right)/i.test(currentUser);

  // PATCH 5: Check if user is asking about a capability choice
  // The mere presence of a capability name must never trigger that capability
  const asksAboutCapability = (/(?:waarom|why)\s+(?:koos|gebruikte|riep)\s+(?:je|did\s+you)/i.test(currentUser)
      || /(?:waarom|why)\s+did\s+you\s+(?:choose|chose|use|pick|call)/i.test(currentUser))
    && /(?:tool|websearch|hindsight|hermes|capability|web)/i.test(currentUser);

  if (isCorrection) {
    return {
      type: 'meta.correction',
      target: 'previous_response',
      contextReference: 'conversation',
    };
  }

  if (asksAboutCapability) {
    return {
      type: 'meta.capability_question',
      target: 'capability_choice',
      contextReference: 'previous_action',
    };
  }

  if (refersToGaiaAction) {
    return {
      type: 'meta.question',
      target: 'previous_response',
      contextReference: 'conversation',
    };
  }

  return null;
}

function priorUserTexts(messages, excludeLastUser, windowSize = 3) {
  const users = (messages || []).filter((m) => m && m.role === 'user').map((m) => m.content || '');
  const withoutLast = excludeLastUser ? users.slice(0, -1) : users;
  return withoutLast.slice(-windowSize).reverse(); // most recent first
}

/**
 * Classifies the intent of the latest user turn in `messages`, using
 * recent conversation history only to resolve short, context-dependent
 * follow-ups ("En deze dan?"). This is conversation *context*, not
 * source-of-truth — those are deliberately different fields (see the
 * design report's Phase 5).
 *
 * Never calls Hermes, never touches Hindsight, never returns a capability
 * or provider hint. Pure function of its inputs plus a side-effecting log
 * line (see options.logger / options.silent).
 *
 * PATCH 1-3: Model-native vision handling
 * - Image availability is determined from actual model input context
 * - Vision is a model-native capability, not an external tool
 *
 * @param {Array<{role: string, content: string}>} messages full turn history, ending in the latest user message
 * @param {{
 *   correlationId?: string,
 *   contextId?: string,
 *   hasAttachment?: boolean,
 *   hasImage?: boolean,
 *   imageAvailable?: boolean,
 *   silent?: boolean,
 *   logger?: (line: string) => void,
 * }} [options]
 * @returns {IntentDecision}
 */
function classify(messages, options = {}) {
  const correlationId = options.correlationId || crypto.randomUUID();
  const text = latestUserText(Array.isArray(messages) ? messages : []);

  let decision;

  if (isEmptyOrFiller(text)) {
    decision = emptyDecision('empty_or_filler_input');
  } else {
    // v2.2 spec §1-2: conversational context has priority.
    // Detect meta-intents (user referring to Gaia's own behavior) BEFORE
    // keyword scoring — these are not new standalone requests.
    // PATCH 2: Pass actual model input context for image availability detection
    const inputContext = {
      hasImage: options.hasImage,
      imageAvailable: options.imageAvailable,
    };
    const metaContext = detectMetaIntent(Array.isArray(messages) ? messages : [], inputContext);

    if (metaContext) {
      // Meta-intent detected from conversation context — this takes priority
      // over keyword-based scoring per v2.2 spec §2 (meta-intent priority).
      decision = {
        schemaVersion: SCHEMA_VERSION,
        intent: metaContext.type,
        status: 'accepted',
        confidence: capConfidence(0.85),
        candidates: [{ intent: metaContext.type, score: 0.85 }],
        entities: extractEntities(text),
        sourceOfTruth: 'conversation',
        needsClarification: false,
        rawScore: 1,
        needsSemanticCheck: false,
        meta: {
          taxonomyVersion: TAXONOMY_VERSION,
          classifierVersion: CLASSIFIER_VERSION,
          reason: 'context_meta_intent_detected',
          contextReference: metaContext.contextReference,
          target: metaContext.target,
        },
      };
    } else {
      // heuristic-v0.4: a declarative first-person status update ("ik heb de
      // capability toegevoegd, maar het werkt nog niet") is a STATEMENT, not
      // a request. Resolving it here — accepted, no semantic check — keeps
      // the consensus tier from bouncing plain reports into clarification.
      if (isDeclarativeStatusUpdate(text)) {
        decision = {
          schemaVersion: SCHEMA_VERSION,
          intent: 'converse',
          status: 'accepted',
          confidence: capConfidence(0.7),
          candidates: [{ intent: 'converse', score: 0.7 }],
          entities: extractEntities(text),
          sourceOfTruth: 'conversation',
          needsClarification: false,
          rawScore: 1,
          // The speech act is certain by construction; a second opinion on
          // "is this a statement?" is the ambiguity factory this branch
          // closes. Deliberately false.
          needsSemanticCheck: false,
          meta: {
            taxonomyVersion: TAXONOMY_VERSION,
            classifierVersion: CLASSIFIER_VERSION,
            reason: 'declarative_status_update',
          },
        };
      } else if (isSelfDirectedInvestigation(text)) {
        // Same declarative-statement posture, for the user's own stated
        // intention to investigate something themselves: the embedded
        // "waarom/wat"-clause is the OBJECT of their own action, never a
        // request to Gaia. Resolving it here — accepted converse, no
        // semantic check — keeps the bare 'waarom' cue from routing a
        // personal remark into external_knowledge/web.
        decision = selfDirectedInvestigationDecision(text);
      } else if (isBareInterrogativeFollowUp(text)) {
        // IntentIQ 2.4: a bare interrogative turn ("why?", "waarom dan?")
        // has no standalone intent — resolve it against conversation
        // context BEFORE any keyword scoring, so a bare "Waarom?" can no
        // longer ride phrase('waarom') to a context-free confident
        // inform.explain. With a resolvable prior turn it inherits (still
        // needsSemanticCheck); without one it is honest insufficient_context.
        decision = resolveByInheritance(text, messages, options, {
          inheritedReason: 'bare_interrogative_inherited',
          unresolvedReason: 'bare_interrogative_without_resolvable_context',
        });
      } else {
        const conversationalCompound = conversationalCompoundDecision(text);
        const compound = detectCompoundIntents(text);
        const creativeArtifact = isCreativeArtifactRequest(text);
        const directScored = scoreAllIntents(text);

        if (conversationalCompound) {
          decision = conversationalCompound;
        } else if (compound) {
          const candidates = toNormalizedCandidates(compound);
          decision = {
            schemaVersion: SCHEMA_VERSION,
            intent: compound[0].intent,
            status: 'ambiguous',
            confidence: candidates[0] ? capConfidence(candidates[0].score) : 0,
            candidates,
            entities: extractEntities(text),
            sourceOfTruth: resolveSourceOfTruth(text, { hasAttachment: options.hasAttachment }, compound[0].intent),
            needsClarification: true,
            rawScore: compound[0].raw,
            needsSemanticCheck: true,
            meta: {
              taxonomyVersion: TAXONOMY_VERSION,
              classifierVersion: CLASSIFIER_VERSION,
              reason: 'compound_turn_detected',
            },
          };
        } else if (creativeArtifact) {
          // PRECEDENCE: the artifact object beats the generic 'wat is' cue.
          // A question whose answer is something to PRODUCE is a generation
          // request, never a concept explanation — the bare lexical cue
          // loses to the turn's task meaning (see the frames' own comment).
          decision = creativeArtifactRequestDecision(text);
        } else if (directScored.length > 0) {
          const candidates = toNormalizedCandidates(directScored);
          const status = decideStatus(candidates, directScored);
          const top = candidates[0];
          // IntentIQ 2.4 calibration fix: an accepted decision whose only
          // support is weak cue(s) may not report high confidence — see
          // WEAK_SIGNAL_CONFIDENCE_CAP and the 2.3 findings behind it.
          const weakOnlyAccepted = status === 'accepted' && !directScored[0].hasStrongMatch;
          const acceptedConfidence = status === 'accepted'
            ? (weakOnlyAccepted ? Math.min(capConfidence(top.score), WEAK_SIGNAL_CONFIDENCE_CAP) : capConfidence(top.score))
            : 0;
          decision = {
            schemaVersion: SCHEMA_VERSION,
            intent: status === 'accepted' ? top.intent : null,
            status,
            confidence: acceptedConfidence,
            candidates,
            entities: extractEntities(text),
            sourceOfTruth: resolveSourceOfTruth(
              text,
              { hasAttachment: options.hasAttachment },
              status === 'accepted' ? top.intent : null
            ),
            needsClarification: status !== 'accepted',
            rawScore: directScored[0].raw,
            needsSemanticCheck: status === 'accepted'
              ? computeNeedsSemanticCheck({ candidates, rawScored: directScored })
              : false,
            meta: {
              taxonomyVersion: TAXONOMY_VERSION,
              classifierVersion: CLASSIFIER_VERSION,
              reason: 'direct_signal',
              // IntentIQ 2.3 telemetry only — which named heuristics fired for
              // this decision. Nothing downstream reads this.
              matchedSignals: collectMatchedSignals(directScored),
            },
          };
        } else {
          // heuristic-v0.3: before declaring a signal-free turn context-free,
          // check whether it reuses a content term from Gaia's own previous
          // response — an assistant-originated follow-up ("...context rond
          // juni..." → "wat was er in juni ook alweer?"). Null without such
          // an anchor; the classic paths below stay authoritative then.
          const anchored = resolveAssistantAnchoredFollowUp(text, messages, options);
          if (anchored) {
            decision = anchored;
          } else if (looksLikeContinuation(text)) {
            decision = resolveByInheritance(text, messages, options);
            attachAssistantReferents(decision, text, messages);
          } else {
            decision = unknownWithSourceAttempt(text, options, 'no_signal_matched');
          }
        }
      }
    }
  }

  // Additive IntentIQ 2.0 fields, defaulted uniformly here regardless of
  // which cascade branch produced `decision` above — the heuristic tier
  // alone never computed speechAct (that needs real semantic
  // interpretation, not keyword matching), and `ambiguous` is simply a
  // named alias of the existing `status === 'ambiguous'` judgment so
  // callers don't have to know that encoding. Since heuristic-v0.3 the
  // assistant-anchored path DOES populate referents heuristically; the
  // bare-interrogative and pronominal paths record deictic provenance via
  // attachAssistantReferents. combineConsensus() (used by interpret(),
  // below) overwrites these when a semantic result actually ran.
  decision.ambiguous = decision.status === 'ambiguous';
  decision.speechAct = decision.speechAct || null;
  decision.referents = decision.referents || [];
  attachAssistantReferents(decision, text, messages);
  decision.needsSemanticCheck = Boolean(decision.needsSemanticCheck);
  decision.rawScore = typeof decision.rawScore === 'number' ? decision.rawScore : 0;
  decision.confidenceLevel = confidenceLevelFor(decision.confidence);
  decision.interpretationStatus = interpretationStatusFor(decision);

  if (!options.silent) {
    logIntentDecision(
      {
        decision,
        input: text,
        contextId: options.contextId,
        correlationId,
        classifierVersion: CLASSIFIER_VERSION,
      },
      options.logger
    );
  }

  return decision;
}

/**
 * Follow-up resolution: a signal-free, anaphora-carrying turn ("En deze
 * dan?") — or, since 2.4, a bare interrogative follow-up ("why?") —
 * inherits the nearest prior user turn's resolved intent, at reduced
 * confidence, with sourceOfTruth pinned to "conversation" — the turn only
 * makes sense in light of what was just discussed.
 *
 * @param {string} text
 * @param {Array<{role:string,content:string}>} messages
 * @param {object} options
 * @param {{ inheritedReason?: string, unresolvedReason?: string }} [reasons] distinct
 *   telemetry reasons for the 2.4 bare-interrogative path vs the original anaphora path
 */
function resolveByInheritance(text, messages, options, reasons = {}) {
  const inheritedReason = reasons.inheritedReason || 'inherited_from_prior_turn';
  const unresolvedReason = reasons.unresolvedReason || 'continuation_with_no_resolvable_prior_turn';
  const inherited = findInheritablePriorIntent(messages);
  if (inherited) {
    const status = inherited.confidence >= 0.4 ? 'accepted' : 'ambiguous';
    return {
      schemaVersion: SCHEMA_VERSION,
      intent: status === 'accepted' ? inherited.intent : null,
      status,
      confidence: status === 'accepted' ? inherited.confidence : 0,
      candidates: [{ intent: inherited.intent, score: inherited.confidence }],
      entities: extractEntities(text),
      sourceOfTruth: 'conversation',
      needsClarification: status !== 'accepted',
      rawScore: inherited.rawScore,
      // Inherited from context, not from this turn's own signal — always
      // worth a semantic check, even when confident enough to accept.
      needsSemanticCheck: status === 'accepted',
      meta: {
        taxonomyVersion: TAXONOMY_VERSION,
        classifierVersion: CLASSIFIER_VERSION,
        reason: inheritedReason,
      },
    };
  }
  return unknownWithSourceAttempt(text, options, unresolvedReason);
}

/**
 * The inheritance core shared by resolveByInheritance and the
 * assistant-anchored path: scans prior USER turns (most recent first) for
 * one whose intent resolved confidently enough to lend to a follow-up.
 * @returns {{ intent: string, confidence: number, rawScore: number }|null}
 */
function findInheritablePriorIntent(messages) {
  const priors = priorUserTexts(messages, true);
  for (const priorText of priors) {
    const priorScored = scoreAllIntents(priorText);
    if (priorScored.length === 0) continue;
    const priorCandidates = toNormalizedCandidates(priorScored);
    const priorStatus = decideStatus(priorCandidates, priorScored);
    if (priorStatus !== 'accepted') continue;
    return {
      intent: priorCandidates[0].intent,
      confidence: Math.round(priorCandidates[0].score * 0.7 * 100) / 100,
      rawScore: priorScored[0].raw,
    };
  }
  return null;
}

// --- heuristic-v0.3: assistant-originated referents -------------------------
//
// A follow-up frequently reuses a term GAIA introduced in her own previous
// response ("...gezien de context rond juni..." → "wat was er in juni ook
// alweer?"). Until v0.3 such turns scored zero signals AND carried no
// pronoun, so they fell through to plain unknown with sourceOfTruth
// "unknown" — and memory recall never ran, even though the answer lives in
// exactly that shared context. The generic mechanism below anchors a user
// turn back to the immediately preceding ASSISTANT turn through CONTENT-TERM
// OVERLAP. Deliberately NOT a keyword list of months/dates/topics: any
// substantive term either side introduces can anchor, and nothing anchors
// without a real preceding assistant turn mentioning it.

/** Function words only — comparison machinery for anchoring, never intent signals. */
const ANCHOR_STOPWORDS = new Set([
  // NL function words + deictic pronouns (deictics are handled by the
  // pronominal continuation path, never as content-term anchors)
  'de', 'het', 'een', 'en', 'van', 'in', 'op', 'voor', 'met', 'dat', 'die',
  'deze', 'dit', 'maar', 'ook', 'als', 'bij', 'uit', 'over', 'onder', 'tot',
  'door', 'om', 'naar', 'wat', 'wie', 'waar', 'wanneer', 'hoe', 'geen',
  'niet', 'wel', 'nog', 'alle', 'er', 'erin', 'eraan', 'hier', 'hiermee',
  'daar', 'daarmee', 'daarin', 'daarop', 'dan', 'toen', 'dus', 'zo', 'even',
  'heel', 'meer', 'meest', 'veel', 'weinig', 'graag', 'eigen', 'gewoon',
  'alweer', 'welke', 'zulke', 'zulk', 'hebben', 'heeft', 'had', 'worden',
  'wordt', 'werd', 'zijn', 'was', 'waren', 'kunnen', 'kan', 'zou', 'gaan',
  'gaat', 'ging', 'maken', 'maakt', 'zeggen', 'zegt', 'zeiden',
  // EN mirrors
  'the', 'and', 'for', 'with', 'that', 'this', 'these', 'those', 'what',
  'when', 'where', 'which', 'there', 'here', 'again', 'actually',
]);

const MIN_ANCHOR_TOKEN_LENGTH = 4;
const MAX_ASSISTANT_REFERENTS = 3;

/** Content tokens for anchor comparison: normalized, stopword-free, length-bounded. */
function anchorTokens(text) {
  return normalize(text).replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= MIN_ANCHOR_TOKEN_LENGTH && !ANCHOR_STOPWORDS.has(w));
}

/**
 * The assistant turn immediately before the latest user turn — the
 * antecedent source for references Gaia herself introduced. Null when
 * there is none (first turn of a conversation).
 */
function previousAssistantText(messages) {
  if (!Array.isArray(messages)) return null;
  let idx = messages.length - 1;
  while (idx >= 0 && messages[idx] && messages[idx].role !== 'user') idx -= 1; // latest user turn
  idx -= 1;
  while (idx >= 0 && messages[idx] && messages[idx].role !== 'assistant') idx -= 1;
  return idx >= 0 ? (messages[idx].content || '') : null;
}

/**
 * Content terms the user reused from Gaia's immediately preceding response.
 * @returns {string[]} unique anchored terms, most recent-turn order first, capped
 */
function assistantAnchorTerms(text, messages) {
  const prev = previousAssistantText(messages);
  if (!prev || !normalize(prev)) return [];
  const prevTokens = new Set(anchorTokens(prev));
  const seen = new Set();
  const out = [];
  for (const t of anchorTokens(text)) {
    if (prevTokens.has(t) && !seen.has(t)) {
      seen.add(t);
      out.push(t);
      if (out.length >= MAX_ASSISTANT_REFERENTS) break;
    }
  }
  return out;
}

/**
 * heuristic-v0.3 cascade branch: the user's turn shares a content term with
 * Gaia's immediately preceding response — she introduced it, the user is
 * following up on it. Resolution:
 *   - intent: inherited from the nearest resolvable prior USER turn at the
 *     same reduced confidence as any other follow-up, or honestly unknown —
 *     the anchor resolves the TOPIC, not the speech act;
 *   - sourceOfTruth: 'memory' — the answer must come from what Gaia recalls
 *     about that shared topic (this is what opens Hindsight recall);
 *   - referents: populated with provenance pointing at the assistant turn,
 *     so downstream consumers can see WHY this is a follow-up.
 * Returns null whenever there are no anchored terms (callers fall through
 * unchanged) — without sufficient preceding context the system stays as
 * uncertain as it always was.
 */
function resolveAssistantAnchoredFollowUp(text, messages, options) {
  const anchors = assistantAnchorTerms(text, messages);
  if (anchors.length === 0) return null;

  const referents = anchors.map((term) => ({
    expression: term,
    resolvedTo: `previous_assistant_turn:${term}`,
    confidence: 0.6,
    source: 'previous_assistant_turn',
  }));

  const inherited = findInheritablePriorIntent(messages);
  if (inherited) {
    const status = inherited.confidence >= 0.4 ? 'accepted' : 'ambiguous';
    return {
      schemaVersion: SCHEMA_VERSION,
      intent: status === 'accepted' ? inherited.intent : null,
      status,
      confidence: status === 'accepted' ? inherited.confidence : 0,
      candidates: [{ intent: inherited.intent, score: inherited.confidence }],
      entities: extractEntities(text),
      sourceOfTruth: 'memory',
      needsClarification: status !== 'accepted',
      rawScore: inherited.rawScore,
      needsSemanticCheck: true, // context-resolved, like every inherited decision
      referents,
      meta: {
        taxonomyVersion: TAXONOMY_VERSION,
        classifierVersion: CLASSIFIER_VERSION,
        reason: 'assistant_anchored_follow_up_inherited',
        anchoredTerms: anchors,
      },
    };
  }

  // No inheritable intent — remain uncertain about the speech act, but the
  // topical anchor itself is still real: record it and point recall at
  // memory rather than declaring the turn context-free.
  return {
    schemaVersion: SCHEMA_VERSION,
    intent: null,
    status: 'unknown',
    confidence: 0,
    candidates: [],
    entities: extractEntities(text),
    sourceOfTruth: 'memory',
    needsClarification: false,
    rawScore: 0,
    needsSemanticCheck: false,
    referents,
    meta: {
      taxonomyVersion: TAXONOMY_VERSION,
      classifierVersion: CLASSIFIER_VERSION,
      reason: 'assistant_anchored_follow_up_unresolved_intent',
      anchoredTerms: anchors,
    },
  };
}

/**
 * Records WHICH deictic expressions in the current turn point at Gaia's own
 * previous response, on decisions produced by the existing pronominal /
 * bare-interrogative paths. Purely additive provenance — never changes
 * status/intent/sourceOfTruth. No-op without an assistant antecedent or
 * when referents are already populated (the anchored path fills richer ones).
 */
const DEICTIC_EXPRESSIONS = new Set([
  'dit', 'deze', 'dat', 'die', 'daar', 'daarmee', 'daarin', 'daarop',
  'hier', 'hiermee', 'ermee', 'eraan', 'it', 'this', 'that', 'these', 'those',
]);
function attachAssistantReferents(decision, text, messages) {
  try {
    if (!decision || (Array.isArray(decision.referents) && decision.referents.length > 0)) return decision;
    if (!previousAssistantText(messages)) return decision;
    const found = [...new Set(normalize(text).replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => DEICTIC_EXPRESSIONS.has(w)))];
    if (found.length === 0) return decision;
    decision.referents = found.slice(0, MAX_ASSISTANT_REFERENTS).map((expression) => ({
      expression,
      resolvedTo: 'previous_assistant_turn',
      confidence: 0.55,
      source: 'previous_assistant_turn',
    }));
  } catch (_) { /* provenance metadata must never break classification */ }
  return decision;
}

// --- IntentIQ 2.0: semantic classification tier ----------------------------

/**
 * Calls the semantic classifier model, if one is configured, and returns a
 * validated SemanticResult — or degrades to `null` on any failure
 * (unconfigured, unreachable, malformed output). Never throws: a semantic
 * classification failure must never take down interpretation the way a
 * missing/broken heuristic signal never does either. The heuristic
 * classifier remains authoritative whenever this returns null.
 *
 * @param {string} text
 * @param {{ recentTurns?: Array<{role:string,content:string}>, heuristicResult?: object }} [context]
 * @param {{ model?: { chat: (messages: Array) => Promise<string> } }} [options] `model` is injectable for tests; defaults to intentModelClient.js's createFromEnv(process.env).
 * @returns {Promise<{ attempted: boolean, result: object|null }>} `attempted` is true only when a real model call was actually issued (for observability — "semantic call yes/no"), independent of whether it succeeded.
 */
async function classifySemantic(text, context = {}, options = {}) {
  const model = options.model || createIntentModelFromEnv();
  if (!model) {
    return { attempted: false, result: null };
  }

  try {
    const messages = buildSemanticPrompt({
      text,
      recentTurns: context.recentTurns,
      heuristicResult: context.heuristicResult,
    });
    const raw = await model.chat(messages);
    const result = parseAndValidateSemanticOutput(raw);
    return { attempted: true, result };
  } catch (err) {
    const reason = err instanceof MalformedSemanticOutputError ? 'malformed_semantic_output' : 'semantic_model_unavailable';
    console.error(`[intentIQ] semantic classification degraded (${reason}): ${err.message}`);
    return { attempted: true, result: null };
  }
}

/**
 * Merges the heuristic IntentDecision with an (optional) semantic result
 * into IntentIQ 2.0's final interpretation. `semantic` is `null` whenever
 * no semantic call happened or ran (unconfigured, skipped because the
 * heuristic already matched strongly, or degraded) — in that case the
 * heuristic decision is returned completely unchanged, byte-for-byte
 * identical to classify()'s own v0.1 output (this is what keeps
 * interpret() backward compatible when no semantic classifier is
 * configured — see intentModelClient.js).
 *
 * Consensus rules (per the IntentIQ 2.0 brief):
 *   - Both tiers agree on the top intent -> confidence rises (the max of
 *     the two), not ambiguous.
 *   - Both have an opinion but disagree -> the higher-confidence intent
 *     wins, but the result is explicitly `ambiguous: true` — disagreement
 *     between two independent interpretation methods is real uncertainty,
 *     not something to paper over with whichever answer happens to be
 *     picked.
 *   - Only the semantic tier has an opinion (heuristic found nothing) ->
 *     the semantic result is used, carrying its own ambiguity judgment.
 *   - Only the heuristic tier has an opinion (semantic found nothing) ->
 *     the heuristic decision is used unchanged.
 *   - Neither has an opinion -> unknown, as before.
 *
 * sourceOfTruth prefers the heuristic's own rule-based judgment whenever
 * it resolved to anything more specific than "unknown" (principles.md —
 * Source First already gives that logic real signal words to work from);
 * the semantic tier's sourceOfTruth judgment is only used to fill the gap
 * when the heuristic genuinely couldn't tell.
 *
 * @param {object} heuristic classify()'s IntentDecision
 * @param {object|null} semantic a validated SemanticResult, or null
 * @returns {object} the final IntentDecision
 */

/**
 * Returns the top semantic candidate and the confidence margin over the
 * runner-up. `top` is null when there is no candidate; `margin` is Infinity
 * when there is only one candidate (no genuine competition).
 * @param {object} semantic a validated SemanticResult
 * @returns {{ top: { intent: string, confidence: number }|null, margin: number }}
 */
function semanticTopAndMargin(semantic) {
  const cands = [...(semantic.candidates || [])]
    .map((c) => ({ intent: c.intent, confidence: c.confidence }))
    .sort((a, b) => b.confidence - a.confidence);
  if (cands.length === 0) return { top: null, margin: 0 };
  const top = cands[0];
  const runnerUp = cands[1];
  return { top, margin: runnerUp ? top.confidence - runnerUp.confidence : Infinity };
}

/**
 * Semantic-tier ambiguity, reconciled against candidate-margin evidence.
 *
 * A model-reported `ambiguous: true` flag is NOT trusted on its own: the
 * semantic result carries candidates, and when the top candidate clearly
 * leads the runner-up (margin above AMBIGUITY_CONFIDENCE_MARGIN), the turn
 * has a genuine winner and must be accepted — the reported flag is a
 * calibration inconsistency (the model hedged while also giving a decisive
 * candidate). Ambiguity therefore depends on genuine interpretive
 * competition, not merely candidate presence or a self-reported flag.
 *
 * @param {object} semantic a validated SemanticResult
 * @returns {boolean}
 */
function semanticIsAmbiguous(semantic) {
  if (!semantic.ambiguous) return false;
  const { margin } = semanticTopAndMargin(semantic);
  // A single candidate (margin Infinity) or a decisive margin both override
  // the flag; only a genuinely close candidate pair keeps it ambiguous.
  return margin <= AMBIGUITY_CONFIDENCE_MARGIN;
}

function combineConsensus(heuristic, semantic) {
  if (!semantic) return heuristic;

  const heuristicTop = heuristic.status === 'accepted'
    ? heuristic.intent
    : (heuristic.candidates[0] && heuristic.candidates[0].intent) || null;
  const heuristicTopConfidence = heuristicTop
    ? (heuristic.status === 'accepted' ? heuristic.confidence : heuristic.candidates[0].score)
    : 0;

  // Merge candidate lists: union by intent, keeping the higher score seen
  // for each — never silently dropping a candidate either tier surfaced.
  const merged = new Map();
  for (const c of heuristic.candidates || []) merged.set(c.intent, c.score);
  for (const c of semantic.candidates || []) merged.set(c.intent, Math.max(merged.get(c.intent) || 0, c.confidence));
  if (semantic.intent) merged.set(semantic.intent, Math.max(merged.get(semantic.intent) || 0, semantic.confidence));
  const candidates = [...merged.entries()]
    .map(([intent, score]) => ({ intent, score }))
    .sort((a, b) => b.score - a.score);

  let intent = null;
  let confidence = 0;
  let ambiguous = false;
  let status = 'unknown';
  let rawScore = 0;

  if (heuristicTop && semantic.intent && heuristicTop === semantic.intent) {
    intent = semantic.intent;
    confidence = capConfidence(Math.max(heuristicTopConfidence, semantic.confidence));
    status = 'accepted';
    ambiguous = false;
    rawScore = heuristic.rawScore || 0;
  } else if (heuristicTop && semantic.intent && heuristicTop !== semantic.intent) {
    const semanticWins = semantic.confidence >= heuristicTopConfidence;
    intent = semanticWins ? semantic.intent : heuristicTop;
    confidence = capConfidence(semanticWins ? semantic.confidence : heuristicTopConfidence);
    status = 'ambiguous';
    ambiguous = true;
    // Whichever tier's opinion won is the one whose raw signal explains
    // the result — the semantic model's own self-reported confidence
    // stands in for a "raw" number on that side (it has no hit count).
    rawScore = semanticWins ? semantic.confidence : (heuristic.rawScore || 0);
  } else if (!heuristicTop && semantic.intent) {
    intent = semantic.intent;
    confidence = capConfidence(semantic.confidence);
    // Ambiguity is reconciled against the candidate margin, not trusted
    // blindly from the model's flag: a clear winner (top candidate leading
    // the runner-up by more than AMBIGUITY_CONFIDENCE_MARGIN) is accepted
    // even when the model hedged with ambiguous:true. Only genuinely close
    // candidate pairs keep the turn ambiguous.
    ambiguous = semanticIsAmbiguous(semantic);
    status = ambiguous ? 'ambiguous' : 'accepted';
    rawScore = semantic.confidence;
  } else if (heuristicTop && !semantic.intent) {
    intent = heuristicTop;
    confidence = heuristicTopConfidence;
    status = heuristic.status;
    ambiguous = heuristic.status === 'ambiguous';
    rawScore = heuristic.rawScore || 0;
  } else if (candidates.length > 0) {
    // Neither tier committed to a single top intent — this is what a
    // semantic result legitimately looks like when the model itself
    // reports "several plausible candidates, no clear winner" (intent:
    // null alongside a populated candidates list — a real case seen in
    // production, not a hypothetical). Report the best guess honestly,
    // marked ambiguous, rather than collapsing real signal into a bare
    // "unknown" that would throw the candidates away. Matches the brief's
    // own example shape: an ambiguous result still names its best-guess
    // `intent`, it just also says `ambiguous: true`.
    intent = candidates[0].intent;
    confidence = capConfidence(candidates[0].score);
    status = 'ambiguous';
    ambiguous = true;
    rawScore = candidates[0].score;
  }
  // else: truly nothing from either tier — stays unknown/0/false, as initialized.

  const sourceOfTruth = (heuristic.sourceOfTruth && heuristic.sourceOfTruth !== 'unknown')
    ? heuristic.sourceOfTruth
    : (semantic.sourceOfTruth || 'unknown');

  const confidenceLevel = confidenceLevelFor(confidence);
  const combined = {
    ...heuristic,
    intent,
    status,
    confidence,
    candidates,
    sourceOfTruth,
    needsClarification: status !== 'accepted',
    ambiguous,
    speechAct: semantic.speechAct || null,
    referents: semantic.referents || [],
    rawScore,
    // The semantic tier has now actually run and been weighed — there is
    // nothing further left to check at this point, regardless of what the
    // heuristic tier's own needsSemanticCheck said going in.
    needsSemanticCheck: false,
    confidenceLevel,
    meta: {
      ...heuristic.meta,
      semanticReason: semantic.reason || null,
      classifierVersion: SEMANTIC_CLASSIFIER_VERSION,
    },
  };
  combined.interpretationStatus = interpretationStatusFor(combined);
  return combined;
}

// --- Semantic fallback gate ------------------------------------------------
//
// The semantic LLM is expensive (~9s). It should only be called when local
// heuristic evidence is genuinely insufficient. When the heuristic returns
// `unknown` with zero candidates and no needsSemanticCheck flag, the
// semantic model would just confirm "I don't know" or guess "converse" —
// neither adds value over the heuristic's honest result. The Decision
// Engine already routes unknown intents to native/conversational.
//
// This gate does NOT skip semantic when:
//   - The heuristic found candidates (status may be 'unknown' with
//     candidates from continuation/inheritance paths)
//   - needsSemanticCheck is set (weak cues, overlapping candidates)
//   - The heuristic resolved to 'accepted' or 'ambiguous'
//   - The turn is empty/filler (already handled by classify)

/**
 * Determines whether the semantic LLM call can be safely skipped.
 * @param {IntentDecision} heuristic
 * @returns {{ skip: boolean, reason: string|null }}
 */
function shouldSkipSemanticFallback(heuristic) {
  // Only skip for genuinely signal-free unknown results
  if (heuristic.status !== 'unknown') return { skip: false, reason: null };
  if (heuristic.candidates.length > 0) return { skip: false, reason: null };
  if (heuristic.needsSemanticCheck) return { skip: false, reason: null };

  // The heuristic found nothing — no intent signals, no continuation,
  // no inheritance, no compound. The semantic model would just confirm
  // "unknown" or resolve to "converse" (which the Decision Engine
  // already does for unknown intents). Skip the expensive LLM call.
  const reason = (heuristic.meta && heuristic.meta.reason) || 'unknown';
  return { skip: true, reason: `conversational_fast_path:${reason}` };
}

/**
 * IntentIQ 2.0's entry point — turn.js's own `intentIQ` default. Runs the
 * unchanged heuristic classify() first (cheap, synchronous), and only
 * escalates to the semantic tier when the heuristic result was not a
 * confident ("accepted") match, so a strong heuristic match never incurs
 * an extra model call. classify() itself is untouched and remains
 * directly callable wherever only the free heuristic tier is wanted (see
 * test/intentIQ.test.js's many direct classify() tests).
 *
 * @param {Array<{role:string,content:string}>} messages
 * @param {{
 *   correlationId?: string,
 *   contextId?: string,
 *   hasAttachment?: boolean,
 *   silent?: boolean,
 *   logger?: (line: string) => void,
 *   model?: { chat: (messages: Array) => Promise<string> },
 * }} [options]
 * @returns {Promise<IntentDecision>}
 */
async function interpret(messages, options = {}) {
  const correlationId = options.correlationId || crypto.randomUUID();
  const heuristic = classify(messages, { ...options, correlationId, silent: true });
  const text = latestUserText(Array.isArray(messages) ? messages : []);

  let semantic = { attempted: false, result: null };
  let semanticSkipReason = null;

  // IntentIQ 2.2: a strong heuristic match is not automatically sufficient
  // any more — an accepted-but-unverified match (weak-only signal,
  // resolved-but-overlapping candidates, or a context-inherited intent)
  // still escalates via needsSemanticCheck, even though status:'accepted'.
  if (heuristic.status !== 'accepted' || heuristic.needsSemanticCheck) {
    // IntentIQ conversational fast-path: skip the semantic LLM when the
    // heuristic honestly returned "unknown" with zero candidates and no
    // needsSemanticCheck flag. The semantic model would just confirm
    // "unknown" or guess "converse" — neither adds value. The Decision
    // Engine already routes unknown intents to native/conversational.
    const skipCheck = shouldSkipSemanticFallback(heuristic);
    if (skipCheck.skip) {
      semanticSkipReason = skipCheck.reason;
    } else {
      // The full recent history (both roles), not just prior user turns —
      // resolving "en deze dan?" needs to see what the assistant said too,
      // not only what the user has typed. messages ends with the current
      // turn (this codebase's convention — see turn.js), so drop the last
      // entry; buildSemanticPrompt itself caps this to its own last-6 window.
      const recentTurns = Array.isArray(messages) ? messages.slice(0, -1) : [];
      semantic = await classifySemantic(
        text,
        { recentTurns, heuristicResult: heuristic },
        { model: options.model }
      );
    }
  }

  const final = combineConsensus(heuristic, semantic.result);

  if (!options.silent) {
    logIntentDecision(
      {
        decision: final,
        input: text,
        contextId: options.contextId,
        correlationId,
        classifierVersion: CLASSIFIER_VERSION,
        semanticCalled: semantic.attempted,
        semanticSkipReason,
        // Both tiers' own perspective, kept for calibration/debug logging
        // only (item 11/14 of the 2.2 brief) — never part of the returned
        // IntentDecision itself, and never the raw input text again (that
        // is already truncated once, above, by `input`).
        tiers: {
          heuristic: {
            intent: heuristic.intent,
            status: heuristic.status,
            confidence: heuristic.confidence,
            needsSemanticCheck: heuristic.needsSemanticCheck,
          },
          semantic: semantic.result
            ? {
                intent: semantic.result.intent,
                confidence: semantic.result.confidence,
                ambiguous: semantic.result.ambiguous,
              }
            : null,
        },
      },
      options.logger
    );
  }

  return final;
}

module.exports = {
  classify,
  interpret,
  classifySemantic,
  combineConsensus,
  shouldSkipSemanticFallback,
  SCHEMA_VERSION,
  CLASSIFIER_VERSION,
  SEMANTIC_CLASSIFIER_VERSION,
  // exported for the eval harness and tests only — not part of the public
  // cognitive contract other Gaia modules should depend on.
  __internals: {
    scoreAllIntents,
    toNormalizedCandidates,
    resolveSourceOfTruth,
    extractEntities,
    isEmptyOrFiller,
    computeNeedsSemanticCheck,
    confidenceLevelFor,
    interpretationStatusFor,
    collectMatchedSignals,
    isBareInterrogativeFollowUp,
    isDeclarativeStatusUpdate,
    isSelfDirectedInvestigation,
    isCreativeArtifactRequest,
    semanticTopAndMargin,
    semanticIsAmbiguous,
    assistantAnchorTerms,
    previousAssistantText,
    resolveAssistantAnchoredFollowUp,
    attachAssistantReferents,
    findInheritablePriorIntent,
  },
};
