'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseArgs, classify, survey, render, lapseLegacy, runSurvey } = require('../scripts/survey-legacy-hypotheses');

function row(overrides = {}) {
  return {
    id: 'h1',
    statement: 'They prefer short answers.',
    confidence: 0.5,
    status: 'proposed',
    kind: 'hypothesis',
    created_at: '2026-09-01T10:00:00Z',
    updated_at: '2026-09-01T10:00:00Z',
    evidence_for: [],
    evidence_against: [],
    evidence_items: [],
    ...overrides,
  };
}

function harness(rows) {
  const calls = { listed: [], expired: [] };
  const cognition = {
    listHypotheses: async (query) => {
      calls.listed.push(query);
      return rows;
    },
    expireHypothesis: async (id) => { calls.expired.push(id); return { id, status: 'expired' }; },
  };
  return { cognition, calls };
}

test('parseArgs: default is dry-run, --apply flips it', () => {
  assert.deepEqual(parseArgs([]), { apply: false });
  assert.deepEqual(parseArgs(['--apply']), { apply: true });
  assert.deepEqual(parseArgs(['--apply', '--something-else']), { apply: true });
});

test('classify: a record with evidence text is current', () => {
  assert.equal(classify(row({ evidence_items: [{ id: 'hindsight-1', content: 'They asked for short answers.' }] })), 'current');
});

test('classify: no items and no refs is legacy_no_ground', () => {
  assert.equal(classify(row()), 'legacy_no_ground');
});

test('classify: refs without items is legacy_refs_without_text', () => {
  assert.equal(classify(row({ evidence_for: ['hindsight-1'] })), 'legacy_refs_without_text');
  assert.equal(classify(row({ evidence_against: ['turn-2'] })), 'legacy_refs_without_text');
});

test('survey: only proposed hypotheses are listed, legacy split by category', async () => {
  const { cognition, calls } = harness([
    row({ id: 'current-1', evidence_items: [{ id: 'hindsight-1', content: 'text kept' }] }),
    row({ id: 'legacy-1' }),
    row({ id: 'legacy-2', evidence_for: ['hindsight-9'] }),
  ]);
  const result = await survey({ cognition, log: () => {} });
  assert.deepEqual(calls.listed, [{ status: 'proposed', kind: 'hypothesis' }]);
  assert.equal(result.examined, 3);
  assert.deepEqual(result.byCategory, { current: 1, legacy_no_ground: 1, legacy_refs_without_text: 1 });
  assert.deepEqual(result.legacy.map((r) => r.id), ['legacy-1', 'legacy-2']);
});

test('survey: legacy list is oldest-first', async () => {
  const { cognition } = harness([
    row({ id: 'newer', created_at: '2026-10-01T00:00:00Z' }),
    row({ id: 'older', created_at: '2026-08-01T00:00:00Z' }),
  ]);
  const result = await survey({ cognition, log: () => {} });
  assert.deepEqual(result.legacy.map((r) => r.id), ['older', 'newer']);
});

test('render: current records are never listed for lapsing', async () => {
  const { cognition } = harness([
    row({ id: 'current-1', statement: 'Kept because it has evidence text.', evidence_items: [{ id: 'e1', content: 'x' }] }),
    row({ id: 'legacy-1', statement: 'No ground at all.' }),
  ]);
  const result = await survey({ cognition, log: () => {} });
  const out = render(result);
  assert.match(out, /legacy 1/);
  assert.match(out, /legacy-1/);
  assert.doesNotMatch(out, /current-1/);
  assert.match(out, /never written/);
});

test('render: empty legacy set says so', () => {
  const out = render({ examined: 2, byCategory: { current: 2, legacy_no_ground: 0, legacy_refs_without_text: 0 }, legacy: [] });
  assert.match(out, /No legacy records/);
});

test('lapseLegacy: expires every legacy record, never a current one', async () => {
  const { cognition, calls } = harness([]);
  const legacy = [
    { id: 'legacy-1', category: 'legacy_no_ground' },
    { id: 'legacy-2', category: 'legacy_refs_without_text' },
  ];
  const result = await lapseLegacy({ cognition, legacy, log: () => {} });
  assert.deepEqual(result, { expired: 2, failed: 0, ids: ['legacy-1', 'legacy-2'] });
  assert.deepEqual(calls.expired, ['legacy-1', 'legacy-2']);
});

test('lapseLegacy: a failing expire is counted, not thrown', async () => {
  const { cognition } = harness([]);
  cognition.expireHypothesis = async (id) => {
    if (id === 'bad') throw new Error('cognition responded 500');
    return { id };
  };
  const result = await lapseLegacy({ cognition, legacy: [{ id: 'ok' }, { id: 'bad' }], log: () => {} });
  assert.equal(result.expired, 1);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.ids, ['ok']);
});

test('runSurvey: dry run never writes', async () => {
  const { cognition, calls } = harness([row({ id: 'legacy-1' })]);
  const logs = [];
  const result = await runSurvey({ argv: [], deps: { cognition }, log: (l) => logs.push(l) });
  assert.equal(result.apply, false);
  assert.equal(result.lapsed, null);
  assert.deepEqual(calls.expired, []);
  assert.match(logs.join('\n'), /dry run — nothing written/);
});

test('runSurvey: --apply lapses exactly the legacy records', async () => {
  const { cognition, calls } = harness([
    row({ id: 'current-1', evidence_items: [{ id: 'e1', content: 'kept' }] }),
    row({ id: 'legacy-1' }),
    row({ id: 'legacy-2', evidence_for: ['hindsight-9'] }),
  ]);
  const result = await runSurvey({ argv: ['--apply'], deps: { cognition }, log: () => {} });
  assert.equal(result.apply, true);
  assert.deepEqual(result.lapsed.ids.sort(), ['legacy-1', 'legacy-2']);
  assert.deepEqual(calls.expired.sort(), ['legacy-1', 'legacy-2']);
});
