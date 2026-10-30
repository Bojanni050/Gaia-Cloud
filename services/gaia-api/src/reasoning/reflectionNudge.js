'use strict';

/**
 * Reflection nudge 0.1 — a small deterministic counter that periodically
 * marks a turn's Hindsight reflection as a nudge turn.
 *
 * Modeled on Hermes' memory nudge interval (hermes-agent
 * `agent/agent_init.py`: `_memory_nudge_interval`, default 10 turns):
 * every N turns the reflection carries an explicit reminder that knowledge
 * worth persisting should be persisted. Hermes nudges its own agent
 * mid-conversation; Gaia's version rides on the post-turn reflection (the
 * Memoryworthiness gate at turn.js step 7), so the live conversation is
 * never touched — the nudge is part of the async deferred phase, matching
 * the Conversatie- vs. Reflectiemaxime.
 *
 * It is NOT a component that reasons: no LLM, no I/O, no state beyond a
 * per-conversation turn count. The ONLY thing it does is answer:
 *
 *   > Is this turn's reflection a nudge turn?
 *
 * The answer travels as `gaia_memory_nudge: "true"` metadata on the
 * reflection (same `gaia_` namespace as the Memoryworthiness metadata),
 * where Hindsight's extractor can read it as "be deliberate about
 * persisting what this turn earned".
 *
 * Boundary: PURE module, no I/O. Counters live in memory; a restart
 * resets them, which is acceptable — a missed nudge only means the next
 * one comes N turns later.
 */

const DEFAULT_NUDGE_INTERVAL = 10;

/**
 * @param {{ everyTurns?: number, now?: Function }} [options]
 * @returns {{ noteTurn: (conversationId: string) => boolean }}
 */
function createReflectionNudge({ everyTurns } = {}) {
  const interval = Number(everyTurns) > 0 ? Math.floor(Number(everyTurns)) : DEFAULT_NUDGE_INTERVAL;
  const counters = new Map(); // conversationId -> turns since last nudge

  /**
   * Notes one retained (non-discarded) turn for a conversation and answers
   * whether this one is a nudge turn. Counting only retained turns keeps
   * the interval honest: discarded turns produce no reflection to nudge.
   * @param {string} conversationId
   * @returns {boolean}
   */
  function noteTurn(conversationId) {
    if (!conversationId || typeof conversationId !== 'string') return false;
    const next = (counters.get(conversationId) || 0) + 1;
    if (next >= interval) {
      counters.set(conversationId, 0);
      return true;
    }
    counters.set(conversationId, next);
    return false;
  }

  return { noteTurn };
}

module.exports = {
  createReflectionNudge,
  DEFAULT_NUDGE_INTERVAL,
};
