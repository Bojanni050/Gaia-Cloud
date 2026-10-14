'use strict';

/**
 * The AI-written name of a conversation — one short line that says what the
 * thread is about, in the language the conversation is in.
 *
 * Why this exists: conversationStore.js's own fallback title is literally the
 * opening sentence, truncated (`deriveTitle`). That is an honest last resort,
 * but a list of transcripts reads better with a name someone chose, and the
 * opening sentence is often a question ("kun je even kijken waarom...") rather
 * than a topic. This module is that name-maker and nothing else: given the
 * first user message and Gaia's reply, it asks the SAME generator that just
 * answered the turn for one line, and hands back a plain string — or null.
 *
 * What this module does NOT do: it never touches the transcript (the caller
 * saves), never decides whether a name is wanted (the caller asks), never
 * waits on a deadline (the caller bounds), and never throws. A name that
 * cannot be made is simply a name that is absent; the derived one stands.
 *
 * It is deliberately not a capability, an agent or a second pipeline: one
 * prompt, one string, no tools, no streaming, no memory.
 */

const MAX_TITLE_CHARS = 60;
// How much of each side of the exchange the prompt sees. Enough to name the
// topic, small enough that a pasted document doesn't turn a name into a bill.
const MAX_PROMPT_CHARS = 1200;
// How long a finished turn may wait for its own name before the reply is
// handed over nameless. The title call runs once the reply text exists (a
// name reads better with both sides of the exchange), so this is the only
// latency it ever adds — on a conversation's FIRST turn, with a small prompt
// that is normally back well inside it. Past the deadline the turn finishes
// and the name lands in the transcript afterwards (turn.js), never on the
// stream.
const TITLE_DEADLINE_MS = 2500;

const SYSTEM_PROMPT = [
  'You name conversations so their owner recognises them in a list later.',
  'Reply with ONLY the title: 3 to 6 words, no surrounding quotes, no trailing period, no "Title:" prefix.',
  'Name the subject of the conversation; never repeat a question verbatim, never address the person, never mention Gaia.',
  'Write it in the language the conversation is in.',
].join(' ');

/** Whitespace collapsed to single spaces, trimmed, and capped for a list. */
function oneLine(text, max = MAX_TITLE_CHARS) {
  const collapsed = String(text).replace(/\s+/g, ' ').trim();
  if (!collapsed) return '';
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

/** The first user message, capped — the side of the exchange that states the topic. */
function firstUserText(messages) {
  const first = (Array.isArray(messages) ? messages : []).find(
    (message) => message && message.role === 'user' && typeof message.content === 'string' && message.content.trim() !== ''
  );
  return first ? oneLine(first.content, MAX_PROMPT_CHARS) : '';
}

/**
 * The messages handed to the generator: the naming instruction, then one user
 * message carrying the exchange itself. Null when there is nothing to name
 * (no user message) — the caller then simply keeps the derived title.
 */
function buildTitleMessages(messages, replyText) {
  const person = firstUserText(messages);
  if (!person) return null;
  const reply = typeof replyText === 'string' ? oneLine(replyText, MAX_PROMPT_CHARS) : '';
  const exchange = reply ? `Person: ${person}\n\nGaia: ${reply}` : `Person: ${person}`;
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Name this conversation.\n\n${exchange}` },
  ];
}

/**
 * The model's answer, as a title. Takes the first non-empty line, drops a
 * "Title:"/"Titel:" prefix and surrounding quotes a model sometimes adds
 * anyway, and a trailing period — punctuation is not part of a name. Returns
 * null when nothing usable is left, so an empty or chatty answer can never
 * become a title.
 */
function parseTitle(raw) {
  const text = typeof raw === 'string'
    ? raw
    : raw && typeof raw.content === 'string'
      ? raw.content
      : '';
  if (!text) return null;
  const line = text.split(/\r?\n/).map((part) => part.trim()).find((part) => part.length > 0);
  if (!line) return null;
  const cleaned = oneLine(
    line
      .replace(/^(?:title|titel)\s*[:\-–—]\s*/i, '')
      .replace(/^["'“”‘’«»]+/, '')
      .replace(/["'“”‘’«»]+$/, '')
      .replace(/[.\s]+$/, '')
  );
  return cleaned || null;
}

/**
 * Asks `generator` for a name and returns it, or null. Never throws: this is
 * the one call in a turn whose failure is completely uninteresting, so it is
 * swallowed here rather than by every caller.
 * @param {{ generator?: { generate: Function }, messages?: Array, replyText?: string }} input
 * @returns {Promise<string|null>}
 */
async function generateConversationTitle({ generator, messages, replyText } = {}) {
  try {
    if (!generator || typeof generator.generate !== 'function') return null;
    const titleMessages = buildTitleMessages(messages, replyText);
    if (!titleMessages) return null;
    return parseTitle(await generator.generate(titleMessages));
  } catch (_) {
    return null;
  }
}

/**
 * `promise`'s value, or null once `ms` has passed. The promise itself keeps
 * running — a late answer is the caller's to use (turn.js writes it into the
 * transcript so a slow provider still ends up naming the conversation).
 */
function withDeadline(promise, ms) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), ms);
    promise.then(finish, () => finish(null));
  });
}

module.exports = {
  MAX_TITLE_CHARS,
  MAX_PROMPT_CHARS,
  TITLE_DEADLINE_MS,
  SYSTEM_PROMPT,
  buildTitleMessages,
  parseTitle,
  generateConversationTitle,
  withDeadline,
};
