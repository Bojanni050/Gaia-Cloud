'use strict';

/**
 * Memory policy — significance gating for recall and reflection. A direct
 * port of gaia-web/src/gaia/state/memoryPolicy.js (same signal groups,
 * same thresholds) — see that file's own comment for the full reasoning
 * (architecture.md §6's "memory policies are explicit contracts", the
 * asymmetry between recall defaulting to skip and reflection defaulting
 * to keep, and why this stays heuristic rather than an LLM judgment).
 *
 * Since 18-10-2026 the recall gate has no length floor any more (a cue decides
 * at any length — see shouldRecall), so this port now differs from gaia-web in
 * that one respect.
 */

const MIN_RECALL_LENGTH = Number(process.env.MEMORY_MIN_RECALL_LENGTH) || 12;
const MIN_REFLECT_LENGTH = Number(process.env.MEMORY_MIN_REFLECT_LENGTH) || 12;

const FILLER_PATTERNS = new Set([
  'ok', 'okay', 'k', 'kk', 'sure', 'yes', 'yep', 'yup', 'no', 'nope',
  'thanks', 'thank you', 'thx', 'ty', 'np', 'cool', 'nice', 'great',
  'got it', 'gotcha', 'lol', 'haha', 'hi', 'hello', 'hey', 'bye',
  'goodnight', 'night', 'welcome', "you're welcome", 'alright',
]);

function normalize(text) {
  return (text || '').trim().toLowerCase().replace(/[.!?,]+$/g, '');
}

function isTrivial(text, minLength) {
  const normalized = normalize(text);
  if (!normalized) return true;
  if (FILLER_PATTERNS.has(normalized)) return true;
  return normalized.length < minLength;
}

function boundary(word) {
  return new RegExp(`\\b${word}\\b`, 'i');
}

function phrase(words) {
  return new RegExp(words.trim().replace(/\s+/g, '\\s+'), 'i');
}

const PAST_REFERENCE_SIGNALS = [
  boundary('remember'), boundary('remind'), boundary('recall'),
  boundary('eerder'), boundary('vorige'),
  phrase('last time'), phrase('previously'),
  phrase('we discussed'), phrase('you said'), phrase('i told you'), phrase('i mentioned'),
  phrase('weet je nog'), phrase('je zei'), phrase('ik vertelde'), phrase('ik zei'),
  // "Wat weet jij over X?" is the canonical memory question, yet it carried no
  // cue at all: "weet je nog" matched, "wat weet je over" did not. On
  // 18-10-2026 a whole conversation about Yassine (21 turns) walked with the
  // gate shut for exactly this reason, and she answered "ik heb niets over
  // Yassine in mijn herinnering" while eleven valid items sat in her own bank.
  // The same hole hid "kun je wel bij het geheugen" — a question about memory
  // itself, where "geheugen" was the only word naming it. So: the memory nouns,
  // the knowing-question phrasings, and their English equivalents.
  boundary('geheugen'), boundary('herinnering'), boundary('herinneringen'),
  boundary('herinner'), boundary('memory'),
  phrase('wat weet je'), phrase('wat weet jij'),
  phrase('weet je wie'), phrase('weet je iets'),
  phrase('do you know'), phrase('what do you know'),
];

const DURABLE_CONTEXT_SIGNALS = [
  'project', 'database', 'databank', 'server', 'deployment', 'deploy',
  'config', 'configuration', 'configuratie', 'decision', 'decided', 'besluit',
  'preference', 'prefer', 'voorkeur', 'setup', 'architecture', 'workflow',
].map(boundary);

