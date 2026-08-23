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
 */

const crypto = require('crypto');
const { INTENT_IDS, isKnownIntent, TAXONOMY_VERSION } = require('./intentTaxonomy');
const { logIntentDecision } = require('./intentLog');
const { buildSemanticPrompt } = require('./intentSemanticPrompt');
const { parseAndValidateSemanticOutput, MalformedSemanticOutputError } = require('./intentSemanticValidate');
const { createFromEnv: createIntentModelFromEnv } = require('./intentModelClient');

const SCHEMA_VERSION = 'intentiq.v1';
const CLASSIFIER_VERSION = 'heuristic-v0.1';
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
      decision = unknownWithSourceAttempt(text, options, 'no_signal_matched');
    }
  }

  // Additive IntentIQ 2.0 fields, defaulted uniformly here regardless of
  // which cascade branch produced `decision` above — the heuristic tier
  // alone never computes speechAct/referents (that needs real semantic
  // interpretation, not keyword matching), and `ambiguous` is simply a
  // named alias of the existing `status === 'ambiguous'` judgment so
  // callers don't have to know that encoding. combineConsensus() (used by
  // interpret(), below) overwrites these when a semantic result actually
  // ran.
  decision.ambiguous = decision.status === 'ambiguous';
  decision.speechAct = decision.speechAct || null;
  decision.referents = decision.referents || [];

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

  if (heuristicTop && semantic.intent && heuristicTop === semantic.intent) {
    intent = semantic.intent;
    confidence = capConfidence(Math.max(heuristicTopConfidence, semantic.confidence));
    status = 'accepted';
    ambiguous = false;
  } else if (heuristicTop && semantic.intent && heuristicTop !== semantic.intent) {
    const semanticWins = semantic.confidence >= heuristicTopConfidence;
    intent = semanticWins ? semantic.intent : heuristicTop;
    confidence = capConfidence(semanticWins ? semantic.confidence : heuristicTopConfidence);
    status = 'ambiguous';
    ambiguous = true;
  } else if (!heuristicTop && semantic.intent) {
    intent = semantic.intent;
    confidence = capConfidence(semantic.confidence);
    ambiguous = Boolean(semantic.ambiguous);
    status = ambiguous ? 'ambiguous' : 'accepted';
  } else if (heuristicTop && !semantic.intent) {
    intent = heuristicTop;
    confidence = heuristicTopConfidence;
    status = heuristic.status;
    ambiguous = heuristic.status === 'ambiguous';
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
  }
  // else: truly nothing from either tier — stays unknown/0/false, as initialized.

  const sourceOfTruth = (heuristic.sourceOfTruth && heuristic.sourceOfTruth !== 'unknown')
    ? heuristic.sourceOfTruth
    : (semantic.sourceOfTruth || 'unknown');

  return {
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
    meta: {
      ...heuristic.meta,
      semanticReason: semantic.reason || null,
      classifierVersion: SEMANTIC_CLASSIFIER_VERSION,
    },
  };
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
  if (heuristic.status !== 'accepted') {
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
  SCHEMA_VERSION,
  CLASSIFIER_VERSION,
  SEMANTIC_CLASSIFIER_VERSION,
  // exported for the eval harness and tests only — not part of the public
  // cognitive contract other Gaia modules should depend on.
  __internals: { scoreAllIntents, toNormalizedCandidates, resolveSourceOfTruth, extractEntities, isEmptyOrFiller },
};
