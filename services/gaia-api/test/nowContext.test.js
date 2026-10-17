'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatNow, relativeAge, renderNowContext, toDate, DEFAULT_TIME_ZONE } = require('../src/nowContext');

const NOW = Date.parse('2026-10-17T18:42:00Z');

test('formatNow states the Dutch calendar moment in the deployment timezone', () => {
  assert.equal(DEFAULT_TIME_ZONE, 'Europe/Amsterdam');
  assert.equal(formatNow(NOW), 'zaterdag 17 oktober 2026, 20:42 (Europe/Amsterdam)');
  assert.equal(formatNow(NOW, { timeZone: 'UTC' }), 'zaterdag 17 oktober 2026, 18:42 (UTC)');
});

test('formatNow and toDate tolerate unusable input instead of throwing', () => {
  assert.equal(toDate('nonsense'), null);
  assert.equal(toDate(null), null);
  assert.equal(toDate(new Date('nope')), null);
  assert.equal(formatNow('nonsense'), null);
});

test('relativeAge reads calendar days, not elapsed hours', () => {
  // 22:30 UTC is already the next local day — the day, not the hour, decides.
  assert.equal(relativeAge('2026-10-15T22:30:00Z', NOW), 'gisteren');
  assert.equal(relativeAge('2026-10-16T14:00:00Z', NOW), 'gisteren');
  assert.equal(relativeAge('2026-10-15T14:00:00Z', NOW), 'eergisteren');
  assert.equal(relativeAge('2026-10-14T12:00:00Z', NOW), '3 dagen geleden');
});

test('relativeAge covers the coarse bands and the future', () => {
  assert.equal(relativeAge('2026-10-17T18:42:00Z', NOW), 'net');
  assert.equal(relativeAge('2026-10-17T18:12:00Z', NOW), '30 minuten geleden');
  assert.equal(relativeAge('2026-10-17T16:42:00Z', NOW), '2 uur geleden');
  assert.equal(relativeAge('2026-10-07T12:00:00Z', NOW), 'vorige week');
  assert.equal(relativeAge('2026-09-25T12:00:00Z', NOW), '3 weken geleden');
  assert.equal(relativeAge('2026-09-10T12:00:00Z', NOW), 'vorige maand');
  assert.equal(relativeAge('2026-07-09T12:00:00Z', NOW), '3 maanden geleden');
  assert.equal(relativeAge('2025-06-01T12:00:00Z', NOW), 'vorig jaar');
  assert.equal(relativeAge('2024-06-01T12:00:00Z', NOW), '2 jaar geleden');

  assert.equal(relativeAge('2026-10-18T09:00:00Z', NOW), 'morgen');
  assert.equal(relativeAge('2026-10-19T09:00:00Z', NOW), 'overmorgen');
  assert.equal(relativeAge('2026-10-22T09:00:00Z', NOW), 'over 5 dagen');
  assert.equal(relativeAge('2026-10-17T20:00:00Z', NOW), 'later vandaag');
});

test('relativeAge returns null for a missing or unusable timestamp', () => {
  assert.equal(relativeAge(undefined, NOW), null);
  assert.equal(relativeAge(null, NOW), null);
  assert.equal(relativeAge('not a date', NOW), null);
});

test('renderNowContext hands her the moment and forbids guessing the date', () => {
  const block = renderNowContext(NOW);
  assert.match(block, /^Het is nu zaterdag 17 oktober 2026, 20:42 \(Europe\/Amsterdam\)\./);
  assert.match(block, /echte moment van dit gesprek/);
  assert.match(block, /Je hebt zelf geen/);
  assert.match(block, /"3 dagen geleden"/);
  assert.equal(renderNowContext('nonsense'), null);
});
