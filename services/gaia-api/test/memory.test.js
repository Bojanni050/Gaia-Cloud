'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldRecall, shouldReflect } = require('../src/memoryPolicy');
const { createHindsightClient } = require('../src/hindsightClient');
const {
  condenseMemoryContext,
  renderMemoryContext,
  recallRelevantContext,
  reflectOnTurn,
  MENTAL_MODEL_IDS,
  renderMentalModelContext,
  fetchMentalModelContext,
} = require('../src/memory');

// --- memoryPolicy: same case list as gaia-web's memoryPolicy.test.js, so
// this port is checked against the exact behavior already proven correct
// there, not re-derived from scratch. ------------------------------------

test('shouldRecall skips trivial/filler and non-signal-bearing turns', () => {
  assert.equal(shouldRecall(''), false);
  assert.equal(shouldRecall('   '), false);
  assert.equal(shouldRecall('ok'), false);
  assert.equal(shouldRecall('Ok.'), false);
  assert.equal(shouldRecall('THANKS!'), false);
  assert.equal(shouldRecall('why'), false);
  assert.equal(shouldRecall('What theme should I use tonight?'), false);
  assert.equal(shouldRecall('ok, but why does Hermes retry twice?'), false);
  assert.equal(shouldRecall('Can you explain this projection of quarterly numbers?'), false);
  assert.equal(shouldRecall('What happens beforehand in this function?'), false);
});

test('shouldRecall fires on past-reference and durable-context signals, EN and NL', () => {
  assert.equal(shouldRecall('Remind me what I said about the migration plan'), true);
  assert.equal(shouldRecall('Last time we talked about this, what did we decide?'), true);
  assert.equal(shouldRecall('Weet je nog wat ik eerder zei over dit project?'), true);
  assert.equal(shouldRecall('What did we decide about the project database?'), true);
});

test('shouldRecall opens for an IntentDecision that resolves the answer to memory (assistant-anchored follow-ups)', () => {
  // "wat was er in juni ook alweer?" right after GAIA said "...context rond
  // juni...": no lexical past-reference cue, but IntentIQ resolved the turn
  // as a memory-anchored follow-up — recall must run.
  const anchored = {
    intent: null,
    status: 'unknown',
    sourceOfTruth: 'memory',
    meta: { reason: 'assistant_anchored_follow_up_unresolved_intent' },
  };
  assert.equal(shouldRecall('wat was er in juni ook alweer?', { intentDecision: anchored }), true);

  const inherited = {
    intent: 'inform.explain',
    status: 'accepted',
    sourceOfTruth: 'memory',
    meta: { reason: 'assistant_anchored_follow_up_inherited' },
  };
  assert.equal(shouldRecall('wat verklaart die piek dan in juni?', { intentDecision: inherited }), true);

  // Any memory-source decision qualifies — the truth lives in memory.
  assert.equal(
    shouldRecall('en hoe ging dat ook alweer?', { intentDecision: { intent: null, status: 'unknown', sourceOfTruth: 'memory' } }),
    true
  );
});

test('shouldRecall stays closed without the context object or with non-memory intents', () => {
  assert.equal(shouldRecall('wat was er in juni ook alweer?'), false); // legacy single-arg call
  assert.equal(
    shouldRecall('wat was er in juni ook alweer?', { intentDecision: { sourceOfTruth: 'conversation' } }),
    false
  );
  assert.equal(
    shouldRecall('wat was er in juni ook alweer?', { intentDecision: null }),
    false
  );
});

test('shouldReflect keeps an exchange unless both sides are trivial', () => {
  assert.equal(shouldReflect('thanks', "you're welcome"), false);
  assert.equal(shouldReflect('why', 'no reason'), false);
  assert.equal(shouldReflect('I always work better after midnight, remember that', 'Noted.'), true);
  assert.equal(shouldReflect('why', 'Because you mentioned last week you prefer async updates.'), true);
});

// --- hindsightClient -------------------------------------------------------

test('hindsightClient.recall posts the query, defaults to budget "mid", and maps the full result shape', async () => {
  let captured;
  const client = createHindsightClient({
    baseUrl: 'http://hindsight.internal:8888',
    bankId: 'gaia',
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return {
        ok: true,
        json: async () => ({
          results: [{
            id: 'mem-1',
            text: 'Bo prefers async updates',
            type: 'observation',
            context: 'work preferences',
            metadata: null,
            entities: ['Bo'],
            tags: ['context'],
            occurred_start: '2026-08-01T00:00:00Z',
            occurred_end: null,
            scores: { final: 0.8, reranker: 0.75, semantic: 0.9, keyword: null },
          }],
        }),
      };
    },
  });

  const results = await client.recall('what does Bo prefer');
  assert.equal(captured.url, 'http://hindsight.internal:8888/v1/default/banks/gaia/memories/recall');
  const body = JSON.parse(captured.init.body);
  assert.equal(body.query, 'what does Bo prefer');
  assert.equal(body.budget, 'mid');
  assert.deepEqual(results, [{
    id: 'mem-1',
    text: 'Bo prefers async updates',
    type: 'observation',
    context: 'work preferences',
    metadata: null,
    entities: ['Bo'],
    tags: ['context'],
    occurredStart: '2026-08-01T00:00:00Z',
    occurredEnd: null,
    scores: { final: 0.8, reranker: 0.75, semantic: 0.9, keyword: null },
  }]);
});

