'use strict';

/**
 * Open-question reach — the one place where Gaia decides to put a question of
 * her own back on the table.
 *
 * Open questions are identified and kept (kind `open_question`, with the shape
 * the person answers them in) and until now they were never asked: the begrip
 * panel shows them, the person answers them there. This module is the narrow
 * exception the person asked for. During a turn she may raise at most ONE
 * unanswered question:
 *
 *   - in the conversation it came from, or in a new conversation about the same
 *     subject (the caller hands us the questions this turn actually reached);
 *   - mid-conversation is fine — it does not have to be a turn about it;
 *   - at most three times per question, and never twice within the retry term,
 *     so she cannot nag;
 *   - never more than one per turn.
 *
 * The decision is pure (no I/O, no clock of its own): the caller gathers the
 * candidates and stamps the chosen one through the ordinary Cognition client.
 * Raising a question changes nothing about it — it stays open, the person
 * answers it in the panel, or it simply keeps waiting.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETRY_DAYS = 7;
const DEFAULT_MAX_RAISES = 3;

/** How long between two raises of the same question, and how often in total. */
function readReachPolicy(env = process.env) {
  const days = Number(env.GAIA_OPEN_QUESTION_RETRY_DAYS);
  const max = Number(env.GAIA_OPEN_QUESTION_MAX);
  return {
    retryDays: Number.isFinite(days) && days >= 0 ? days : DEFAULT_RETRY_DAYS,
    maxRaises: Number.isFinite(max) && max > 0 ? max : DEFAULT_MAX_RAISES,
  };
}

/** The provenance marker the retention writes (`sources: ['conversation:<id>']`). */
function conversationSource(conversationId) {
  return `conversation:${conversationId}`;
}

/** A Cognition row (snake_case) → the shape the picker reads. */
function fromQuestionRow(row) {
  return {
    id: String(row.id),
    statement: row.statement,
    kind: row.kind || 'open_question',
    questionShape: row.question_shape || row.questionShape || 'open',
    questionOptions: row.question_options || row.questionOptions || [],
    sources: Array.isArray(row.sources) ? row.sources : [],
    raisedCount: Number(row.raised_count != null ? row.raised_count : row.raisedCount) || 0,
    raisedAt: row.raised_at || row.raisedAt || null,
    answeredAt: row.answered_at || row.answeredAt || null,
  };
}

/**
 * May this question be raised again at all? Answered questions never, and a
 * question that has had its attempts is done.
 */
function canRaise(question, { retryDays, maxRaises } = {}, now = Date.now()) {
  if (!question) return false;
  if (question.answeredAt || question.answered_at) return false;
  const raised = Number(question.raisedCount != null ? question.raisedCount : question.raised_count) || 0;
  if (raised >= maxRaises) return false;
  if (raised === 0) return true;
  // A raise is on record: only after the term may she bring it up again. An
  // unreadable moment counts as "just now" — refusing is the safe side, since
  // the alternative is asking again on the strength of a broken timestamp.
  const last = Date.parse(question.raisedAt || question.raised_at || '');
  if (!Number.isFinite(last)) return false;
  return now - last >= retryDays * DAY_MS;
}

/** Did this question come from the conversation we are in? */
function fromConversation(question, conversationId) {
  if (conversationId == null || !question) return false;
  const sources = question.sources || [];
  return Array.isArray(sources) && sources.includes(conversationSource(conversationId));
}

/** Did this question come from a conversation at all? */
function hasProvenance(question) {
  const sources = (question && question.sources) || [];
  return Array.isArray(sources) && sources.some((source) => String(source || '').startsWith('conversation:'));
}

