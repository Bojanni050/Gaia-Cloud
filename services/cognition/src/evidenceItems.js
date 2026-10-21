'use strict';

/**
 * Evidence snapshots — the part of a citation that outlives the turn.
 *
 * One entry is `{ id, source, sourceRef?, observedAt?, content }`:
 *   id          the turn-local label Logos used (`hindsight-1`); it is what
 *               evidence_for / evidence_against name, so the card can look the
 *               quote up.
 *   source      where it came from (hindsight | conversation | upload | model).
 *   sourceRef   the store-side identity, when the assembler knew one. Unlike
 *               `id` this survives the turn, which is what makes "the same
 *               thing came back" answerable at all.
 *   observedAt  when it was seen. Two snapshots with the same sourceRef and
 *               different observedAt are the same ground seen twice.
 *   content     what it said. Without this there was nothing to show a person.
 *
 * The relation (supports / contradicts) is NOT stored here: it lives in
 * evidence_for / evidence_against, named by `id`. One place owns it.
 */

/** Drops entries nobody could read: no id, no text, or a repeated id. */
function sanitizeEvidenceItems(items) {
  const seen = new Set();
  const clean = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object') continue;
    const id = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : null;
    const content = typeof item.content === 'string' ? item.content.trim() : '';
    if (!id || !content || seen.has(id)) continue;
    seen.add(id);
    clean.push({
      id,
      source: typeof item.source === 'string' && item.source.trim() ? item.source.trim() : null,
      ...(typeof item.sourceRef === 'string' && item.sourceRef.trim() ? { sourceRef: item.sourceRef.trim() } : {}),
      ...(typeof item.observedAt === 'string' && item.observedAt.trim() ? { observedAt: item.observedAt.trim() } : {}),
      content,
    });
  }
  return clean;
}

/**
 * Merge snapshots by id — a later capture of the same label never duplicates
 * it, and an entry that carries a sourceRef is preferred over one that does not
 * (the richer capture wins, never the emptier one).
 */
function mergeEvidenceItems(existing, incoming) {
  const byId = new Map();
  for (const item of sanitizeEvidenceItems(existing)) byId.set(item.id, item);
  for (const item of sanitizeEvidenceItems(incoming)) {
    const previous = byId.get(item.id);
    if (previous && previous.sourceRef && !item.sourceRef) {
      byId.set(item.id, { ...item, sourceRef: previous.sourceRef });
      continue;
    }
    byId.set(item.id, item);
  }
  return [...byId.values()];
}

module.exports = { sanitizeEvidenceItems, mergeEvidenceItems };
