'use strict';

/**
 * Belief formation — the periodic pass that turns observations into a statement.
 *
 * Why this exists at all: a hypothesis born inside one turn is a claim derived
 * from one recall slice. In one month that produced 206 statements with 206
 * distinct wordings and zero that ever came back — a waiting room, not a
 * lifecycle. A belief is what survives several moments, so the per-turn phase
 * no longer forms one; it leaves observations (services/cognition's
 * `observations` table) carrying the assembled evidence they stood on, and this
 * pass is the only thing that forms a statement.
 *
 * The axis is `sourceRef` — the store-side identity of a cited item, the one
 * field that outlives the turn. Two observations that lean on the same ground
 * are about the same thing even when the model worded them differently, which
 * is exactly what wording-based matching (206 singletons) could not see.
 *
 * The rule, deliberately strict:
 *   ≥ minObservations observations,
 *   from at least two DIFFERENT conversations (twice in one breath proves
 *   nothing),
 *   every one of them citing at least one item with a sourceRef.
 *
 * No model call. The wording comes from the machine's own words — the newest
 * observation in the group — and the belief exists because several moments
 * stood on the same ground, not because a prompt was asked nicely. One less
 * place that can hallucinate; the human still settles it.
 *
 * Never throws, never blocks a turn: same posture as the expiry and
 * soft-promotion passes.
 */

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_MIN_OBSERVATIONS = 2;
const DEFAULT_MAX_AGE_DAYS = 14;
const DEFAULT_LOOKBACK = 200;
// Grounded in more than one conversation, a statement starts AT the review
// threshold: the evidence is what earns the human's attention, and it is the
// person who settles it. Extra sightings add a little, never above 0.9.
const BASE_CONFIDENCE = 0.75;
const CONFIDENCE_STEP = 0.05;
const MAX_CONFIDENCE = 0.9;

function evidenceKeys(observation) {
  const items = Array.isArray(observation && observation.evidence_items) ? observation.evidence_items : [];
  const keys = [];
  for (const item of items) {
    const ref = item && typeof item.sourceRef === 'string' ? item.sourceRef.trim() : '';
    if (ref) keys.push(`ref:${ref}`);
  }
  return keys;
}

function conversationOf(observation) {
  const id = observation && typeof observation.conversation_id === 'string' ? observation.conversation_id.trim() : '';
  return id || null;
}

function normalizeStatement(statement) {
  return String(statement || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The evidence of a whole group, deduped by what it is about: the newest
 * capture of the same sourceRef wins, and an item without a sourceRef is kept
 * only if its local id is new (it still says something a person may read).
 */
function unionEvidence(observations) {
  const byKey = new Map();
  for (const observation of observations) {
    for (const item of Array.isArray(observation.evidence_items) ? observation.evidence_items : []) {
      if (!item || !item.id || typeof item.content !== 'string' || !item.content.trim()) continue;
      const key = item.sourceRef ? `ref:${item.sourceRef}` : `id:${item.id}`;
      const seenAt = Date.parse(item.observedAt || observation.observed_at || '') || 0;
      const previous = byKey.get(key);
      if (!previous || seenAt >= previous.seenAt) byKey.set(key, { seenAt, item });
    }
  }
  return [...byKey.values()].map((entry) => entry.item);
}

function observationsOfAge(rows, { maxAgeDays, now }) {
  const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    const at = Date.parse(row && row.observed_at);
    return Number.isFinite(at) ? at >= cutoff : true;
  });
}

/**
 * Groups observations by shared ground. Union-find over sourceRef keys: two
 * observations end up in one group when any chain of shared refs connects them.
 */
function groupBySharedGround(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter((row) => evidenceKeys(row).length > 0);
  const parent = list.map((_, i) => i);
  const find = (i) => {
    let root = i;
    while (parent[root] !== root) root = parent[root];
    while (parent[i] !== root) { const next = parent[i]; parent[i] = root; i = next; }
    return root;
  };
  const byKey = new Map();
  list.forEach((row, index) => {
    for (const key of evidenceKeys(row)) {
      if (byKey.has(key)) {
        const a = find(byKey.get(key));
        const b = find(index);
        if (a !== b) parent[b] = a;
      } else {
        byKey.set(key, index);
      }
    }
  });
  const groups = new Map();
  list.forEach((row, index) => {
    const root = find(index);
    groups.set(root, [...(groups.get(root) || []), row]);
  });
  return [...groups.values()];
}