// Words that say nothing about the subject. Deliberately crude: this gate may
// only ever let FEWER questions through, so being conservative is safe.
const EMPTY_WORDS = new Set([
  'de', 'het', 'een', 'en', 'of', 'maar', 'want', 'dat', 'die', 'dit', 'deze', 'is', 'was', 'zijn', 'waren',
  'wordt', 'worden', 'kan', 'kunnen', 'moet', 'moeten', 'mag', 'wil', 'wilt', 'zal', 'zou', 'heeft', 'hebben',
  'niet', 'geen', 'wel', 'ook', 'nog', 'als', 'dan', 'toen', 'over', 'voor', 'van', 'aan', 'bij', 'met', 'uit',
  'er', 'het', 'je', 'jij', 'ik', 'hij', 'zij', 'wij', 'ze', 'mijn', 'jouw', 'haar', 'hem', 'wat', 'wie', 'waar',
  'wanneer', 'hoe', 'waarom', 'the', 'and', 'that', 'this', 'is', 'are', 'was', 'with', 'for', 'from', 'you',
  'your', 'she', 'her', 'him', 'what', 'who', 'where', 'when', 'how', 'why', 'does', 'did',
]);

/** The significant words of a text, for the topical overlap test. */
function words(text) {
  const found = String(text || '').toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) || [];
  return new Set(found.filter((word) => !EMPTY_WORDS.has(word)));
}

/** Do these two texts talk about the same thing, roughly? */
function overlaps(a, b) {
  const left = words(a);
  if (left.size === 0) return false;
  for (const word of words(b)) {
    if (left.has(word)) return true;
  }
  return false;
}

/**
 * Pick at most one question to raise, or null.
 *
 * The gate is deliberately narrow, because the seam hands over every open
 * question the store holds rather than a relevance-filtered list: a question
 * from this very conversation is always allowed; a question from ANOTHER
 * conversation only when it actually overlaps what is being talked about right
 * now ("ook in een nieuw gesprek over hetzelfde onderwerp"); and a question
 * with no provenance at all — anything kept before that provenance existed —
 * is never raised here, though it stays visible and answerable in the begrip
 * panel. Raising the wrong question from an earlier context is exactly what
 * this restraint exists to avoid.
 */
function pickOpenQuestion(candidates, { conversationId = null, policy, now = Date.now(), turnText = '' } = {}) {
  const { retryDays, maxRaises } = { ...readReachPolicy(), ...(policy || {}) };
  const allowed = (Array.isArray(candidates) ? candidates : [])
    .filter((question) => canRaise(question, { retryDays, maxRaises }, now));
  if (allowed.length === 0) return null;

  const here = allowed.find((question) => fromConversation(question, conversationId));
  if (here) return here;

  if (!turnText) return null;
  return allowed
    .filter((question) => hasProvenance(question))
    .find((question) => overlaps(question.statement, turnText)) || null;
}

/**
 * The block that lets her raise it — permission, not an instruction: she may
 * leave it, and she never turns the turn into an interrogation. The shape is
 * named so the answer lands the same way it would in the panel.
 */
function renderOpenQuestionRaise(question) {
  const shape = question.questionShape || 'open';
  const options = Array.isArray(question.questionOptions) ? question.questionOptions : [];
  const shapeNote = shape === 'yes_no'
    ? ' (een ja/nee-vraag)'
    : (shape === 'choice' && options.length > 0 ? ` (keuzes: ${options.join(', ')})` : '');
  return [
    'Je zit nog met een eigen vraag die je nooit hebt gesteld:',
    `"${question.statement}"${shapeNote}`,
    'Je mag hem nu één keer op tafel leggen — in je eigen stem, in één of twee',
    'zinnen, zonder er een verhoor van te maken. Past hij niet in dit gesprek,',
    'laat hem dan liggen; dan komt hij een andere keer terug. Antwoorden hoeft',
    'niet meteen — het paneel blijft ervoor open.',
  ].join('\n');
}

module.exports = {
  readReachPolicy,
  conversationSource,
  fromQuestionRow,
  canRaise,
  fromConversation,
  pickOpenQuestion,
  renderOpenQuestionRaise,
  DAY_MS,
  DEFAULT_RETRY_DAYS,
  DEFAULT_MAX_RAISES,
};
