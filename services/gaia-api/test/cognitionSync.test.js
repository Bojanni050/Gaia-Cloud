'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createCognitionSync } = require('../src/reasoning/cognitionSync');

function fakeHindsight({ seeded = [] } = {}) {
  const retained = [];
  const patches = [];
  const impl = {
    retained,
    patches,
    async retainSync(item) { retained.push(item); },
    async listMemories({ documentId } = {}) {
      if (documentId) {
        const item = retained.find((r) => r.documentId === documentId);
        return item ? [{ id: `fact-${item.documentId}`, metadata: item.metadata, tags: item.tags }] : [];
      }
      return seeded;
    },
    async patchMemoryState(factId, state, reason) { patches.push({ factId, state, reason }); },
  };
  return impl;
}

const hyp = (overrides = {}) => ({
  id: 'h1',
  statement: 'Bo works best late',
  status: 'testing',
  confidence: 0.6,
  kind: 'hypothesis',
  sources: ['foundation:obs1'],
  ...overrides,
});

test('syncHypothesis retains a gaia:hypothesis version with metadata and sources', async () => {
  const hindsight = fakeHindsight();
  const sync = createCognitionSync({ hindsight });

  const res = await sync.syncHypothesis(hyp());

  assert.equal(res.documentId, 'gaia-hyp-h1-v1');
  assert.equal(hindsight.retained[0].context, 'gaia hypothesis');
  assert.deepEqual(hindsight.retained[0].tags, ['gaia:hypothesis']);
  assert.equal(hindsight.retained[0].metadata.gaia_hypothesis_id, 'h1');
  assert.equal(hindsight.retained[0].metadata.gaia_hypothesis_status, 'testing');
  assert.equal(hindsight.retained[0].metadata.gaia_hypothesis_sources, JSON.stringify(['foundation:obs1']));
});

test('a second sync supersedes the previous version', async () => {
  const hindsight = fakeHindsight();
  const sync = createCognitionSync({ hindsight });

  await sync.syncHypothesis(hyp());
  const second = await sync.syncHypothesis(hyp({ status: 'corroborated', confidence: 0.85 }));

  assert.equal(second.documentId, 'gaia-hyp-h1-v2');
  assert.equal(hindsight.patches.length, 1);
  assert.equal(hindsight.patches[0].factId, 'fact-gaia-hyp-h1-v1');
  assert.match(hindsight.patches[0].reason, /superseded by gaia-hyp-h1-v2/);
});

test('a confirmed hypothesis carries both gaia:hypothesis and gaia:confirmed_fact', async () => {
  const hindsight = fakeHindsight();
  const sync = createCognitionSync({ hindsight });

  await sync.syncHypothesis(hyp({ status: 'confirmed' }));

  assert.deepEqual(hindsight.retained[0].tags, ['gaia:hypothesis', 'gaia:confirmed_fact']);
});

test('syncPattern retains a gaia:pattern version', async () => {
  const hindsight = fakeHindsight();
  const sync = createCognitionSync({ hindsight });

  const res = await sync.syncPattern({ id: 'p1', content: 'late nights', status: 'established', confidence: 0.7, sources: ['foundation:o2'] });

  assert.equal(res.documentId, 'gaia-ptn-p1-v1');
  assert.equal(hindsight.retained[0].context, 'gaia pattern');
  assert.deepEqual(hindsight.retained[0].tags, ['gaia:pattern']);
  assert.equal(hindsight.retained[0].metadata.gaia_pattern_id, 'p1');
});

test('reconcile seeds from Hindsight, skips unchanged status, pushes the rest', async () => {
  const seeded = [{ id: 'fact-1', metadata: { gaia_hypothesis_id: 'h1', gaia_hypothesis_version: '1', gaia_hypothesis_status: 'testing' }, tags: ['gaia:hypothesis'] }];
  const hindsight = fakeHindsight({ seeded });
  const cognition = {
    listHypotheses: async () => [hyp({ id: 'h1', status: 'testing' }), hyp({ id: 'h2', status: 'proposed' })],
    listPatterns: async () => [],
  };
  const sync = createCognitionSync({ hindsight, cognition });

  const result = await sync.reconcile();

  assert.equal(result.hypothesesSkipped, 1);
  assert.equal(result.hypothesesPushed, 1);
  // h1 was skipped; only h2 was retained.
  assert.ok(hindsight.retained.some((r) => r.documentId === 'gaia-hyp-h2-v1'));
  assert.ok(!hindsight.retained.some((r) => r.documentId.startsWith('gaia-hyp-h1')));
});

test('reconcile also re-pushes Kairos episodes and skips ones already mirrored', async () => {
  const seeded = [{ id: 'fact-k', metadata: { gaia_kairos_episode_id: 'kei_1', gaia_kairos_episode_version: '1' }, tags: ['gaia:kairos_episode'] }];
  const hindsight = fakeHindsight({ seeded });
  const cognition = {
    listHypotheses: async () => [],
    listPatterns: async () => [],
    listKairosEpisodes: async () => ({
      data: [
        { id: 'kei_1', summary: 'already there', epistemic_status: 'interpretation', sources: ['foundation:a'] },
        { id: 'kei_2', summary: 'new', epistemic_status: 'interpretation', sources: ['foundation:b'] },
      ],
      pagination: { has_more: false },
    }),
  };
  const sync = createCognitionSync({ hindsight, cognition });

  const result = await sync.reconcile();

  assert.equal(result.kairosSkipped, 1);
  assert.equal(result.kairosPushed, 1);
  assert.ok(hindsight.retained.some((r) => r.documentId === 'gaia-kep-kei_2-v1'));
  assert.ok(!hindsight.retained.some((r) => r.documentId.startsWith('gaia-kep-kei_1')));
});

test('reconcile({ clear }) invalidates Kairos episodes too, then re-pushes them', async () => {
  const hindsight = fakeHindsight({
    seeded: [{ id: 'fact-k', metadata: { gaia_kairos_episode_id: 'kei_1', gaia_kairos_episode_version: '1' }, tags: ['gaia:kairos_episode'] }],
  });
  const cognition = {
    listHypotheses: async () => [],
    listPatterns: async () => [],
    listKairosEpisodes: async () => ({
      data: [{ id: 'kei_1', summary: 's', epistemic_status: 'interpretation', sources: ['foundation:x'] }],
      pagination: { has_more: false },
    }),
  };
  const sync = createCognitionSync({ hindsight, cognition });

  const result = await sync.reconcile({ clear: true });

  assert.equal(result.kairosPushed, 1);
  assert.ok(hindsight.patches.some((p) => p.factId === 'fact-k' && p.state === 'invalidated'));
  assert.equal(hindsight.retained[0].metadata.gaia_kairos_episode_sources, JSON.stringify(['foundation:x']));
});

test('invalidateByTags invalidates matching valid units only', async () => {
  const seeded = [
    { id: 'a', metadata: {}, tags: ['gaia:hypothesis'] },
    { id: 'b', metadata: {}, tags: ['foundation:fact'] },
  ];
  const hindsight = fakeHindsight({ seeded });
  const sync = createCognitionSync({ hindsight });

  const count = await sync.invalidateByTags(['gaia:hypothesis', 'gaia:pattern'], 'reconciliation');

  assert.equal(count, 1);
  assert.equal(hindsight.patches[0].factId, 'a');
  assert.equal(hindsight.patches[0].reason, 'reconciliation');
});
