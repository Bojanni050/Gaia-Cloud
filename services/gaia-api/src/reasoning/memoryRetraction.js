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
 *   1. every copy of the claim is invalidated in the bank that holds it — the
 *      one the quote matched best, and each further item that is the same
 *      statement said another way (a mirror in another bank, a near-duplicate
 *      written next to it) — so recall no longer surfaces any of it (reversible
 *      in Hindsight, never deleted — the person's own history keeps its audit
 *      trail). One copy left behind is enough for the next turn to recite it,
 *      which is how a retraction fails to stick;
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
 * a fuzzy match would be a worse failure than not retracting at all. What the
 * guard no longer does is mistake a claim kept twice for two claims: hits that
 * are merely the same statement said another way travel together as one
 * cluster, and only a hit OUTSIDE that cluster can make the match ambiguous.
 *
 * Boundary: this reasons about nothing. The caller decides that a retraction
 * is what the person asked for; this finds, retires and records.
 *
 * `forgetMemory` is the same withdrawal with no verdict on truth: the person
 * asked for something to be gone, which is reason enough on its own. Nothing is
 * kept in its place — a memory can be perfectly true and still not belong in
 * recall, and "correct this" is not the verb for that.
 *
 * Both paths share one rule about Hindsight's curation: `world` and `experience`
 * facts can be curated, but an `observation` cannot — it is derived, and it
 * "regenerates from its sources". The claims a person objects to are often
 * exactly those, so a claim stored as an observation is taken back through the
 * facts it was derived from. Nothing is left half-done silently: a copy that
 * could not be reached is named in the receipt.
 */

// A quote must share this much of its words with a stored statement before we
// will touch it at all.
const MIN_MATCH = 0.6;
// ... and must beat the runner-up by this much, or we ask instead of acting.
const AMBIGUOUS_MARGIN = 0.15;
// Two stored statements that look this much like EACH OTHER are the same claim
// said twice — one item mirrored into another bank, or the near-duplicate the
// reasoning layer writes alongside it. They are one thing the person pointed
// at, so they are taken back together: leaving the copies behind is exactly how
// a retraction fails to stick (the person says it is gone, and the next turn
// recites a copy of it). This is deliberately separate from how well a
// statement matches the QUOTE; that is what MIN_MATCH is for.
const SAME_CLAIM = 0.6;
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
 * Are these two stored statements one claim said twice?
 *
 * Symmetric on purpose: the words must line up both ways, so a short line that
 * merely happens to sit inside a longer, DIFFERENT statement is not swallowed.
 * @param {object} a
 * @param {object} b
 * @returns {boolean}
 */
function isSameClaim(a, b) {
  if (a === b) return true;
  if (!a || !b || !a.text || !b.text) return false;
  return matchScore(a.text, b.text) >= SAME_CLAIM && matchScore(b.text, a.text) >= SAME_CLAIM;
}

/**
 * Find every stored memory a quote points at.
 *
 * Every bank is searched the same way (`listMemories` with the quote as the
 * query) so the same statement is never matched in two banks by accident and
 * the winner's bank travels with it — the caller needs to know WHERE to patch.
 *
 * The result carries a `cluster`: the best hit plus every OTHER hit that is the
 * same claim said a different way (see `isSameClaim`). The ambiguity guard looks
 * only at hits outside that cluster, so a claim that is merely stored twice is
 * acted on instead of being held up as a question — while a quote that genuinely
 * fits two different memories is still refused.
 *
 * @param {Array<{name: string, client: object}>} banks
 * @param {string} quote
 * @returns {Promise<{status: 'found'|'ambiguous'|'not_found', target?: object, cluster?: Array<object>, candidates: Array<object>}>}
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
        // What the unit IS decides how it can be taken back: Hindsight curates
        // world/experience facts, while an observation is derived and has to go
        // through its sources.
        type: item.type || null,
        sourceMemoryIds: Array.isArray(item.sourceMemoryIds) ? item.sourceMemoryIds : [],
        score,
      });
    }
  }

  hits.sort((a, b) => b.score - a.score || String(a.text).localeCompare(String(b.text)));
  if (hits.length === 0) return { status: 'not_found', candidates: [] };
  const best = hits[0];
  // The claim the person pointed at, not just the one copy of it that scored
  // highest: every hit that is the same statement said another way comes along.
  const cluster = hits.filter((hit) => isSameClaim(hit, best));
  const others = hits.filter((hit) => !isSameClaim(hit, best));
  const runnerUp = others[0];
  if (runnerUp && best.score - runnerUp.score < AMBIGUOUS_MARGIN) {
    return { status: 'ambiguous', candidates: hits.slice(0, CANDIDATE_LIMIT).map(publicCandidate) };
  }
  return {
    status: 'found',
    target: best,
    cluster,
    candidates: hits.slice(0, CANDIDATE_LIMIT).map(publicCandidate),
  };
}

/**
 * Retire the statement a memory came from, so the next mirroring round cannot
 * write the same words back into recall. Each outcome is named rather than
 * thrown: a statement that cannot be retired is reported so the person hears
 * that it may come back.
 * @param {string} hypothesisId
 * @param {{ cognition?: object|null, sync?: object|null, reason: string }} deps
 * @returns {Promise<{kind: string, id: string, status: 'rejected'|'unchanged'|'unavailable'}>}
 */
