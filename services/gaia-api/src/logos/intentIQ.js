'use strict';

/**
 * Logos.IntentIQ v0.1 — "what is the user trying to achieve?"
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
 * Implementation strategy — a small, inspectable, replaceable cascade:
 *
 *   1. Trivial/empty input           -> unknown, immediately.
 *   2. Deterministic signal scoring  -> bilingual (EN/NL) pattern cues per
 *                                        intent (intentTaxonomy.js's fixed
 *                                        vocabulary), scored on the latest
 *                                        user turn.
 *   2a. Follow-up resolution         -> if the latest turn carries no
 *                                        signal of its own but reads as a
 *                                        continuation ("En deze dan?" /
 *                                        "And this one?"), inherit the
 *                                        most recently resolved intent
 *                                        from the conversation window,
 *                                        at reduced confidence.
 *   2b. Compound-turn detection      -> a naive split on "and"/"en" that
 *                                        catches the clearest two-intent
 *                                        turns ("draft it and send it").
 *                                        Reported as ambiguous, never
 *                                        silently collapsed to one.
 *   3. Semantic/LLM classification   -> NOT IMPLEMENTED in v0.1. See the
 *                                        module-level NOTE below — this is
 *                                        a documented gap, not a silent
 *                                        one.
 *   4. Ambiguity / unknown           -> close-scoring candidates yield
 *                                        status "ambiguous"; no signal at
 *                                        all yields "unknown". Neither is
 *                                        a failure mode; both are the
 *                                        taxonomy working as designed
 *                                        (soul.md: "she never pretends
 *                                        certainty").
 *
 * NOTE on the missing semantic tier: the design brief for this module asks
 * for a staged cascade ending in "semantic/LLM classification where
 * necessary". That tier is deliberately not built in v0.1: IntentIQ is
 * forbidden from calling Hermes (the only reasoning provider this codebase
 * has), and there is no other model-agnostic reasoning seam available to
 * it yet. Building a second, IntentIQ-private reasoning path would be
 * exactly the kind of new Hermes-adjacent subsystem this task explicitly
 * rules out. So v0.1 is tier-1-only, with tier 3 left as a named, empty
 * extension point (see `classifySemantic` below) rather than invented
 * around. This is the single largest known limitation of this version —
 * see the implementation report for what a real tier 3 would need.
 */

const crypto = require('crypto');
const { INTENT_IDS, isKnownIntent, TAXONOMY_VERSION } = require('./intentTaxonomy');
const { logIntentDecision } = require('./intentLog');

const SCHEMA_VERSION = 'intentiq.v1';
const CLASSIFIER_VERSION = 'heuristic-v0.1';

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

function boundary(word) {
  return new RegExp(`\\b${word}\\b`, 'i');
}

function phrase(words) {
  return new RegExp(words.trim().replace(/\s+/g, '\\s+'), 'i');
}

// Anaphora / continuation cues — used only to decide whether a signal-free
// turn is a follow-up worth inheriting context for, never scored as an
// intent on their own.
const CONTINUATION_SIGNALS = [
  boundary('this'), boundary('that'), boundary('these'), boundary('those'),
  boundary('it'), boundary('dit'), boundary('deze'), boundary('dat'), boundary('die'),
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
  ],
  'inform.explain': [
    phrase('why (is|does|did|are|isn\'?t)'), phrase("what('|i)?s the"),
    phrase('what is'), phrase('how (does|do|did)'), boundary('explain'),
    phrase('tell me about'), phrase('what happened'), phrase("what'?s wrong with"),
    boundary('analyze'), boundary('analyse'),
    phrase('waarom'), phrase('wat is'), phrase('hoe werkt'), phrase('leg .* uit'),
    boundary('uitleggen'), boundary('analyseer'), boundary('analyseren'),
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
    boundary('herschrijf'), boundary('verbeter'), boundary('vertaal'),
    /\bmaak (dit|het)\b.{0,25}\b(korter|warmer|duidelijker)\b/i, phrase('pas .* aan'),
  ],
  'decide.support': [
    phrase('should i'), phrase('what would you do'), phrase("don'?t know whether"),
    phrase('talk me out of'), phrase('what am i missing'), phrase('help me decide'),
    phrase('which (one|option)'),
    phrase('zou ik'), phrase('wat zou jij doen'), phrase('ik weet niet of'),
    phrase('help me kiezen'),
  ],
  'memory.inspect': [
    phrase('what (have you|do you) (noticed|know|remember)'),
    phrase('why do you think that'), phrase('what do you understand about me'),
    phrase('wat weet je (over|van) mij'), phrase('wat heb je gemerkt'),
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
  ],
};