test('hindsightClient.recall lets a caller override the default budget per call', async () => {
  let captured;
  const client = createHindsightClient({
    baseUrl: 'http://hindsight.internal:8888',
    bankId: 'gaia',
    fetchImpl: async (url, init) => { captured = init; return { ok: true, json: async () => ({ results: [] }) }; },
  });

  await client.recall('quick check', { budget: 'low' });
  assert.equal(JSON.parse(captured.body).budget, 'low');
});

test('hindsightClient: the factory-level default budget can be changed too', async () => {
  let captured;
  const client = createHindsightClient({
    baseUrl: 'http://hindsight.internal:8888',
    bankId: 'gaia',
    budget: 'high',
    fetchImpl: async (url, init) => { captured = init; return { ok: true, json: async () => ({ results: [] }) }; },
  });

  await client.recall('deep question');
  assert.equal(JSON.parse(captured.body).budget, 'high');
});

test('hindsightClient.recall tolerates a sparse result (missing optional fields)', async () => {
  const client = createHindsightClient({
    baseUrl: 'http://hindsight.internal:8888',
    bankId: 'gaia',
    fetchImpl: async () => ({ ok: true, json: async () => ({ results: [{ id: 'x', text: 'bare fact' }] }) }),
  });

  const [result] = await client.recall('anything');
  assert.equal(result.text, 'bare fact');
  assert.equal(result.type, null);
  assert.deepEqual(result.tags, []);
  assert.equal(result.scores.final, null);
});

test('hindsightClient.reflect posts an async retain', async () => {
  let captured;
  const client = createHindsightClient({
    baseUrl: 'http://hindsight.internal:8888',
    bankId: 'gaia',
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return { ok: true };
    },
  });

  await client.reflect({ summary: 'Bo: hi\n\nGaia: hello', domain: 'context' });
  const body = JSON.parse(captured.init.body);
  assert.equal(body.async, true);
  assert.equal(body.items[0].content, 'Bo: hi\n\nGaia: hello');
});

test('hindsightClient refuses to construct without a base URL or bank', () => {
  assert.throws(() => createHindsightClient({ baseUrl: '', bankId: 'gaia' }));
  assert.throws(() => createHindsightClient({ baseUrl: 'http://x', bankId: '' }));
});

test('hindsightClient.getMentalModel fetches by id and maps the response', async () => {
  let captured;
  const client = createHindsightClient({
    baseUrl: 'http://hindsight.internal:8888',
    bankId: 'gaia',
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return {
        ok: true,
        json: async () => ({
          id: 'communication-style',
          name: 'Communication Style',
          content: 'Bo prefers direct, terse answers.',
          is_stale: false,
          last_refreshed_at: '2026-08-19T03:00:00Z',
        }),
      };
    },
  });

  const model = await client.getMentalModel('communication-style');
  assert.equal(captured.url, 'http://hindsight.internal:8888/v1/default/banks/gaia/mental-models/communication-style');
  assert.equal(captured.init.method, 'GET');
  assert.deepEqual(model, {
    id: 'communication-style',
    name: 'Communication Style',
    content: 'Bo prefers direct, terse answers.',
    isStale: false,
    lastRefreshedAt: '2026-08-19T03:00:00Z',
  });
});

test('hindsightClient.getMentalModel returns null on failure, 404, or empty content', async () => {
  const unreachable = createHindsightClient({
    baseUrl: 'http://x', bankId: 'gaia', fetchImpl: async () => { throw new Error('down'); },
  });
  assert.equal(await unreachable.getMentalModel('goals-priorities'), null);

  const notFound = createHindsightClient({
    baseUrl: 'http://x', bankId: 'gaia', fetchImpl: async () => ({ ok: false, status: 404 }),
  });
  assert.equal(await notFound.getMentalModel('goals-priorities'), null);

  const notYetGenerated = createHindsightClient({
    baseUrl: 'http://x', bankId: 'gaia', fetchImpl: async () => ({ ok: true, json: async () => ({ id: 'x', content: null }) }),
  });
  assert.equal(await notYetGenerated.getMentalModel('goals-priorities'), null);

  const stillGenerating = createHindsightClient({
    baseUrl: 'http://x', bankId: 'gaia', fetchImpl: async () => ({ ok: true, json: async () => ({ id: 'x', content: 'Generating content...' }) }),
  });
  assert.equal(await stillGenerating.getMentalModel('goals-priorities'), null);
});