async function retireSource(hypothesisId, { cognition = null, sync = null, reason } = {}) {
  if (!(cognition && typeof cognition.rejectHypothesis === 'function')) {
    return { kind: 'hypothesis', id: hypothesisId, status: 'unavailable' };
  }
  try {
    const record = await cognition.rejectHypothesis(hypothesisId, { reason, verwerpBron: 'mens' });
    if (sync && typeof sync.syncHypothesis === 'function') {
      try { await sync.syncHypothesis(record); } catch (_) { /* the mirror may lag; the rejection stands */ }
    }
    return { kind: 'hypothesis', id: hypothesisId, status: 'rejected' };
  } catch (_) {
    return { kind: 'hypothesis', id: hypothesisId, status: 'unchanged' };
  }
}

/**
 * Take one stored unit out of recall.
 *
 * Hindsight curates `world`/`experience` facts; an `observation` cannot be
 * curated directly (its own 400) because it is derived and regenerates from its
 * sources — and a claim worth taking back is very often stored as one. So an
 * observation is withdrawn through the facts it was derived from, which is what
 * actually removes it from recall.
 * @param {{name: string, client: object}|null} bank
 * @param {object} member
 * @param {string} reason
 * @returns {Promise<{invalidated: boolean, via: string[]}>}
 */
async function withdrawOne(bank, member, reason) {
  const client = bank && bank.client;
  if (!client || typeof client.patchMemoryState !== 'function') return { invalidated: false, via: [] };
  const derived = member.type === 'observation'
    && Array.isArray(member.sourceMemoryIds)
    && member.sourceMemoryIds.length > 0;
  const targets = derived ? member.sourceMemoryIds.map(String) : [String(member.id)];
  let invalidated = true;
  const via = [];
  for (const id of targets) {
    try {
      await client.patchMemoryState(id, 'invalidated', reason);
      via.push(id);
    } catch (_) {
      invalidated = false; // named in the receipt; the rest still go
    }
  }
  return { invalidated, via };
}

/**
 * Every copy of the claim, in the bank that holds it: the one the quote matched
 * best, and each further item that is the same statement said another way. All
 * of them go, or the person's "it is gone" is followed by a recital of a
 * surviving copy.
 * @param {Array<object>} cluster
 * @param {Array<{name: string, client: object}>} banks
 * @param {string} reason
 */
async function withdrawCopies(cluster, banks, reason) {
  const withdrawn = [];
  for (const member of cluster) {
    const bank = banks.find((candidate) => candidate && candidate.name === member.bank) || null;
    const result = await withdrawOne(bank, member, reason);
    withdrawn.push({
      bank: member.bank,
      id: member.id,
      text: member.text,
      invalidated: result.invalidated,
      via: result.via,
    });
  }
  return withdrawn;
}

/**
 * Retire the statements the cluster came from — otherwise the next mirroring
 * round would put the same words back. Deduplicated by id, so a claim mirrored
 * into three banks with one source statement retires it once.
 * @param {Array<object>} cluster
 * @param {{ cognition?: object|null, sync?: object|null, reason: string }} deps
 */
async function retireSources(cluster, { cognition = null, sync = null, reason } = {}) {
  const sources = [];
  const retired = new Set();
  for (const member of cluster) {
    const hypothesisId = metadataValue(member.metadata, 'gaia_hypothesis_id');
    if (!hypothesisId || retired.has(hypothesisId)) continue;
    retired.add(hypothesisId);
    sources.push(await retireSource(hypothesisId, { cognition, sync, reason }));
  }
  return sources;
}

/**
 * Withdraw a claim from recall — every copy of it — retire the statements it
 * came from, and keep the person's correction as a confirmed statement of
 * theirs.
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

  const cluster = Array.isArray(found.cluster) && found.cluster.length > 0 ? found.cluster : [found.target];
  const target = cluster[0];
  const at = new Date(now);
  const stamp = Number.isNaN(at.getTime()) ? null : at.toISOString();
  const text = String(correction || '').trim();
  const reason = text
    ? `the person corrected this: ${text}`
    : 'the person said this is not correct';

  // 1. Every copy of the claim, and 2. the statements they came from — both
  //    through the shared withdrawal, so a claim kept once, kept in three banks,
  //    or stored as a derived observation all go the same way.
  const withdrawn = await withdrawCopies(cluster, banks, reason);
  const sources = await retireSources(cluster, { cognition, sync, reason });

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
    retracted: withdrawn[0],
    alsoRetracted: withdrawn.slice(1),
    source: sources[0] || null,
    sources,
    kept,
    at: stamp,
    candidates: found.candidates,
  };
}

/**
 * Forget a claim: take it out of recall because the person asked for that, with
 * no verdict on whether it was ever true — and nothing kept in its place.
 *
 * The retraction path answers "that is not correct"; this answers "I do not
 * want you to have that". A memory can be true and still not belong in recall,
 * and until now the only verb available was the one that demands untruth — so a
 * plain "forget this" had nowhere to go and the memory stayed.
 *
 * @param {{ banks?: Array<{name: string, client: object}>, cognition?: object|null,
 *           sync?: object|null, quote: string, now?: number|Date }} options
 * @returns {Promise<object>} a receipt — never throws
 */