for (const id of Object.keys(SIGNALS)) {
  if (!isKnownIntent(id)) {
    throw new Error(`intentIQ signal set references unknown taxonomy intent: ${id}`);
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

/** @returns {Array<{intent: string, raw: number}>} sorted desc, zero scores excluded */
function scoreAllIntents(text) {
  const scored = INTENT_IDS
    .filter((id) => SIGNALS[id])
    .map((id) => ({ intent: id, raw: scoreText(text, SIGNALS[id]) }))
    .filter((s) => s.raw > 0);
  scored.sort((a, b) => b.raw - a.raw);
  return scored;
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
const MAX_CONFIDENCE = 0.95; // soul.md: "she never pretends certainty" — never report 1.0

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

// --- semantic tier extension point (not implemented — see module NOTE) ---

/**
 * @param {string} _text
 * @param {object} _ctx
 * @returns {null} always null in v0.1 — the deterministic tier is final.
 */
function classifySemantic(_text, _ctx) {
  return null;
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
    meta: { taxonomyVersion: TAXONOMY_VERSION, classifierVersion: CLASSIFIER_VERSION, reason },
  };
}

function latestUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i] && messages[i].role === 'user') return messages[i].content || '';
  }
  return '';
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
 * @param {Array<{role: string, content: string}>} messages full turn history, ending in the latest user message
 * @param {{
 *   correlationId?: string,
 *   contextId?: string,
 *   hasAttachment?: boolean,
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
    const compound = detectCompoundIntents(text);
    const directScored = scoreAllIntents(text);

    if (compound) {
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
        meta: {
          taxonomyVersion: TAXONOMY_VERSION,
          classifierVersion: CLASSIFIER_VERSION,
          reason: 'compound_turn_detected',
        },
      };
    } else if (directScored.length > 0) {
      const candidates = toNormalizedCandidates(directScored);
      const status = decideStatus(candidates, directScored);
      const top = candidates[0];
      decision = {
        schemaVersion: SCHEMA_VERSION,
        intent: status === 'accepted' ? top.intent : null,
        status,
        confidence: status === 'accepted' ? capConfidence(top.score) : 0,
        candidates,
        entities: extractEntities(text),
        sourceOfTruth: resolveSourceOfTruth(
          text,
          { hasAttachment: options.hasAttachment },
          status === 'accepted' ? top.intent : null
        ),
        needsClarification: status !== 'accepted',
        meta: { taxonomyVersion: TAXONOMY_VERSION, classifierVersion: CLASSIFIER_VERSION, reason: 'direct_signal' },
      };
    } else if (looksLikeContinuation(text)) {
      decision = resolveByInheritance(text, messages, options);
    } else {
      const semantic = classifySemantic(text, { messages, options });
      decision = semantic || unknownWithSourceAttempt(text, options, 'no_signal_matched');
    }
  }

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
 * dan?") inherits the nearest prior user turn's resolved intent, at
 * reduced confidence, with sourceOfTruth pinned to "conversation" — the
 * turn only makes sense in light of what was just discussed.
 */
function resolveByInheritance(text, messages, options) {
  const priors = priorUserTexts(messages, true);
  for (const priorText of priors) {
    const priorScored = scoreAllIntents(priorText);
    if (priorScored.length === 0) continue;
    const priorCandidates = toNormalizedCandidates(priorScored);
    const priorStatus = decideStatus(priorCandidates, priorScored);
    if (priorStatus !== 'accepted') continue;

    const inheritedConfidence = Math.round(priorCandidates[0].score * 0.7 * 100) / 100;
    const status = inheritedConfidence >= 0.4 ? 'accepted' : 'ambiguous';
    return {
      schemaVersion: SCHEMA_VERSION,
      intent: status === 'accepted' ? priorCandidates[0].intent : null,
      status,
      confidence: status === 'accepted' ? inheritedConfidence : 0,
      candidates: [{ intent: priorCandidates[0].intent, score: inheritedConfidence }],
      entities: extractEntities(text),
      sourceOfTruth: 'conversation',
      needsClarification: status !== 'accepted',
      meta: {
        taxonomyVersion: TAXONOMY_VERSION,
        classifierVersion: CLASSIFIER_VERSION,
        reason: 'inherited_from_prior_turn',
      },
    };
  }
  return unknownWithSourceAttempt(text, options, 'continuation_with_no_resolvable_prior_turn');
}

module.exports = {
  classify,
  SCHEMA_VERSION,
  CLASSIFIER_VERSION,
  // exported for the eval harness and tests only — not part of the public
  // cognitive contract other Gaia modules should depend on.
  __internals: { scoreAllIntents, toNormalizedCandidates, resolveSourceOfTruth, extractEntities, isEmptyOrFiller },
};
