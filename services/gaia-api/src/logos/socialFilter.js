'use strict';

/**
 * The social filter — the ONLY reason a turn is skipped.
 *
 * The old depth gate answered two questions at once: "is there evidence?" and
 * "is this a task?" Both starved the learning path. A short, meaningful remark
 * in a conversation with no task intent was skipped, and so was every turn
 * where Hindsight happened to recall nothing — which, in practice, is most of
 * them. The observation store stayed empty because of it.
 *
 * What is genuinely not worth a reasoning call is smaller than that: a greeting,
 * thanks, an acknowledgement, a farewell. Those carry nothing to observe, and
 * they can be recognised lexically for free — the same posture as Eleos's
 * signals. Everything else gets looked at.
 *
 * Deliberately lexical and dumb: no model, no intent classifier, no score. A
 * wrong "social" verdict costs one unobserved greeting; a wrong "not social"
 * costs one model call. Both are cheap, and the list is easy to correct.
 */

const SOCIAL_PHRASES = [
  // greetings
  'hoi', 'hey', 'he', 'hi', 'hallo', 'hello', 'goedemorgen', 'goedemiddag', 'goedenavond',
  'goedendag', 'morgen', 'dag', 'yo', 'hiya',
  // thanks / appreciation
  'dank', 'dankjewel', 'dankjewelfijn', 'dank je', 'dank je wel', 'bedankt', 'thanks', 'thank you', 'thx', 'merci',
  'top', 'fijn', 'mooi', 'geweldig', 'super',
  // acknowledgement
  'ok', 'oke', 'okee', 'okay', 'prima', 'duidelijk', 'klopt', 'precies', 'inderdaad',
  'juist', 'goed', 'got it', 'cool', 'nice', 'aha', 'hmm', 'hm', 'ja', 'nee', 'yes', 'no',
  'zeker', 'eens', 'mee eens', 'akkoord', 'snap ik', 'begrijp ik',
  'nee hoor', 'ja hoor', 'is goed', 'komt goed', 'ok prima',
  // laughter
  'haha', 'hahaha', 'lol',
  // farewell
  'doei', 'doeg', 'tot later', 'tot morgen', 'tot zo', 'bye', 'see you', 'dag dag',
];

const PHRASES = new Set(SOCIAL_PHRASES);
// A greeting that opens a short line is still a greeting: "hoi, alles goed?"
// carries nothing to observe, while "hoi, kun je naar de planning kijken?" is a
// request that happens to start politely.
const GREETING_OPENERS = new Set([
  'hoi', 'hey', 'he', 'hi', 'hallo', 'hello', 'goedemorgen', 'goedemiddag',
  'goedenavond', 'goedendag', 'morgen', 'dag', 'yo', 'hiya',
]);
const MAX_GREETING_WORDS = 4;

/** Lowercase, no punctuation, single spaces — the form the list is written in. */
function normalize(text) {
  return String(text || '')
    .toLowerCase()
    // Strip accents so "oké" and "oke" are the same word: the list is written
    // without them.
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Whether a turn is pure social exchange.
 *
 * Three shapes:
 *   - the whole message is one of the phrases ("hoi", "dank je wel", "oké");
 *   - a message of at most two words where every word is in the list
 *     ("ja precies", "nee hoor");
 *   - a greeting that opens a very short line ("hoi, alles goed?").
 * Anything longer is a conversation, even when it opens with a greeting: "hoi,
 * kun je kijken naar..." is a request, not a hello.
 */
function isSocialTurn(text) {
  const value = normalize(text);
  if (!value) return true;
  if (PHRASES.has(value)) return true;
  const words = value.split(' ');
  if (words.length <= 2 && words.every((word) => PHRASES.has(word))) return true;
  if (words.length <= MAX_GREETING_WORDS && GREETING_OPENERS.has(words[0])) return true;
  return false;
}

module.exports = { isSocialTurn, SOCIAL_PHRASES };
