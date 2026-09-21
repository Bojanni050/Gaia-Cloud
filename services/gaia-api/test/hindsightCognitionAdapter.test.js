'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHindsightClient } = require('../src/hindsightClient');
const {
  createHindsightCognitionAdapter,
  OBSERVATION_TAG,
  OPEN_QUESTION_TAG,
} = require('../src/reasoning/hindsightCognitionAdapter');

function makeFake() {
  const facts = new Map();
  let n = 0;
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url);
    const method = opts.method || 'GET';
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (method === 'POST' && u.pathname.endsWith('/memories')) {
      for (const item of body.items) {
        n += 1;
        facts.set(`fact_${n}`, {
          id: `fact_${n}`, text: item.content, type: 'world', state: 'valid',
          context: item.context || null, metadata: item.metadata || null,
          tags: item.tags || [], document_id: item.document_id || null,
        });
      }
      return { ok: true, json: async () => ({ success: true }) };
    }
    if (method === 'GET' && u.pathname.endsWith('/memories/list')) {
      const q = u.searchParams;
      let items = [...facts.values()];
      if (q.get('state')) items = items.filter((f) => f.state === q.get('state'));
      if (q.get('type')) items = items.filter((f) => f.type === q.get('type'));
      if (q.get('document_id')) items = items.filter((f) => f.document_id === q.get('document_id'));
      return { ok: true, json: async () => ({ items: items.map((f) => ({ ...f })) }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const client = createHindsightClient({ baseUrl: 'http://hs.test', bankId: 'bojan', fetchImpl });
  return { client, facts };
}

test('cognition adapter: an observation persists as a gaia:observation world fact with provenance metadata', async () => {
  const { client, facts } = makeFake();
  const adapter = createHindsightCognitionAdapter({ client });
  const { factId } = await adapter.retainObservation({
    statement: 'The user explicitly decided that ReasonIQ must not participate in the conversation loop.',
    evidence: [{ id: 'evidence-1', source: 'conversation' }],
    relatedHypothesisId: 'hyp-1',
  });
  const unit = [...facts.values()][0];
  assert.equal(unit.type, 'world');
  assert.equal(unit.tags[0], OBSERVATION_TAG);
  assert.equal(unit.context, 'gaia observation');
  assert.match(unit.document_id, /^gaia-obs-/);
  assert.equal(unit.metadata.gaia_observation_updated_by, 'gaia-reasoniq');
  assert.deepEqual(JSON.parse(unit.metadata.gaia_observation_evidence), ['evidence-1']);
  assert.equal(unit.metadata.gaia_observation_related_hypothesis, 'hyp-1');
  assert.equal(factId, unit.id);
});

test('cognition adapter: an open question persists as a gaia:open-question world fact, stored only', async () => {
  const { client, facts } = makeFake();
  const adapter = createHindsightCognitionAdapter({ client });
  const { factId } = await adapter.retainOpenQuestion(
    'Does the agency/cognition separation extend to synchronous reasoning?'
  );
  const unit = [...facts.values()][0];
  assert.equal(unit.tags[0], OPEN_QUESTION_TAG);
  assert.equal(unit.context, 'gaia open question');
  assert.match(unit.document_id, /^gaia-oq-/);
  assert.equal(unit.metadata.gaia_open_question_updated_by, 'gaia-reasoniq');
  assert.equal(factId, unit.id);
});

test('cognition adapter: an empty observation or question is refused, not stored silently', async () => {
  const { client, facts } = makeFake();
  const adapter = createHindsightCognitionAdapter({ client });
  await assert.rejects(() => adapter.retainObservation({ statement: '  ' }));
  await assert.rejects(() => adapter.retainOpenQuestion(''));
  assert.equal(facts.size, 0);
});

test('cognition adapter: requires a hindsight client', () => {
  assert.throws(() => createHindsightCognitionAdapter({}), /hindsight client/);
});
