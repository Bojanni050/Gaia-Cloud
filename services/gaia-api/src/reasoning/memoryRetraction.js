'use strict';

/**
 * Taking a memory back.
 *
 * Gaia recited a statement about a person that was not true, apologised, and
 * nothing changed: the statement was still in Hindsight, so she would have
 * said it again. A correction that only lives in an apology is not a
 * correction. This module is the other half of `memory.js`'s kind-marking —
 * marking tells her how much weight an item carries, this lets the person take
 * one away.
 *
 * Three things happen, in this order, and each is independent so a failure in
 * one never blocks the others:
 *
 *   1. the memory unit itself is invalidated in the bank that holds it, so
 *      recall no longer surfaces it (reversible in Hindsight, never deleted —
 *      the person's own history keeps its audit trail);
 *   2. if it came from a derived statement, that statement is retired too
 *      (`verwerp_bron: 'mens'`), because the statement is the SOURCE: leaving
 *      it confirmed means the next mirroring round writes the same text back
 *      into recall as a fresh active fact. This is not hypothetical — see
 *      `hindsightHypothesisAdapter.js`'s `meaningful` version rule;
 *   3. the person's own correction, when they gave one, is kept as a new
 *      statement tagged `gaia:confirmed_fact` — it is theirs, they just said
 *      it, so it is the one kind of memory that may be stated as fact.
 *
 * Matching is deliberately boring: the quote is scored by word overlap against
 * what the banks hold, and anything that is not clearly the best match is
 * reported as ambiguous rather than guessed at. Retracting the wrong memory on
 * a fuzzy match would be a worse failure than not retracting at all.
 *
 * Boundary: this reasons about nothing. The caller decides that a retraction
 * is what the person asked for; this finds, retires and records.
 */

// A quote must share this much of its words with a stored statement before we
// will touch it at all.
const MIN_MATCH = 0.6;
// ... and must beat the runner-up by this much, or we ask instead of acting.
const AMBIGUOUS_MARGIN = 0.15;
const SEARCH_LIMIT = 25;
const CANDIDATE_LIMIT = 5;

/** Lowercase, punctuation flattened, whitespace collapsed. */
function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Words worth comparing — one- and two-letter words carry no signal. */
function tokens(text) {
  return normalizeText(text).split(' ').filter((token) => token.length > 2);
}

/**
 * How much a quote looks like a stored statement, 0..1.
 *
 * Containment counts for almost everything (the person often quotes part of a
 * line, or Gaia quotes the whole line back), word overlap covers the rest.
 * @param {string} quote
 * @param {string} text
 * @returns {number}
 */
function matchScore(quote, text) {
  const needle = normalizeText(quote);
  const haystack = normalizeText(text);
  if (!needle || !haystack) return 0;
  if (haystack.includes(needle)) return 1;
  const wanted = tokens(quote);
  if (wanted.length === 0) return 0;
  const present = new Set(tokens(text));
  let hit = 0;
  for (const token of wanted) if (present.has(token)) hit += 1;
  return hit / wanted.length;
}

/** Hindsight hands metadata back as an object, but a JSON string survives some paths. */
function metadataValue(metadata, key) {
  if (!metadata) return null;
  let bag = metadata;
  if (typeof bag === 'string') {
    try { bag = JSON.parse(bag); } catch (_) { return null; }
  }
  if (!bag || typeof bag !== 'object') return null;
  const value = bag[key];
  return value == null || value === '' ? null : String(value);
}

function publicCandidate(candidate) {
  return { bank: candidate.bank, id: candidate.id, text: candidate.text, score: candidate.score };
}

/**
 * Find the one stored memory a quote points at.
 *
 * Every bank is searched the same way (`listMemories` with the quote as the
 * query) so the same statement is never matched in two banks by accident and
 * the winner's bank travels with it — the caller needs to know WHERE to patch.
 *
 * @param {Array<{name: string, client: object}>} banks
 * @param {string} quote
 * @returns {Promise<{status: 'found'|'ambiguous'|'not_found', target?: object, candidates: Array<object>}>}
 */
async function findRetractionTarget(banks, quote, { limit = SEARCH_LIMIT } = {}) {
  const wanted = String(quote || '').trim();
  if (!wanted || !Array.isArray(banks)) return { status: 'not_found', candidates: [] };

  const hits = [];
  for (const bank of banks) {
    if (!bank || !bank.client || typeof bank.client.listMemories !== 'function') continue;
    let items = [];
    try {
      items = await bank.client.listMemories({ q: wanted, limit });
    } catch (_) {
      continue; // one bank being down drops its slice, never the search
    }
    for (const item of Array.isArray(items) ? items : []) {
      if (!item || item.id == null || !item.text) continue;
      // A unit that is already invalidated is not a memory anyone is reciting.
      if (item.state && item.state !== 'valid') continue;
      const score = matchScore(wanted, item.text);
      if (score < MIN_MATCH) continue;
      hits.push({
        bank: bank.name,
        id: String(item.id),
        text: String(item.text),
        metadata: item.metadata || null,
        tags: Array.isArray(item.tags) ? item.tags : [],
        score,
      });
    }
  }

  hits.sort((a, b) => b.score - a.score || String(a.text).localeCompare(String(b.text)));
  if (hits.length === 0) return { status: 'not_found', candidates: [] };
  const best = hits[0];
  const runnerUp = hits[1];
  if (runnerUp && best.score - runnerUp.score < AMBIGUOUS_MARGIN) {
    return { status: 'ambiguous', candidates: hits.slice(0, CANDIDATE_LIMIT).map(publicCandidate) };
  }
  return { status: 'found', target: best, candidates: hits.slice(0, CANDIDATE_LIMIT).map(publicCandidate) };
}

