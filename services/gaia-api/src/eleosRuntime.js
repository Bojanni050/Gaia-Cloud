'use strict';

/**
 * Eleos runtime — the half that comes back later.
 *
 * A background tick (the same posture as the research poller and the Kairos
 * worker: setInterval, unref'd, never blocks startup) looks for open loops
 * whose moment has arrived, applies the politeness policy, and — when it may —
 * generates the opening message and writes it into a NEW conversation, so the
 * check-in literally IS Gaia starting a conversation. A client then discovers
 * it through GET /eleos/checkins (src/eleosRoutes.js) and the existing
 * /conversations/events "changed" ping.
 *
 * Policy — the "never noisy" ceiling (PRD: proactivity is earned, tiered and
 * reversible):
 *   - a global cap of at most `maxPerDay` check-ins per rolling 24 hours;
 *   - do not interrupt: a recent turn (within `activeMs`) defers delivery;
 *   - quiet hours: inside the quiet window, delivery waits — UNLESS the person
 *     is themselves active at that hour, which is Bo's explicit exception
 *     ("tenzij gebruiker actief is 's nachts").
 *
 * Every failure is contained: a tick never throws, a missing voice or history
 * store simply leaves a loop pending, and nothing here can break a turn.
 */

const DEFAULT_ACTIVE_MS = 5 * 60 * 1000;
const DEFAULT_TICK_MS = 60 * 1000;
const DEFAULT_DEFER_MS = 30 * 60 * 1000;
const MAX_TITLE_CHARS = 60;

/**
 * The hour-of-day in a given IANA timezone (0-23), falling back to the server's
 * local hour when the zone is unknown. Uses Intl so no date library is needed.
 */
function hourInTz(date, timezone) {
  try {
    const formatted = new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit', hour12: false, timeZone: timezone,
    }).format(date);
    const hour = Number(formatted);
    return Number.isFinite(hour) ? (hour === 24 ? 0 : hour) : date.getHours();
  } catch (_) {
    return date.getHours();
  }
}

/**
 * @param {number} hour 0-23
 * @param {number} start quiet-window start hour (inclusive)
 * @param {number} end   quiet-window end hour (exclusive)
 * @returns {boolean} whether `hour` is inside the quiet window (wraps overnight)
 */
function isQuietHour(hour, start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return false;
  return start < end ? (hour >= start && hour < end) : (hour >= start || hour < end);
}

function titleFromLoop(loop) {
  const summary = loop && loop.summary ? String(loop.summary).replace(/\s+/g, ' ').trim() : '';
  const base = summary || 'Even terugkomen';
  return base.length > MAX_TITLE_CHARS ? `${base.slice(0, MAX_TITLE_CHARS)}…` : base;
}

/**
 * @param {{
 *   store: object,
 *   voice?: { open: Function },
 *   historyStore?: object,
 *   now?: () => Date,
 *   activeMs?: number,
 *   quietStartHour?: number,
 *   quietEndHour?: number,
 *   timezone?: string,
 *   maxPerDay?: number,
 *   tickMs?: number,
 *   deferMs?: number,
 *   setTimer?: Function,
 *   clearTimer?: Function,
 * }} [options]
 */
