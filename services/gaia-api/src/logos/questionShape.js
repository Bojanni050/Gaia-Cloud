'use strict';

/**
 * Question-shape recognition for Logos's open questions.
 *
 * Every open question carries a `shape` so the review card can offer the control
 * the question actually needs instead of always Ja/Nee:
 *
 *   yes_no — answerable with yes/no (the Ja/Nee pair is the answer)
 *   open   — free text; the question cannot be reduced to buttons
 *   choice — two to five alternatives, offered as one button each
 *
 * Deliberately conservative. `choice` is only claimed when the alternatives are
 * written as an explicit slash group — "(openen/inhouden)" — because that is the
 * one form where the options can be read off the text without guessing where the
 * question's verb phrase ends. A plain "A of B?" stays `open`: the options look
 * extractable but are not (the first alternative swallows the subject and the
 * verb, so "Wil je het bestand openen of inhouden?" yields "Wil je het bestand
 * openen" as an option), and a wrong button is worse than an honest text field.
 *
 * When Logos states the shape and options itself, that always wins (see
 * logosValidate.normalizeOpenQuestion) — this only fills the gap and classifies
 * the records that were written before the field existed.
 *
 * The trade-off is accepted in one direction only: an unclear sentence may fall
 * back to a text field where Ja/Nee would have done (English "of" — "Is that
 * part of the plan?" — reads as an alternation marker here), never the reverse.
 */

/** The three shapes a stored open question can have. */
const SHAPES = Object.freeze(['yes_no', 'open', 'choice']);

const MAX_OPTIONS = 5;
const MAX_OPTION_WORDS = 6;
const MAX_OPTION_CHARS = 80;
const MAX_CHOICE_GROUP_WORDS = 12;

// A yes/no question opens with a finite verb: "Is dit nog open?", "Klopt dit
// verband?", "Heeft de gebruiker X besloten?". A closed vocabulary on purpose —
// "any verb-looking first word" would claim far too much.
const YES_NO_FIRST_WORDS = new Set([
  // Dutch
  'is', 'zijn', 'was', 'waren', 'ben', 'bent', 'blijft', 'blijven', 'bleef', 'bleven',
  'kan', 'kun', 'kunt', 'kunnen', 'kon', 'konden',
  'zal', 'zult', 'zul', 'zullen', 'zou', 'zouden',
  'heb', 'hebt', 'heeft', 'hebben', 'had', 'hadden',
  'wil', 'wilt', 'willen', 'wilde', 'wilden', 'wil',
  'doe', 'doet', 'doen', 'deed', 'deden',
  'mag', 'mogen', 'mocht', 'moeten', 'moet',
  'wordt', 'worden', 'werd', 'werden', 'word',
  'gaat', 'gaan', 'ging', 'gingen',
  'klopt', 'klopte', 'lijkt', 'leek', 'vindt', 'vind', 'denkt', 'denk', 'weet', 'weten', 'wist',
  // English
  'am', 'are', 'were', 'be', 'was', 'do', 'does', 'did', 'have', 'has', 'had',
  'can', 'could', 'will', 'would', 'shall', 'should', 'may', 'might', 'must',
  'is', 'are', 'weren',
]);

// Yes/no markers that hold even when the question opens with a non-verb.
const YES_NO_PHRASES = [
  / of niet\s*\?/i,
  /\bja of nee\b/i,
  /\byes or no\b/i,
  /\bor not\b/i,
];

// An alternation marker: the question offers a real choice, so the Ja/Nee pair
// would answer the wrong thing — and the options may be unreadable anyway.
const ALTERNATION = /\s(?:of|or)\s/i;

/** Strips quotes/dashes/brackets from the front of the text and returns word 1. */
function firstWord(text) {
  const cleaned = String(text == null ? '' : text).replace(/^[\s"'“”‘’(\[{«-]+/, '');
  return (cleaned.split(/[\s,;:.!?]+/)[0] || '').toLowerCase();
}

/** Splits a parenthesised group on "/" — the one explicit option separator. */
function splitAlternatives(group) {
  return String(group)
    .split(/\s*\/\s*/)
    .map((part) => part.trim().replace(/^[.,;:!?\-–—\s]+|[.,;:!?\-–—\s]+$/g, ''))
    .filter(Boolean);
}

/** Is this usable as a button label: short, readable, not a model glitch. */
function isUsableOption(option) {
  if (!option || option.length > MAX_OPTION_CHARS) return false;
  if (!/[a-zA-Z]/.test(option)) return false;
  if (/[?!]{2,}/.test(option)) return false;
  return option.split(/\s+/).length <= MAX_OPTION_WORDS;
}

/** The same cleaning the validator applies to model-supplied options. */
function cleanOptions(value) {
  const out = [];
  for (const raw of Array.isArray(value) ? value : []) {
    const option = String(raw == null ? '' : raw).trim();
    if (!isUsableOption(option) || out.includes(option)) continue;
    out.push(option);
    if (out.length >= MAX_OPTIONS) break;
  }
  return out;
}

/**
 * The alternatives written as an explicit slash group, or [] when there is none.
 * The last usable group wins, so a trailing "(openen/inhouden)" beats an earlier
 * parenthetical aside.
 */
function optionsFromText(text) {
  const groups = String(text == null ? '' : text).match(/\(([^()]+)\)/g) || [];
  for (let i = groups.length - 1; i >= 0; i -= 1) {
    const inner = groups[i].slice(1, -1);
    if (!inner.includes('/')) continue;
    if (inner.split(/\s+/).length > MAX_CHOICE_GROUP_WORDS) continue;
    const alternatives = splitAlternatives(inner);
    if (
      alternatives.length >= 2
      && alternatives.length <= MAX_OPTIONS
      && alternatives.every(isUsableOption)
    ) {
      return alternatives;
    }
  }
  return [];
}

/**
 * @param {string} raw the question as written
 * @returns {{ shape: 'yes_no'|'open'|'choice', options: string[] }}
 */
function recognizeQuestionShape(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return { shape: 'open', options: [] };
  const options = optionsFromText(text);
  if (options.length >= 2) return { shape: 'choice', options };
  const saysYesNo = YES_NO_FIRST_WORDS.has(firstWord(text));
  // ...but only when the question is not offering a choice. "Heeft Bo dit
  // gedaan of niet?" is the exception: that phrase IS the yes/no marker.
  if (YES_NO_PHRASES.some((re) => re.test(text))) return { shape: 'yes_no', options: [] };
  if (saysYesNo && !ALTERNATION.test(text)) return { shape: 'yes_no', options: [] };
  return { shape: 'open', options: [] };
}

module.exports = {
  SHAPES,
  MAX_OPTIONS,
  recognizeQuestionShape,
  optionsFromText,
  cleanOptions,
  isUsableOption,
};
