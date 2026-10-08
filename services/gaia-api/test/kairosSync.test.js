'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createCognitionSync, KAIROS_TAG } = require('../src/reasoning/cognitionSync');

function fakeHindsight({ seeded = [] } = {}) {
  const retained = [];
  const patches = [];
  return {
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
}

const episode = (overrides = {}) => ({
  id: 'kei_gaia_cluster_a_b',
  summary: 'Bojan las en beantwoordde een e-mail.',
  start_time: '2026-10-04T10:00:00.000Z',
  end_time: '2026-10-04T10:02:00.000Z',
  primary_app: 'Outlook',
  involved_apps: ['Outlook'],
  epistemic_status: 'interpretation',
  sources: ['foundation:obs1', 'foundation:obs2'],
  ...overrides,
});

test('syncKairosEpisode mirrors a gaia:kairos_episode version with provenance', async () => {
  const hindsight = fakeHindsight();
  const sync = createCognitionSync({ hindsight });

  const res = await sync.syncKairosEpisode(episode());

  assert.equal(res.documentId, 'gaia-kep-kei_gaia_cluster_a_b-v1');
  assert.equal(hindsight.retained[0].context, 'gaia kairos episode');
  assert.deepEqual(hindsight.retained[0].tags, [KAIROS_TAG]);
  assert.equal(hindsight.retained[0].content, 'Bojan las en beantwoordde een e-mail.');
  assert.equal(hindsight.retained[0].metadata.gaia_kairos_episode_status, 'interpretation');
  assert.equal(
    hindsight.retained[0].metadata.gaia_kairos_episode_sources,
    JSON.stringify(['foundation:obs1', 'foundation:obs2']),
  );
});

test('re-syncing the same kairos episode supersedes the previous version', async () => {
  const hindsight = fakeHindsight();
  const sync = createCognitionSync({ hindsight });

  await sync.syncKairosEpisode(episode());
  const second = await sync.syncKairosEpisode(episode());

  assert.equal(second.documentId, 'gaia-kep-kei_gaia_cluster_a_b-v2');
  assert.equal(hindsight.patches.length, 1);
  assert.equal(hindsight.patches[0].factId, 'fact-gaia-kep-kei_gaia_cluster_a_b-v1');
  assert.equal(hindsight.patches[0].state, 'invalidated');
});

test('syncKairosEpisode ignores a record with no id', async () => {
  const hindsight = fakeHindsight();
  const sync = createCognitionSync({ hindsight });
  assert.equal(await sync.syncKairosEpisode(null), null);
  assert.equal(hindsight.retained.length, 0);
});
