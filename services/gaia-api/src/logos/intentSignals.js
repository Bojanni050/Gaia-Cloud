'use strict';

/**
 * IntentIQ's routing-relevant turn signals — the ONE place where wording is
 * turned into "what kind of request is this" booleans.
 *
 * Why this lives here: the Decision Engine decides, it does not interpret
 * (see decisionEngine.js's header). Until now it also carried its own regex
 * vocabulary for exact-history / past-lookup / remembered-knowledge /
 * analysis cues, a second, parallel interpretation layer next to IntentIQ.
 * Phase 1 (this file): the vocabulary is defined once, here, and IntentIQ
 * publishes the result as `IntentDecision.signals`. The engine still reads
 * the same patterns (re-exported, so both can never disagree) and its
 * behaviour is unchanged. Phase 2 moves the engine onto `intent.signals`;
 * phase 3 can then replace individual patterns (e.g. by the semantic tier)
 * without touching the engine at all.
 *
 * Pure and deterministic: no I/O, no LLM, never throws.
 */

/** Pattern vocabulary, keyed by signal name. Routing-level cues, kept small and legible. */
const SIGNAL_PATTERNS = Object.freeze({
  /** The user asks for what was LITERALLY said in past conversations. */
  exactHistory: Object.freeze([
    /\b(letterlijk|exact|precies)\b.{0,40}\b(zei|gezegd|gesproken|vertelde|stond)\b/i,
    /\bzei ik\b/i,
    /\bwat zei (je|ik|wij|we)\b/i,
    /\bwhat did i say\b/i,
  ]),
  /**
   * The user points at a PAST CONVERSATION moment without quoting it yet —
   * a lookup-shaped need ("wat we vorige maand over X besloten").
   */
  pastLookup: Object.freeze([
    /\bzo(eek|cht|ek)\b[\s\S]{0,60}\bwat we\b/i,
    /\bwat we (vorige|laatste|eerder)\b/i,
    /\b(besloten|afgesproken|gezegd|gebruikt)\b[\s\S]{0,40}\b(vorige|laatste)\b/i,
    /\bvorige (maand|week)\b[\s\S]{0,50}\b(besloten|gezegd|afspraak|besproken)\b/i,
  ]),
  /** The user wants remembered/selected knowledge (Hindsight-shaped). */
  rememberedKnowledge: Object.freeze([
    /\bwat weet je nog\b/i, /\bweet je nog\b/i, /\bwat ken je van mij\b/i,
    /\bwhat do you remember\b/i, /\bremember about me\b/i,
    /\bwat je (over|van)[\s\S]{0,40}\b(weet|kent)\b/i,
  ]),
  /** The retrieved material must be ANALYSED, not just shown. */
  analysis: Object.freeze([
    /\b(analyseer|beoordeel|vergelijk|evaluer)\w*\b/i,
    /\banaly[sz]e\b/i, /\bassess\b/i, /\bcompare\b/i,
    /\bcombineer\b/i, // merge retrieved knowledge with new input, then reason
  ]),
  /**
   * The wording asks to look something up (a question or an explicit recall
   * cue) rather than merely making a statement. Anchoring to Gaia's previous
   * reply fires on ANY shared content term — far too weak, on its own, to
   * justify a transcript search — so a lookup needs this shape as well.
   */
  lookup: Object.freeze([
    /\?/,
    /^\s*(wat|waar|wanneer|wie|hoe|welke|waarom|what|where|when|who|how|which|why)\b/i,
    /\b(ook alweer|weet je nog|herinner je|noemde je|zei je|zei ik|had je het over|hadden we het over|bedoelde je|remember|did you say|you mentioned)\b/i,
  ]),
});

const SIGNAL_NAMES = Object.freeze(Object.keys(SIGNAL_PATTERNS));

/**
 * @typedef {Object} TurnSignals
 * @property {boolean} exactHistory        asks for what was literally said
 * @property {boolean} pastLookup          points at a past conversation moment
 * @property {boolean} rememberedKnowledge asks what Gaia remembers
 * @property {boolean} analysis            wants retrieved material analysed
 * @property {boolean} lookup              is worded as a question / recall cue
 */

/** @returns {boolean} whether any pattern of the named signal matches `text` */
function matchesSignal(text, name) {
  const patterns = SIGNAL_PATTERNS[name];
  if (!patterns) return false;
  const s = String(text || '');
  return patterns.some((p) => p.test(s));
}

/**
 * @param {string|null|undefined} text the latest user turn
 * @returns {TurnSignals}
 */
function detectSignals(text) {
  const out = {};
  for (const name of SIGNAL_NAMES) out[name] = matchesSignal(text, name);
  return out;
}

module.exports = { detectSignals, matchesSignal, SIGNAL_PATTERNS, SIGNAL_NAMES };
