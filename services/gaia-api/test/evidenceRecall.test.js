'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  EVIDENCE_MIN_SCORE,
  MAX_EVIDENCE_REFS,
  parseSourceList,
  reflectionSourceIds,
  passesEvidenceGate,
  selectEvidenceReflections,
  collectSourceRefs,
  planEvidenceRecall,
  observationId,
  observationText,
  fetchEvidenceForReflections,
} = require('../src/reasoning/evidenceRecall');

function recalled(id, text, final, metadata) {
  return { id, text, scores: { final }, metadata };
}

const hypSources = (refs) => ({ gaia_hypothesis_sources: JSON.stringify(refs) });

test('parseSourceList accepts a JSON string, an array, and shrugs off everything else', () => {
  assert.deepEqual(parseSourceList('["a","b"]'), ['a', 'b']);
  assert.deepEqual(parseSourceList(['a']), ['a']);
  assert.deepEqual(parseSourceList('not json'), []);
  assert.deepEqual(parseSourceList('{"a":1}'), []); // object, not a list
  assert.deepEqual(parseSourceList(''), []);
  assert.deepEqual(parseSourceList(null), []);
  assert.deepEqual(parseSourceList(undefined), []);
});

test('reflectionSourceIds reads all three source keys, dedupes, keeps only Foundation refs', () => {
  const reflection = recalled('h1', 'x', 0.9, {
    gaia_hypothesis_sources: JSON.stringify(['foundation:obs-1', 'chronicle:ingest:obs-2']),
    gaia_pattern_sources: JSON.stringify(['foundation:obs-1', 'not-a-ref', 'chronicle:obs-3']),
    gaia_kairos_episode_sources: JSON.stringify(['foundation:obs-2']),
  });
  // obs-1 deduped; legacy chronicle: shapes resolve through the shared seam.
  assert.deepEqual(reflectionSourceIds(reflection), ['obs-1', 'obs-2', 'obs-3']);
});

test('reflectionSourceIds is empty without metadata and never throws on junk', () => {
  assert.deepEqual(reflectionSourceIds({ id: 'h1', text: 'x' }), []);
  assert.deepEqual(reflectionSourceIds(null), []);
  assert.deepEqual(reflectionSourceIds(recalled('h1', 'x', 0.9, { gaia_hypothesis_sources: '[[[' })), []);
});

test('passesEvidenceGate holds items below the score, opens on pastReference', () => {
  assert.equal(passesEvidenceGate(recalled('h1', 'x', EVIDENCE_MIN_SCORE)), true);
  assert.equal(passesEvidenceGate(recalled('h1', 'x', EVIDENCE_MIN_SCORE - 0.01)), false);
  assert.equal(passesEvidenceGate(recalled('h1', 'x', null)), false);
  assert.equal(passesEvidenceGate(recalled('h1', 'x', 0.1), { pastReference: true }), true);
});

test('selectEvidenceReflections keeps only items with sources that clear the gate', () => {
  const withSources = recalled('h1', 'strong', 0.9, hypSources(['foundation:obs-1']));
  const noSources = recalled('h2', 'plain memory', 0.95);
  const weak = recalled('h3', 'weak match', 0.4, hypSources(['foundation:obs-2']));

  assert.deepEqual(selectEvidenceReflections([withSources, noSources, weak]), [withSources]);
  // pastReference drops the score threshold, but provenance is still required.
  assert.deepEqual(selectEvidenceReflections([withSources, noSources, weak], { pastReference: true }), [withSources, weak]);
});

test('collectSourceRefs caps the fetch budget and maps sources back to their item', () => {
  const reflections = [
    recalled('h1', 'a', 0.9, hypSources(['foundation:obs-1'])),
    recalled('h2', 'b', 0.9, hypSources(['foundation:obs-2', 'foundation:obs-1'])),
    recalled('h3', 'c', 0.9, hypSources(['foundation:obs-3'])),
    recalled('h4', 'd', 0.9, hypSources(['foundation:obs-4'])),
  ];
  const { ids, refByFactId } = collectSourceRefs(reflections);

  assert.equal(ids.length, MAX_EVIDENCE_REFS);
  assert.deepEqual(ids, ['obs-1', 'obs-2', 'obs-3']);
  assert.deepEqual(refByFactId.get('h1'), ['obs-1']);
  assert.deepEqual(refByFactId.get('h2'), ['obs-2', 'obs-1'], 'an item keeps the order it cited its sources in');
  assert.equal(refByFactId.has('h4'), false, 'an item beyond the budget contributes nothing');
});

test('planEvidenceRecall combines the gate and the id collection', () => {
  const plan = planEvidenceRecall([
    recalled('h1', 'a', 0.9, hypSources(['foundation:obs-1'])),
    recalled('h2', 'b', 0.2, hypSources(['foundation:obs-2'])),
  ]);
  assert.deepEqual(plan.reflections.map((r) => r.id), ['h1']);
  assert.deepEqual(plan.ids, ['obs-1']);
});

test('observationId and observationText read both the wrapped and bare shapes', () => {
  const wrapped = { object: { id: 'obs-1', content: '  raw   words\nhere ' }, episodes: [] };
  assert.equal(observationId(wrapped), 'obs-1');
  assert.equal(observationText(wrapped), 'raw words here');

  const bare = { id: 'obs-2', text: 'bare text' };
  assert.equal(observationId(bare), 'obs-2');
  assert.equal(observationText(bare), 'bare text');
  assert.equal(observationText(null), '');
});

test('fetchEvidenceForReflections makes NO call when no item carries sources (nul-kosten-voorpad)', async () => {
  let calls = 0;
  const foundation = { fetchIngestObjects: async () => { calls += 1; return []; } };
  const plain = [recalled('h1', 'plain memory', 0.9)];

  assert.equal(await fetchEvidenceForReflections(foundation, plain, {}), null);
  assert.equal(calls, 0, 'no provenance anywhere ⇒ no Foundation round-trip');
});

test('fetchEvidenceForReflections returns null without a Foundation client', async () => {
  const withSources = [recalled('h1', 'a', 0.9, hypSources(['foundation:obs-1']))];
  assert.equal(await fetchEvidenceForReflections(undefined, withSources), null);
  assert.equal(await fetchEvidenceForReflections({}, withSources), null);
});

test('fetchEvidenceForReflections fetches, maps the literal records, and attaches them to their item', async () => {
  const asked = [];
  const foundation = {
    fetchIngestObjects: async (ids) => {
      asked.push(...ids);
      return ids.map((id) => ({ object: { id, content: `raw ${id}` } }));
    },
  };
  const reflections = [
    recalled('h1', 'a', 0.9, hypSources(['foundation:obs-1'])),
    recalled('h2', 'b', 0.9, hypSources(['foundation:obs-2'])),
  ];

  const result = await fetchEvidenceForReflections(foundation, reflections);

  assert.deepEqual(asked, ['obs-1', 'obs-2']);
  assert.deepEqual(result.evidenceByFactId.get('h1'), ['raw obs-1']);
  assert.deepEqual(result.evidenceByFactId.get('h2'), ['raw obs-2']);
});

test('fetchEvidenceForReflections fails soft: a throwing or empty fetch is just no evidence', async () => {
  const reflections = [recalled('h1', 'a', 0.9, hypSources(['foundation:obs-1']))];
  const throwing = { fetchIngestObjects: async () => { throw new Error('down'); } };
  const empty = { fetchIngestObjects: async () => [] };

  assert.equal(await fetchEvidenceForReflections(throwing, reflections), null);
  assert.equal(await fetchEvidenceForReflections(empty, reflections), null);
});