function createBeliefFormationScan({
  cognition,
  sink,
  env = process.env,
  intervalMs = Number(env.GAIA_BELIEF_FORMATION_INTERVAL_MS) || DEFAULT_INTERVAL_MS,
  minObservations = Number(env.GAIA_BELIEF_MIN_OBSERVATIONS) || DEFAULT_MIN_OBSERVATIONS,
  maxAgeDays = Number(env.GAIA_BELIEF_MAX_AGE_DAYS) || DEFAULT_MAX_AGE_DAYS,
  lookback = Number(env.GAIA_BELIEF_LOOKBACK) || DEFAULT_LOOKBACK,
  now = Date.now,
  logger = console,
} = {}) {
  if ((env.GAIA_BELIEF_FORMATION || 'true') !== 'true') return null;
  if (!cognition || typeof cognition.listObservations !== 'function') {
    logger.warn?.('[beliefs] formation pass not started: observation store unavailable');
    return null;
  }
  if (!sink || typeof sink.save !== 'function') {
    logger.warn?.('[beliefs] formation pass not started: hypothesis sink unavailable');
    return null;
  }

  let running = false;
  let timer = null;

  async function existingStatements() {
    try {
      const rows = await cognition.listHypotheses({ kind: 'hypothesis' });
      return new Set((Array.isArray(rows) ? rows : []).map((row) => normalizeStatement(row.statement)));
    } catch (_) {
      return new Set();
    }
  }

  /** One pass. Never throws; the caller logs an `{ error }` result like the other workers. */
  async function runOnce() {
    if (running) return { skipped: true };
    running = true;
    try {
      const result = {
        examined: 0, formed: 0, singleConversation: 0, duplicate: 0, failed: 0, ids: [],
      };
      const rows = observationsOfAge(
        await cognition.listObservations({ limit: lookback }),
        { maxAgeDays, now: now() },
      );
      result.examined = rows.length;
      if (rows.length < minObservations) return result;

      const known = await existingStatements();
      for (const group of groupBySharedGround(rows)) {
        if (group.length < minObservations) continue;
        // Independence: the same conversation twice is one moment, not two.
        const conversations = new Set(group.map(conversationOf).filter(Boolean));
        if (conversations.size < 2) {
          result.singleConversation += 1;
          continue;
        }
        const evidence = unionEvidence(group);
        if (evidence.length === 0) continue;

        const newest = group
          .slice()
          .sort((a, b) => (Date.parse(b.observed_at) || 0) - (Date.parse(a.observed_at) || 0))[0];
        const statement = String(newest && newest.statement || '').trim();
        if (!statement) continue;
        if (known.has(normalizeStatement(statement))) {
          result.duplicate += 1;
          continue;
        }

        const confidence = Math.min(MAX_CONFIDENCE, BASE_CONFIDENCE + CONFIDENCE_STEP * (group.length - 2));
        try {
          const record = await sink.save(
            {
              id: `belief-${newest.id}`,
              statement,
              confidence,
              evidenceFor: [],
              evidenceAgainst: [],
              persistence: 'durable',
              method: 'derived',
              scope: 'macro',
              kind: 'hypothesis',
              counterHypothesis: null,
            },
            { evidenceItems: evidence },
          );
          known.add(normalizeStatement(statement));
          result.formed += 1;
          result.ids.push(record && record.id ? record.id : null);
          // Only now does the group stop being open material; a failed mark
          // leaves the observations for the next pass, whose duplicate check
          // keeps the same statement from being formed twice.
          if (record && record.id) {
            try {
              await cognition.markObservationsConsumed({
                ids: group.map((row) => row.id).filter(Boolean),
                hypothesisId: record.id,
              });
            } catch (error) {
              logger.warn?.(`[beliefs] could not close observations for ${record.id}: ${error.message}`);
            }
          }
        } catch (error) {
          result.failed += 1;
          logger.warn?.(`[beliefs] formation failed: ${error.message}`);
        }
      }
      if (result.formed > 0) logger.info?.(`[beliefs] formed ${result.formed} statement(s) from repeated ground`);
      return result;
    } catch (error) {
      logger.error?.(`[beliefs] formation pass failed: ${error.message}`);
      return { error: error.message };
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => { void runOnce(); }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    void runOnce();
    logger.info?.(`[beliefs] formation pass started (every ${intervalMs}ms, min ${minObservations} observations from 2 conversations)`);
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { start, stop, runOnce, enabled: true };
}

module.exports = {
  createBeliefFormationScan,
  DEFAULT_INTERVAL_MS,
  DEFAULT_MIN_OBSERVATIONS,
  DEFAULT_MAX_AGE_DAYS,
  groupBySharedGround,
  unionEvidence,
};