function createEleosRuntime({
  store,
  voice,
  historyStore,
  now = () => new Date(),
  activeMs = DEFAULT_ACTIVE_MS,
  quietStartHour = 22,
  quietEndHour = 8,
  timezone = 'Europe/Amsterdam',
  maxPerDay = 1,
  tickMs = DEFAULT_TICK_MS,
  deferMs = DEFAULT_DEFER_MS,
  setTimer = setInterval,
  clearTimer = clearInterval,
} = {}) {
  let lastActivityAt = null;
  let timer = null;

  function recordActivity(at = now()) {
    const t = at instanceof Date ? at : new Date(at);
    if (!lastActivityAt || t.getTime() > lastActivityAt.getTime()) lastActivityAt = t;
  }

  function isRecentActivity(at) {
    if (!lastActivityAt) return false;
    return (at.getTime() - lastActivityAt.getTime()) <= activeMs;
  }

  function isQuiet(at) {
    return isQuietHour(hourInTz(at, timezone), quietStartHour, quietEndHour);
  }

  function capReached(at) {
    if (!(maxPerDay > 0)) return false;
    const since = new Date(at.getTime() - 24 * 60 * 60 * 1000);
    return store.countDeliveredSince(since) >= maxPerDay;
  }

  /**
   * Whether a loop may be delivered right now. Pure policy; never throws.
   * @returns {{ deliver: boolean, reason: string }}
   */
  function evaluate(loop, at = now()) {
    const t = at instanceof Date ? at : new Date(at);
    if (capReached(t)) return { deliver: false, reason: 'daily-cap' };
    const active = isRecentActivity(t);
    const quiet = isQuiet(t);
    // Deliver only when it is neither an interruption nor an uninvited night
    // message: not-quiet and idle, OR quiet but the person is up and active.
    if (active && !quiet) return { deliver: false, reason: 'active' };
    if (quiet && !active) return { deliver: false, reason: 'quiet-hours' };
    return { deliver: true, reason: 'ok' };
  }

  /**
   * Generates and writes one check-in as a NEW conversation. @returns {Promise<object>}
   */
  async function deliver(loop, at = now()) {
    if (!voice || typeof voice.open !== 'function') return { skipped: 'no-voice' };
    if (!historyStore || typeof historyStore.saveConversation !== 'function') return { skipped: 'no-history' };
    // The source conversation is context for the opening, nothing more — a
    // store that cannot read it just means a less detailed check-in.
    let recentMessages = [];
    try {
      if (loop.conversationId && typeof historyStore.getConversation === 'function') {
        const conversation = historyStore.getConversation(loop.conversationId);
        recentMessages = Array.isArray(conversation.messages) ? conversation.messages.slice(-6) : [];
      }
    } catch (_) {
      recentMessages = [];
    }
    const opening = await voice.open({ loop, recentMessages });
    if (!opening) return { skipped: 'empty-opening' };
    const conversationId = `eleos-${loop.id}`;
    try {
      historyStore.saveConversation(
        conversationId,
        [{ role: 'assistant', content: opening }],
        { title: titleFromLoop(loop) }
      );
    } catch (_) {
      return { skipped: 'save-failed' };
    }
    store.markDelivered(loop.id, { deliveredConversationId: conversationId, at });
    return { delivered: loop.id, conversationId };
  }

  /** One pass: deliver what is due and allowed, defer the rest. Never throws. */
  async function tick(at = now()) {
    const t = at instanceof Date ? at : new Date(at);
    const results = [];
    let due;
    try {
      due = store.listDue(t);
    } catch (_) {
      return results;
    }
    for (const loop of due) {
      try {
        const verdict = evaluate(loop, t);
        if (!verdict.deliver) {
          store.update(loop.id, { dueAt: new Date(t.getTime() + deferMs).toISOString() });
          results.push({ id: loop.id, deferred: verdict.reason });
          continue;
        }
        results.push(await deliver(loop, t));
      } catch (_) {
        // A single bad loop must never stop the rest or the tick.
      }
    }
    return results;
  }

  /** Starts the tick. Returns a stop() function. */
  function start() {
    if (!(tickMs > 0) || timer) return () => {};
    timer = setTimer(() => { void tick(); }, tickMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return stop;
  }

  function stop() {
    if (timer) {
      try { clearTimer(timer); } catch (_) { /* already gone */ }
      timer = null;
    }
  }

  return {
    recordActivity, isRecentActivity, evaluate, tick, deliver, start, stop,
    isQuiet: () => isQuiet(now()),
    lastActivityAt: () => lastActivityAt,
  };
}

module.exports = {
  createEleosRuntime,
  hourInTz,
  isQuietHour,
  titleFromLoop,
  DEFAULT_ACTIVE_MS,
  DEFAULT_TICK_MS,
  DEFAULT_DEFER_MS,
  MAX_TITLE_CHARS,
};