async function forgetMemory({
  banks = [],
  cognition = null,
  sync = null,
  quote,
  now = Date.now(),
} = {}) {
  const found = await findRetractionTarget(banks, quote);
  if (found.status !== 'found') {
    return { status: found.status, candidates: found.candidates };
  }

  const cluster = Array.isArray(found.cluster) && found.cluster.length > 0 ? found.cluster : [found.target];
  const at = new Date(now);
  const stamp = Number.isNaN(at.getTime()) ? null : at.toISOString();
  const reason = 'the person asked for this to be forgotten';

  const withdrawn = await withdrawCopies(cluster, banks, reason);
  const sources = await retireSources(cluster, { cognition, sync, reason });

  return {
    status: 'forgotten',
    forgotten: withdrawn[0],
    alsoForgotten: withdrawn.slice(1),
    source: sources[0] || null,
    sources,
    at: stamp,
    candidates: found.candidates,
  };
}

/**
 * The source-statement lines both receipts share: a claim that came from a
 * derived statement is reported as retired or as something that may come back.
 * @param {object} receipt
 * @returns {string[]}
 */
function sourceLines(receipt) {
  const lines = [];
  if (receipt.source && receipt.source.status === 'rejected') {
    lines.push('The statement it came from is rejected too, so it cannot come back.');
  } else if (receipt.source && receipt.source.status === 'unchanged') {
    lines.push('The statement it came from could not be rejected — it may come back.');
  } else if (receipt.source && receipt.source.status === 'unavailable') {
    lines.push('The statement it came from is not reachable right now — it may come back.');
  }
  const extra = Array.isArray(receipt.sources) ? receipt.sources.slice(1) : [];
  const extraStuck = extra.filter((source) => source.status !== 'rejected').length;
  if (extra.length > 0 && extraStuck === 0) {
    lines.push('The other statements behind it are rejected too.');
  } else if (extraStuck > 0) {
    lines.push('Some of the statements behind it could not be rejected — those may come back.');
  }
  return lines;
}

/**
 * The "+N more copies" line, shared by both receipts.
 * @param {Array<object>} more
 * @param {string} verb past-tense verb, e.g. 'taken back' or 'forgotten'
 * @param {string} stuck noun phrasing for a copy that could not be updated
 * @returns {string|null}
 */
function copiesLine(more, verb, stuck) {
  if (!Array.isArray(more) || more.length === 0) return null;
  const names = more.map((copy) => `"${copy.text}"`).join(' / ');
  const missed = more.some((copy) => copy.invalidated === false);
  const count = `${more.length} more place${more.length === 1 ? '' : 's'}`;
  return `The same thing was kept in ${count} — ${verb}: ${names}${missed ? ` (${stuck})` : ''}`;
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
  const more = copiesLine(receipt.alsoRetracted, 'taken back too', 'one of them could not be updated, so it may still surface');
  if (more) lines.push(more);
  lines.push(...sourceLines(receipt));
  if (receipt.kept) lines.push(`Kept instead: "${receipt.kept.text}"`);
  return lines.join('\n');
}

/**
 * What the model reads back after a plain "forget this" — the same shape as the
 * retraction receipt, without the "kept instead" line: nothing is kept in its
 * place, because the person did not ask for a replacement.
 * @param {object} receipt
 * @returns {string}
 */
function renderForgetReceipt(receipt) {
  if (!receipt || receipt.status === 'not_found') {
    return 'Nothing in memory matches that closely enough to forget.';
  }
  if (receipt.status === 'ambiguous') {
    const options = (receipt.candidates || []).map((candidate) => `"${candidate.text}"`).join(' / ');
    return `More than one memory matches — say which one to forget: ${options}`;
  }

  const lines = [];
  const forgotten = receipt.forgotten || {};
  lines.push(`Forgotten: "${forgotten.text}"${forgotten.invalidated === false ? ' (it could not be updated, so it may still surface)' : ''}`);
  const more = copiesLine(receipt.alsoForgotten, 'forgotten too', 'one of them could not be updated, so it may still surface');
  if (more) lines.push(more);
  lines.push(...sourceLines(receipt));
  return lines.join('\n');
}

module.exports = {
  findRetractionTarget,
  retractMemory,
  forgetMemory,
  renderRetractionReceipt,
  renderForgetReceipt,
  matchScore,
  normalizeText,
  isSameClaim,
  MIN_MATCH,
  SAME_CLAIM,
};
