'use strict';

/**
 * Eleos's turn signals — the cheap, pure gate that decides whether a turn is
 * even a CANDIDATE for a later check-in.
 *
 * This is the "gate" half of gate-then-call (same posture as
 * logos/intentSignals.js and logos/logos.js's decideLogosDepth): a free,
 * deterministic lexical check that must fire before the Eleos model is ever
 * invoked. Most turns are not a moment anyone would come back to, and paying
 * for a model call on every turn to discover that would be wasteful and noisy.
 *
 * What it looks for is deliberately narrow and legible: a person voicing
 * something hard (sadness, worry, stress, loss, illness) or naming a
 * significant life event (an exam, an interview, a funeral, a move). It is a
 * CANDIDATE gate, not a judgment — the Eleos model still decides, and an
 * empty decision is normal and honest.
 *
 * Pure and deterministic: no I/O, no LLM, never throws.
 */

const SIGNAL_PATTERNS = Object.freeze({
  /** Voiced distress or a hard time. */
  distress: Object.freeze([
    /\b(verdrietig|verdriet|somber|teneergeslagen|depressief|rot|kut|klote|balen)\b/i,
    /\b(huil|huilen|gehuild|tranen)\b/i,
    /\b(eenzaam|alleen voel|eenzaamheid|lonely)\b/i,
    /\b(gestrest|stress|gestresseerd|overwerkt|burn[- ]?out|opgebrand)\b/i,
    /\b(bang|angst|angstig|paniek|onzeker|overweldigd)\b/i,
    /\b(zorgen|maak me zorgen|zit ermee|dwarszit)\b/i,
    /\b(ziek|ziek geweest|onwel|niet lekker|beroerd)\b/i,
    /\b(gaat slecht|gaat niet goed|zwaar|zwaar gehad|moeilijke tijd)\b/i,
    /\b(sad|upset|depressed|miserable|awful|lonely|anxious|anxiety|worried|stressed|overwhelmed|struggling)\b/i,
  ]),
  /** A named, dated or significant event in someone's life. */
  lifeEvent: Object.freeze([
    /\b(examen|tentamen|herexamen|sollicitatie|sollicitatiegesprek|sollicitatiegesprek|interview|beoordeling|eindgesprek)\b/i,
    /\b(operatie|ziekenhuis|opname|diagnose|uitslag|behandeling|dokter)\b/i,
    /\b(begrafenis|uitvaart|overlijden|overleden|gestorven|verloren|afscheid)\b/i,
    /\b(scheiding|break[- ]?up|uitgemaakt|relatie uit|verlaten)\b/i,
    /\b(verhuizing|verhuizen|nieuw huis|ontslag|baan kwijt|nieuwe baan)\b/i,
    /\b(zwanger|zwangerschap|geboren|baby)\b/i,
    /\b(funeral|passed away|died|loss|breakup|broke up|hospital|surgery|exam|interview|diagnosis|miscarriage)\b/i,
  ]),
});

const SIGNAL_NAMES = Object.freeze(Object.keys(SIGNAL_PATTERNS));

/** @returns {boolean} whether any pattern of the named signal matches `text` */
function matchesEleosSignal(text, name) {
  const patterns = SIGNAL_PATTERNS[name];
  if (!patterns) return false;
  const s = String(text || '');
  return patterns.some((p) => p.test(s));
}

/**
 * @typedef {Object} EleosSignals
 * @property {boolean} any       whether any Eleos signal matched at all
 * @property {string[]} kinds    which signal groups matched
 */

/**
 * @param {string|null|undefined} text
 * @returns {EleosSignals}
 */
function detectEleosSignals(text) {
  const s = String(text || '');
  const kinds = SIGNAL_NAMES.filter((name) => SIGNAL_PATTERNS[name].some((p) => p.test(s)));
  return { any: kinds.length > 0, kinds };
}

module.exports = { detectEleosSignals, matchesEleosSignal, SIGNAL_PATTERNS, SIGNAL_NAMES };
