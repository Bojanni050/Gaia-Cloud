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
  /**
   * The user asks what is RECORDED/REGISTERED in Foundation (the archive) —
   * the deliberate counterpart of rememberedKnowledge: "wat herinnert je"
   * is Hindsight, "wat staat er vastgelegd" is Foundation. Explicitly
   * archive-shaped wording only (Foundation/archief/vastgelegd + a
   * lookup cue) — never a guess from topic alone.
   */
  recordedKnowledge: Object.freeze([
    // the archive itself is named as the place to look
    /\bin foundation\b/i,
    /\bfoundation\s+(zoeken|geheugen|archief|notities|data|gegevens)\b/i,
    /\b(door)?zoek(opdracht)?\b[\s\S]{0,50}\b(mijn\s+)?(archief|notities|aantekeningen)\b/i,
    // what has been written down / registered
    /\b(wat|iets)\b[\s\S]{0,40}\b(vastligt|vastgelegd|geregistreerd|genoteerd|opgeschreven|gedocumenteerd)\b/i,
    /\b(heb ik|hebben we)\b[\s\S]{0,40}\b(genoteerd|opgeschreven|vastgelegd|geregistreerd)\b/i,
    // english counterparts
    /\bsearch\b[\s\S]{0,50}\b(the\s+)?(archive|foundation|recorded)\b/i,
    /\bwhat('s| is| has been)\b[\s\S]{0,40}\b(recorded|logged|noted|documented|written down)\b/i,
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

/**
 * TASK SHAPES that clearly match a routing skill: failure investigation,
 * test strategy, code review. Deliberately narrow and deliberately NOT a
 * name->skill keyword router: the frames describe multi-word semantic
 * shapes, a skill's own NAME appearing in the prompt never selects it, and a
 * turn with no matching shape simply reports none (spec §13). Order matters:
 * the first shape the registry can route wins, in the Decision Engine.
 * Which of these shapes may actually be routed to Hermes is the engine's and
 * the capability registry's call, not IntentIQ's.
 */
const SKILL_TASK_FRAMES = Object.freeze([
  {
    skill: 'systematic-debugging',
    frames: Object.freeze([/\bwaarom\b[\s\S]{0,60}\b(faalt|falen|crasht|crash|fout gaat|misgaat|vastloopt|lekt|niet werkt)\b/i, /\bzoek uit\b[\s\S]{0,50}\b(waarom|oorzaak|root cause)\b/i, /\broot cause\b/i, /\bwaardoor\b[\s\S]{0,60}\b(fout|faalt|crash|probleem|breekt)\b/i, /\bfout opsporen\b/i, /\bdebug\b[\s\S]{0,40}\b(waarom|oorzaak)\b/i]),
  },
  {
    skill: 'test-driven-development',
    frames: Object.freeze([/\btest(strategie|strategieën|plan|suite|dekking|coverage)\b/i, /\bstrategie\b[\s\S]{0,40}\btests?\b/i, /\btdd\b/i]),
  },
  {
    skill: 'requesting-code-review',
    frames: Object.freeze([/\bcode review\b/i, /\b(beoordeel|review|nakijken)\b[\s\S]{0,40}\b(mijn code|deze code|mijn wijzigingen|de wijzigingen|pull request|mijn pr)\b/i, /\b(mijn code|deze code|mijn wijzigingen|de wijzigingen)\b[\s\S]{0,40}\b(reviewen|review|beoordelen|nakijken)\b/i]),
  },
]);

const SIGNAL_NAMES = Object.freeze(Object.keys(SIGNAL_PATTERNS));

/**
 * @typedef {Object} TurnSignals
 * @property {boolean} exactHistory        asks for what was literally said
 * @property {boolean} pastLookup          points at a past conversation moment
 * @property {boolean} rememberedKnowledge asks what Gaia remembers
 * @property {boolean} recordedKnowledge   asks what is recorded in Foundation (the archive)
 * @property {boolean} analysis            wants retrieved material analysed
 * @property {boolean} lookup              is worded as a question / recall cue
 * @property {string[]} skillTasks         routing-skill task shapes the wording matches (ids, in priority order)
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
  out.skillTasks = detectSkillTasks(text);
  return out;
}

/** @returns {string[]} skill ids whose task shape matches `text`, in priority order */
function detectSkillTasks(text) {
  const s = String(text || '');
  return SKILL_TASK_FRAMES.filter((entry) => entry.frames.some((frame) => frame.test(s))).map((entry) => entry.skill);
}

module.exports = { detectSignals, detectSkillTasks, matchesSignal, SIGNAL_PATTERNS, SKILL_TASK_FRAMES, SIGNAL_NAMES };