// --- memory.js orchestration ------------------------------------------------

function reflection(text, final) {
  return { text, scores: { final } };
}

test('condenseMemoryContext tags low-confidence lines uncertain, caps at 6, dedupes', () => {
  const reflections = [
    reflection('A', 0.9),
    reflection('B', 0.4),
    reflection('A', 0.9), // duplicate
    ...Array.from({ length: 6 }, (_, i) => reflection(`extra-${i}`, 0.9)),
  ];
  const lines = condenseMemoryContext(reflections);
  assert.equal(lines.length, 6);
  assert.equal(lines[0], '- A');
  assert.equal(lines[1], '- B (uncertain)');
});

test('renderMemoryContext returns null when there is nothing to show', () => {
  assert.equal(renderMemoryContext([]), null);
  assert.equal(renderMemoryContext(null), null);
});

test('renderMemoryContext renders a block when there is something to show', () => {
  const block = renderMemoryContext([reflection('Bo prefers async updates', 0.9)]);
  assert.match(block, /long-term memory \(Hindsight\)/);
  assert.match(block, /- Bo prefers async updates$/m);
});

test('recallRelevantContext skips the call for a policy-trivial query and never throws on failure', async () => {
  let called = false;
  const hindsight = { recall: async () => { called = true; return []; } };
  assert.deepEqual(await recallRelevantContext(hindsight, 'ok'), []);
  assert.equal(called, false);

  const failing = { recall: async () => { throw new Error('unreachable'); } };
  assert.deepEqual(await recallRelevantContext(failing, 'remember what I said about the project'), []);
});

test('reflectOnTurn skips trivial exchanges and never throws even if Hindsight rejects', async () => {
  let calls = 0;
  const hindsight = { reflect: async () => { calls += 1; throw new Error('unreachable'); } };

  reflectOnTurn(hindsight, { userText: 'thanks', assistantText: 'np', conversationId: 'c1' });
  assert.equal(calls, 0); // both trivial, skipped

  assert.doesNotThrow(() => {
    reflectOnTurn(hindsight, {
      userText: 'I always work better after midnight, remember that',
      assistantText: 'Noted.',
      conversationId: 'c1',
    });
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
});

// --- mental models -----------------------------------------------------

test('renderMentalModelContext returns null when there is nothing to show', () => {
  assert.equal(renderMentalModelContext([]), null);
  assert.equal(renderMentalModelContext(null), null);
  assert.equal(renderMentalModelContext([{ name: 'Empty', content: '   ' }]), null);
});

test('renderMentalModelContext renders one section per model, named by heading', () => {
  const block = renderMentalModelContext([
    { name: 'Communication Style', content: 'Prefers terse, direct answers.' },
    { name: 'Goals & Priorities', content: 'Shipping the Gaia repo split.' },
  ]);
  assert.match(block, /standing understanding of Bo/);
  assert.match(block, /### Communication Style\nPrefers terse, direct answers\./);
  assert.match(block, /### Goals & Priorities\nShipping the Gaia repo split\./);
});

test('fetchMentalModelContext fetches every configured id, drops failures, and caches until the TTL expires', async () => {
  let calls = 0;
  // Starts well past the TTL from the module's initial (fetchedAt: 0) cache
  // state, so the first call in this test is guaranteed to be a real fetch
  // rather than an accidental hit against that initial empty cache.
  let clock = 100 * 60 * 1000;
  const hindsight = {
    getMentalModel: async (id) => {
      calls += 1;
      if (id === MENTAL_MODEL_IDS[0]) return null; // not yet generated
      return { id, name: id, content: `content for ${id}` };
    },
  };

  const first = await fetchMentalModelContext(hindsight, { now: () => clock });
  assert.equal(calls, MENTAL_MODEL_IDS.length);
  assert.equal(first.length, MENTAL_MODEL_IDS.length - 1);

  // Well within the TTL: cache hit, no new calls.
  clock += 60 * 1000;
  const second = await fetchMentalModelContext(hindsight, { now: () => clock });
  assert.equal(calls, MENTAL_MODEL_IDS.length);
  assert.deepEqual(second, first);

  // Past the TTL: refetches.
  clock += 11 * 60 * 1000;
  await fetchMentalModelContext(hindsight, { now: () => clock });
  assert.equal(calls, MENTAL_MODEL_IDS.length * 2);
});

test('fetchMentalModelContext never throws even if getMentalModel rejects', async () => {
  const hindsight = { getMentalModel: async () => { throw new Error('unreachable'); } };
  const models = await fetchMentalModelContext(hindsight, { now: () => Date.now() + 999999999 });
  assert.deepEqual(models, []);
});
