'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHindsightClient } = require('../src/hindsightClient');
const {
  createHindsightCognitionAdapter,
  OBSERVATION_TAG,
  OPEN_QUESTION_TAG,
  RELATIONSHIP_TAG,
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

test('cognition adapter: a relationship persists as a gaia:relationship world fact with structured endpoint metadata', async () => {
  const { client, facts } = makeFake();
  const adapter = createHindsightCognitionAdapter({ client });
  const { factId } = await adapter.retainRelationship({
    fromKind: 'evidence',
    fromId: 'evidence-1',
    fromStatement: 'the user referenced the pattern milestone',
    toKind: 'pattern',
    toId: 'ptn-1',
    toStatement: 'Recurring relationship around: streaming races.',
    type: 'relates_to',
    confidence: 0.6,
    rationale: 'thematic kin',
  });
  const unit = [...facts.values()][0];
  assert.equal(unit.type, 'world');
  assert.equal(unit.tags[0], RELATIONSHIP_TAG);
  assert.equal(unit.context, 'gaia relationship');
  assert.match(unit.document_id, /^gaia-rel-/);
  assert.equal(unit.metadata.gaia_relationship_from_kind, 'evidence');
  assert.equal(unit.metadata.gaia_relationship_from_id, 'evidence-1');
  assert.equal(unit.metadata.gaia_relationship_to_kind, 'pattern');
  assert.equal(unit.metadata.gaia_relationship_to_id, 'ptn-1');
  assert.equal(unit.metadata.gaia_relationship_type, 'relates_to');
  assert.equal(unit.metadata.gaia_relationship_confidence, '0.6');
  assert.equal(unit.metadata.gaia_relationship_updated_by, 'gaia-reasoniq');
  assert.match(unit.text, /evidence:evidence-1 relates_to pattern:ptn-1/);
  assert.equal(factId, unit.id);
});

test('cognition adapter: an observation-endpoint relationship stores by statement when no id exists', async () => {
  const { client, facts } = makeFake();
  const adapter = createHindsightCognitionAdapter({ client });
  await adapter.retainRelationship({
    fromKind: 'observation',
    fromId: null,
    fromStatement: 'The user explicitly linked hypothesis tracking to pattern formation.',
    toKind: 'hypothesis',
    toId: 'hyp-1',
    toStatement: 'Concurrent cancellation causes the streaming race.',
    type: 'supports',
    confidence: 0.7,
    rationale: null,
  });
  const unit = [...facts.values()][0];
  assert.equal(unit.metadata.gaia_relationship_from_id, '');
  assert.equal(unit.metadata.gaia_relationship_from_statement, 'The user explicitly linked hypothesis tracking to pattern formation.');
  assert.match(unit.text, /observation:.* supports hypothesis:hyp-1/);
});

test('cognition adapter: a relationship without endpoints or type is refused, not stored silently', async () => {
  const { client, facts } = makeFake();
  const adapter = createHindsightCognitionAdapter({ client });
  await assert.rejects(() => adapter.retainRelationship({ fromKind: 'evidence', toKind: '', type: '' }));
  await assert.rejects(() => adapter.retainRelationship(null));
  assert.equal(facts.size, 0);
});

test('cognition adapter: requires a hindsight client', () => {
  assert.throws(() => createHindsightCognitionAdapter({}), /hindsight client/);
});
