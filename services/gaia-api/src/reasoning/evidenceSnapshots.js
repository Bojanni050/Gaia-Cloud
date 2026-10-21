'use strict';

/**
 * The one definition of an evidence snapshot.
 *
 * The turn's assembled evidence (reasoning/evidenceAssembler.js) is the only
 * place a turn-local id still means something. Two things want a durable copy
 * of it — a hypothesis's citations and an observation's ground — so the shape
 * is built here, once, and both use it:
 *
 *   { id, source, sourceRef?, observedAt?, content }
 *
 * `id` locates it, `content` is what a person reads, and `sourceRef` +
 * `observedAt` are what let a later pass tell "the same ground, seen again" from
 * "seen twice in the same breath".
 */

/** Lookup of the turn's evidence by its local id. Items without text are useless. */
function indexEvidence(items, observedAt = null) {
  const index = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || item.id == null) continue;
    const content = typeof item.content === 'string' ? item.content.trim() : '';
    if (!content) continue;
    index.set(String(item.id), {
      id: String(item.id),
      source: item.source || null,
      ...(typeof item.sourceRef === 'string' && item.sourceRef.trim() ? { sourceRef: item.sourceRef.trim() } : {}),
      ...(observedAt ? { observedAt } : {}),
      content,
    });
  }
  return index;
}

/** Snapshots for exactly the ids a record cites — nothing more is kept. */
function snapshotsFor(index, ids) {
  if (!index || index.size === 0) return [];
  const snapshots = [];
  const seen = new Set();
  for (const id of Array.isArray(ids) ? ids : []) {
    const key = String(id);
    if (seen.has(key)) continue;
    seen.add(key);
    const item = index.get(key);
    if (item) snapshots.push(item);
  }
  return snapshots;
}

module.exports = { indexEvidence, snapshotsFor };
