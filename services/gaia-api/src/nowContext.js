'use strict';

/**
 * The one place Gaia is told what time it actually is, plus the relative-age
 * helper that keeps recalled context honest about "how long ago".
 *
 * Why this exists: nothing in the assembled prompt carried a date, so Gaia
 * answered "what is today's date?" from her training prior — plausible, and
 * wrong. She has no clock of her own, so the moment of the conversation has to
 * be handed to her, exactly once, in her own frame (Europe/Amsterdam by
 * default — the same timezone the rest of the service already assumes, see
 * eleosRuntime.js).
 *
 * The relative ages are computed from event time, never from "now" drifting
 * with the renderer: every function takes `now` explicitly (defaulting to
 * Date.now()) so callers share one coherent clock per turn.
 */

const DEFAULT_TIME_ZONE = process.env.GAIA_TIME_ZONE || 'Europe/Amsterdam';
const DAY_MS = 24 * 60 * 60 * 1000;

function resolveTimeZone(options) {
  const timeZone = options && options.timeZone;
  return timeZone || DEFAULT_TIME_ZONE;
}

/**
 * Coerces the shapes timestamps actually arrive in (ISO string from Hindsight,
 * epoch ms, Date) into a valid Date, or null. Never throws on junk.
 * @param {Date|number|string|null|undefined} when
 * @returns {Date|null}
 */
function toDate(when) {
  if (when instanceof Date) return Number.isNaN(when.getTime()) ? null : when;
  if (typeof when === 'number') return Number.isFinite(when) ? new Date(when) : null;
  if (typeof when === 'string' && when.trim()) {
    const parsed = new Date(when);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

/** YYYY-MM-DD in the given zone (en-CA formats exactly that way). */
function localDay(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/**
 * The calendar-day number in the given zone. Comparing day indexes rather than
 * elapsed hours keeps "gisteren" meaning yesterday on the calendar — a memory
 * from 23:50 is "gisteren" at 00:10, not "20 minuten geleden" stretched into
 * the wrong day, and it survives DST (23- and 25-hour days).
 */
function dayIndex(date, timeZone) {
  const parsed = Date.parse(`${localDay(date, timeZone)}T00:00:00Z`);
  return Number.isNaN(parsed) ? null : Math.floor(parsed / DAY_MS);
}

function plural(count, singular, pluralForm) {
  return count === 1 ? singular : pluralForm;
}

/**
 * e.g. "zaterdag 17 oktober 2026, 18:42 (Europe/Amsterdam)". Null when `now`
 * is unusable or the runtime rejects the timezone.
 * @param {Date|number|string} [now]
 * @param {{ timeZone?: string }} [options]
 * @returns {string|null}
 */
function formatNow(now = Date.now(), options = {}) {
  const date = toDate(now);
  if (!date) return null;
  const timeZone = resolveTimeZone(options);
  try {
    const day = date.toLocaleDateString('nl-NL', {
      timeZone,
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
    const time = date.toLocaleTimeString('nl-NL', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
    });
    return `${day}, ${time} (${timeZone})`;
  } catch (_) {
    return null;
  }
}

/**
 * Dutch relative age — "gisteren", "3 dagen geleden", "vorige maand". Null when
 * the timestamp is unusable, which is what keeps timestamp-less recall
 * rendering byte-identical to before.
 * @param {Date|number|string} when
 * @param {Date|number|string} [now]
 * @param {{ timeZone?: string }} [options]
 * @returns {string|null}
 */
function relativeAge(when, now = Date.now(), options = {}) {
  const date = toDate(when);
  const reference = toDate(now);
  if (!date || !reference) return null;
  const timeZone = resolveTimeZone(options);

  const from = dayIndex(date, timeZone);
  const to = dayIndex(reference, timeZone);
  if (from == null || to == null) return null;

  const dayDelta = from - to;
  const elapsedMs = reference.getTime() - date.getTime();

  if (dayDelta > 0) {
    if (dayDelta === 1) return 'morgen';
    if (dayDelta === 2) return 'overmorgen';
    return `over ${dayDelta} dagen`;
  }

  if (dayDelta === 0) {
    if (elapsedMs < 0) return 'later vandaag';
    if (elapsedMs < 90 * 1000) return 'net';
    const minutes = Math.floor(elapsedMs / (60 * 1000));
    if (minutes < 60) return `${minutes} ${plural(minutes, 'minuut', 'minuten')} geleden`;
    const hours = Math.floor(elapsedMs / (60 * 60 * 1000));
    return `${hours} ${plural(hours, 'uur', 'uur')} geleden`;
  }

  const days = -dayDelta;
  if (days === 1) return 'gisteren';
  if (days === 2) return 'eergisteren';
  if (days < 7) return `${days} ${plural(days, 'dag', 'dagen')} geleden`;
  if (days < 14) return 'vorige week';
  if (days < 30) return `${Math.round(days / 7)} weken geleden`;
  if (days < 45) return 'vorige maand';
  if (days < 365) {
    const months = Math.max(1, Math.round(days / 30));
    return `${months} ${plural(months, 'maand', 'maanden')} geleden`;
  }
  if (days < 730) return 'vorig jaar';
  const years = Math.max(1, Math.round(days / 365));
  return `${years} ${plural(years, 'jaar', 'jaar')} geleden`;
}

/**
 * The "now" system block. Dutch, because the person she talks to is Dutch and
 * this is prose she is meant to inhabit, not a data record. Null when `now` is
 * unusable, so a broken clock degrades to today's behaviour instead of
 * blocking the turn.
 * @param {Date|number|string} [now]
 * @param {{ timeZone?: string }} [options]
 * @returns {string|null}
 */
function renderNowContext(now = Date.now(), options = {}) {
  const formatted = formatNow(now, options);
  if (!formatted) return null;
  return [
    `Het is nu ${formatted}.`,
    '',
    'Dit is het echte moment van dit gesprek — jouw anker voor "vandaag",',
    '"gisteren", "deze week" en voor hoe lang geleden iets is. Je hebt zelf geen',
    'klok en kunt de datum niet uit je eigen kennis afleiden: ga uit van wat hier',
    'staat, nooit van wat je denkt dat het is.',
    '',
    'Staat er bij een herinnering of een eerder gesprek een leeftijd',
    '("3 dagen geleden", "vorige maand"), dan is dat de werkelijke afstand tot',
    'nu. Gebruik die en schat zelf niets.',
  ].join('\n');
}

module.exports = {
  DEFAULT_TIME_ZONE,
  toDate,
  formatNow,
  relativeAge,
  renderNowContext,
};