/**
 * Withdraw one memory from recall, retire its source statement, and keep the
 * person's correction as a confirmed statement of theirs.
 *
 * @param {{ banks?: Array<{name: string, client: object}>, home?: {name: string, client: object},
 *           cognition?: object|null, sync?: object|null, quote: string, correction?: string,
 *           now?: number|Date }} options
 * @returns {Promise<object>} a receipt — never throws
 */
async function retractMemory({
  banks = [],
  home = null,
  cognition = null,
  sync = null,
  quote,
  correction,
  now = Date.now(),
} = {}) {
  const found = await findRetractionTarget(banks, quote);
  if (found.status !== 'found') {
    return { status: found.status, candidates: found.candidates };
  }

  const target = found.target;
  const bank = banks.find((candidate) => candidate && candidate.name === target.bank) || null;
  const at = new Date(now);
  const stamp = Number.isNaN(at.getTime()) ? null : at.toISOString();
  const text = String(correction || '').trim();
  const reason = text
    ? `the person corrected this: ${text}`
    : 'the person said this is not correct';

  // 1. The memory itself.
  let invalidated = false;
  try {
    await bank.client.patchMemoryState(target.id, 'invalidated', reason);
    invalidated = true;
  } catch (_) { /* reported below; nothing else depends on it */ }

  // 2. Its source statement, when it has one — otherwise the next mirroring
  //    round would put the same words back.
  const hypothesisId = metadataValue(target.metadata, 'gaia_hypothesis_id');
  let source = null;
  if (hypothesisId) {
    if (cognition && typeof cognition.rejectHypothesis === 'function') {
      try {
        const record = await cognition.rejectHypothesis(hypothesisId, { reason, verwerpBron: 'mens' });
        source = { kind: 'hypothesis', id: hypothesisId, status: 'rejected' };
        if (sync && typeof sync.syncHypothesis === 'function') {
          try { await sync.syncHypothesis(record); } catch (_) { /* the mirror may lag; the rejection stands */ }
        }
      } catch (_) {
        source = { kind: 'hypothesis', id: hypothesisId, status: 'unchanged' };
      }
    } else {
      source = { kind: 'hypothesis', id: hypothesisId, status: 'unavailable' };
    }
  }

  // 3. What is true instead — the person's words, kept as theirs.
  const keeper = home && home.client && typeof home.client.retainSync === 'function'
    ? home
    : banks.find((candidate) => candidate && candidate.client && typeof candidate.client.retainSync === 'function') || null;
  let kept = null;
  if (text && keeper) {
    try {
      await keeper.client.retainSync({
        content: text,
        context: 'corrected in conversation',
        tags: ['gaia:confirmed_fact', 'gaia:correction'],
        metadata: {
          gaia_corrected_from: target.id,
          gaia_corrected_bank: target.bank,
          ...(stamp ? { gaia_corrected_at: stamp } : {}),
        },
      });
      kept = { bank: keeper.name, text };
    } catch (_) { /* the retraction stands even when the correction cannot be kept */ }
  }

  return {
    status: 'retracted',
    retracted: { bank: target.bank, id: target.id, text: target.text, invalidated },
    source,
    kept,
    at: stamp,
    candidates: found.candidates,
  };
}

/**
 * What the model reads back. English, like the other tool results, and it names
 * the memory that was taken back so the person can see which one it was.
 * @param {object} receipt
 * @returns {string}
 */
function renderRetractionReceipt(receipt) {
  if (!receipt || receipt.status === 'not_found') {
    return 'Nothing in memory matches that closely enough to take back.';
  }
  if (receipt.status === 'ambiguous') {
    const options = (receipt.candidates || []).map((candidate) => `"${candidate.text}"`).join(' / ');
    return `More than one memory matches — say which one: ${options}`;
  }

  const lines = [];
  const retracted = receipt.retracted || {};
  lines.push(`Taken back: "${retracted.text}"${retracted.invalidated === false ? ' (the memory itself could not be updated, so it may still surface)' : ''}`);
  if (receipt.source && receipt.source.status === 'rejected') {
    lines.push('The statement it came from is rejected too, so it cannot come back.');
  } else if (receipt.source && receipt.source.status === 'unchanged') {
    lines.push('The statement it came from could not be rejected — it may come back.');
  } else if (receipt.source && receipt.source.status === 'unavailable') {
    lines.push('The statement it came from is not reachable right now — it may come back.');
  }
  if (receipt.kept) lines.push(`Kept instead: "${receipt.kept.text}"`);
  return lines.join('\n');
}

module.exports = {
  findRetractionTarget,
  retractMemory,
  renderRetractionReceipt,
  matchScore,
  normalizeText,
  MIN_MATCH,
};