function hasSignal(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * Recall gate. The second parameter is an ADDITIVE context object — every
 * existing caller and the lexical signals below behave exactly as before
 * when it is omitted.
 *
 * Memoryworthiness-era addition: IntentIQ may resolve a turn as anchored to
 * shared conversational memory even when its text carries no lexical
 * past-reference cue ("wat was er in juni ook alweer?" right after GAIA
 * herself mentioned juni — the referent is hers, not the user's). That branch
 * only fires when a caller hands in a real decision, and the live turn never
 * does: `turn.js` sets `intentDecision = null` because IntentIQ is not wired
 * into the turn. The only callers that can reach it are the eval cases and the
 * Logos path (the IntentIQ classifier itself has been removed), and it stays
 * as the contract for the day an intent decision is supplied again. Read it as a capability, not as something the live
 * conversation does. Whenever it does fire, the lexical cues are irrelevant.
 * `shape` (stap 4 van "de vraag één keer lezen"): when the caller already read
 * the turn once with `turnShape.readTurn`, that verdict is used as-is instead
 * of reading the same text again here. Both answer the same question — the
 * live turn now reads the question once and every gate listens to that answer.
 *
 * A cue decides, at any length (18-10-2026). The old length floor swallowed
 * exactly the shortest memory questions: `normalize` strips the punctuation, so
 * "weet je nog?" is eleven characters and "geheugen?" is eight — both under the
 * floor of twelve, while the word that names memory sat right there in the
 * sentence. Only an empty turn or a bare acknowledgement is excluded on its own
 * now. `MEMORY_MIN_RECALL_LENGTH` still sets the pattern-retrieval floor in
 * `patternAwareness` and the `trivial` flag in `turnShape`, but it no longer
 * decides this gate.
 * @param {string} query
 * @param {{ intentDecision?: object|null, shape?: object|null }} [context]
 */
/**
 * Asking for HER own view or state — "wat vind jij", "wat houdt je bezig",
 * "hoe gaat het met je". This is the one kind of turn where her own bank
 * (Aion's notes and what she chose to keep) belongs in the recall: measured
 * 18-10-2026, with three banks taking turns her bank claimed three of every
 * nine lines, they carried the highest scores, and they were the noisiest of
 * the nine ("Gebruiker voelt zich trots op haar vermogen…", a kairos episode
 * about opening the start menu) while the facts about Bo sat lower and lost
 * their place. A plain opinion question about the world ("wat vind je van dit
 * plan") does match, and that is intended: he is asking her.
 */
const HER_VIEW_SIGNALS = [
  phrase('wat vind je'), phrase('wat vind jij'), phrase('hoe vind je'),
  phrase('wat denk je'), phrase('wat denk jij'), phrase('wat zou jij'),
  phrase('hoe zie jij'), phrase('hoe kijk jij'),
  phrase('jouw mening'), phrase('jouw gevoel'), phrase('jouw gedachte'),
  phrase('hoe voelt dat voor jou'), phrase('hoe voelt dit voor jou'), phrase('wat doet dat met je'),
  phrase('wat houdt je bezig'), phrase('waar denk je aan'), phrase('wat voel je'),
  phrase('hoe gaat het met je'), phrase('hoe is het met je'),
  phrase('wat heb je zelf onthouden'), phrase('wat heb jij onthouden'), phrase('wat weet je zelf'),
  phrase('what do you think'), phrase('how do you feel'), phrase('your opinion'),
  phrase('your view'), phrase('how do you see'),
];

/**
 * Repair signals — the turn is not asking *about* the past, it is telling her
 * that what she just said is wrong, or that she should have known it. Measured
 * 23-10-2026 on Bo's own conversation, where "Als het goed is, weet je over
 * Pieter dat hij bij mij op visite is geweest en een hond heeft" and "Hoe kom je
 * aan die informatie over Pieter? Want dat is iets wat ik totaal niet herken"
 * both walked with the gate shut: she answered out of background summaries
 * while the fact sat in her own bank.
 *
 * The lesson is that a memory question is not only a question about the past.
 * The two shapes that most reliably need the store are **doubt** ("volgens mij
 * klopt dat niet", "dat is niet wat ik zei") and **a challenge to her memory**
 * ("weet je dat niet meer?", "kan je het je niet herinneren?"), plus the plain
 * knowledge claim that used to be read as small talk: "weet je over Pieter
 * dat…" carries the cue "weet je", and only "weet je nog" was in the list.
 *
 * This is deliberately the widest group in the file, and it accepts a known
 * false positive: "weet je wat, laten we…" is a discourse marker, and it will
 * open the gate. The cost of that mistake is one recall (~900 ms) and a few
 * lines of context; the cost of the opposite mistake was a person insisting
 * three times that she knows something while she kept answering "ik heb niets
 * over Pieter". Bias toward looking.
 */
const REPAIR_SIGNALS = [
  // The knowing-question, not just "weet je nog": "weet je over Pieter dat…",
  // "weet je dat hij een hond heeft", "weet jij wie dat is".
  phrase('weet je'), phrase('weet jij'),
  phrase('je weet toch'), phrase('je zou moeten weten'), phrase('je zou toch moeten weten'),
  phrase('als het goed is weet je'), phrase('dat zou je moeten weten'),
  phrase('kan je het je niet herinneren'), phrase('kun je het je niet herinneren'),
  phrase('kan je het niet herinneren'), phrase('kun je het niet herinneren'),
  phrase('weet je dat niet'), phrase('weet je dat nog'), phrase('dat weet je toch'),
  phrase('dat heb ik je verteld'), phrase('dat heb ik je al verteld'),
  // Doubt and correction of what she just said.
  phrase('klopt niet'), phrase('klopt dat'), phrase('volgens mij klopt'),
  phrase('niet herken'), phrase('herken ik niet'), phrase('niet bekend voor'),
  phrase('dat is niet wat ik'), phrase('dat heb ik nooit gezegd'),
  phrase('dat heb ik niet gezegd'), phrase('dat zei ik niet'),
  phrase('waar heb je dat vandaan'), phrase('waar komt dat vandaan'),
  phrase('hoe kom je aan die informatie'), phrase('hoe kom je daaraan'),
  phrase('hoe weet je dat'), phrase('waar baseer je dat op'),
  // "Kun je er nog eens naar kijken?" — an explicit request to look again.
  phrase('nog eens naar kijken'), phrase('nog eens kijken'), phrase('nog een keer kijken'),
  phrase('er nog eens naar'), phrase('opnieuw kijken'), phrase('opnieuw naar kijken'),
  phrase('zoek het nog eens'), phrase('zoek nog eens'), phrase('kijk er nog eens'),
  // English equivalents of the same three shapes.
  phrase("can't you remember"), phrase('cannot you remember'),
  phrase('do you not remember'), phrase("don't you remember"),
  phrase('i never said that'), phrase("that's not what i said"), phrase('that is not what i said'),
  phrase('where did you get that'), phrase('how do you know'),
  phrase('look again'), phrase('check again'), phrase('try again'),
];

function shouldRecall(query, context = {}) {
  const shape = context && context.shape;
  if (shape) return Boolean(shape.wantsRecall);
  const text = (query || '').trim();
  const normalized = normalize(text);
  if (!normalized || FILLER_PATTERNS.has(normalized)) return false;
  const intent = context && context.intentDecision;
  if (intent) {
    if (intent.sourceOfTruth === 'memory') return true;
    if (intent.meta && intent.meta.reason === 'assistant_anchored_follow_up_unresolved_intent') return true;
    if (intent.meta && intent.meta.reason === 'assistant_anchored_follow_up_inherited') return true;
  }
  return hasSignal(text, PAST_REFERENCE_SIGNALS)
    || hasSignal(text, DURABLE_CONTEXT_SIGNALS)
    || hasSignal(text, REPAIR_SIGNALS);
}

/**
 * Reflection gate. The optional third parameter is the same ADDITIVE context
 * object as in shouldRecall: with a `shape` the user's half is already judged,
 * so only the answer's half is still read here.
 * @param {string} userText @param {string} assistantText
 * @param {{ shape?: object|null }} [context]
 */
function shouldReflect(userText, assistantText, context = {}) {
  const shape = context && context.shape;
  if (shape) {
    if (shape.reflectable) return true; // the user's half is already past the floor
    if (shape.empty) return false;
  }
  const userTrivial = isTrivial(userText, MIN_REFLECT_LENGTH);
  const assistantTrivial = isTrivial(assistantText, MIN_REFLECT_LENGTH);
  return !(userTrivial && assistantTrivial);
}

const MEMORY_POLICY = Object.freeze({
  minRecallLength: MIN_RECALL_LENGTH,
  minReflectLength: MIN_REFLECT_LENGTH,
});

module.exports = {
  shouldRecall,
  shouldReflect,
  isTrivial,
  MEMORY_POLICY,
  // Additive exports (Memoryworthiness 0.1 reuses the same signal
  // vocabulary instead of duplicating it): FILLER_PATTERNS stays a Set, the
  // two signal groups stay arrays of RegExps — consumers treat them
  // read-only.
  FILLER_PATTERNS,
  PAST_REFERENCE_SIGNALS,
  DURABLE_CONTEXT_SIGNALS,
  REPAIR_SIGNALS,
  HER_VIEW_SIGNALS,
};
