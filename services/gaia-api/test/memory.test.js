'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldRecall, shouldReflect } = require('../src/memoryPolicy');
const { createHindsightClient } = require('../src/hindsightClient');
const {
  condenseMemoryContext,
  memoryKindOf,
  renderMemoryContext,
  renderDualRecallContext,
  recallRelevantContext,
  reflectOnTurn,
  spokenPart,
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

test('shouldRecall opens for the memory-question forms that carried no cue (18-10-2026)', () => {
  // Verbatim from the Yassine conversation where the gate stayed shut for 21
  // turns while the memory was demonstrably present: the knowing-question and
  // the memory nouns themselves were not cues.
  assert.equal(shouldRecall('Wat weet jij over Yassin?'), true);
  assert.equal(shouldRecall('Oké, en wat weet je dan van Luca?'), true);
  assert.equal(shouldRecall('Als het goed is, staat er wel wat in je geheugen.'), true);
  assert.equal(shouldRecall('Kun je wel bij het geheugen?'), true);
  assert.equal(shouldRecall('Herinner je je nog wat we zagen?'), true);
  assert.equal(shouldRecall('What do you know about the migration plan?'), true);
});

test('a cue decides at any length: the short memory questions open the gate too', () => {
  // normalize() strips the punctuation first, so "weet je nog?" is eleven
  // characters and "geheugen?" eight — both were swallowed by the old floor of
  // twelve, which is why these questions went unanswered. There is no length
  // floor on the recall gate any more; only what carries no cue stays shut.
  assert.equal(shouldRecall('weet je nog?'), true);
  assert.equal(shouldRecall('geheugen?'), true);
  assert.equal(shouldRecall('herinner je?'), true);
  assert.equal(shouldRecall('memory?'), true);
  assert.equal(shouldRecall(''), false);
  assert.equal(shouldRecall('   '), false);
  assert.equal(shouldRecall('ok'), false);
  assert.equal(shouldRecall('thanks!'), false);
  assert.equal(shouldRecall('why'), false);
  assert.equal(shouldRecall('wat was er in juni ook alweer?'), false); // no cue: still closed
});

test('shouldReflect keeps an exchange unless both sides are trivial', () => {
  assert.equal(shouldReflect('thanks', "you're welcome"), false);
  assert.equal(shouldReflect('why', 'no reason'), false);
  assert.equal(shouldReflect('I always work better after midnight, remember that', 'Noted.'), true);
  assert.equal(shouldReflect('why', 'Because you mentioned last week you prefer async updates.'), true);
});

test('step 4: a shape read once is what the gate listens to, not a second scan', () => {
  // The turn reads the question once (turnShape.readTurn) and hands the same
  // verdict to every gate. When a shape is present it decides — including when
  // it disagrees with what the text alone would say, which is the whole point
  // of never reading the same sentence twice.
  assert.equal(shouldRecall('iets zonder enig signaal', { shape: { wantsRecall: true } }), true);
  assert.equal(shouldRecall('Wat weet jij over Yassin?', { shape: { wantsRecall: false } }), false);
  assert.equal(shouldReflect('thanks', "you're welcome", { shape: { reflectable: true } }), true);
  assert.equal(shouldReflect('thanks', "you're welcome", { shape: { reflectable: false, empty: true } }), false);
  // A trivial user half with a substantive answer still reflects: the shape
  // answers for the user's half only, so the answer's half is still read.
  assert.equal(shouldReflect('ok', 'Because you mentioned last week you prefer async updates.', {
    shape: { reflectable: false, empty: false },
  }), true);
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

test('condenseMemoryContext tags low-confidence lines uncertain, caps at 9, dedupes', () => {
  const reflections = [
    reflection('A', 0.9),
    reflection('B', 0.4),
    reflection('A', 0.9), // duplicate
    ...Array.from({ length: 12 }, (_, i) => reflection(`extra-${i}`, 0.9)),
  ];
  const lines = condenseMemoryContext(reflections);
  assert.equal(lines.length, 9);
  assert.equal(lines[0], '- A');
  assert.equal(lines[1], '- B (uncertain)');
});

test('MEMORY_MAX_LINES overrides the line cap', () => {
  const previous = process.env.MEMORY_MAX_LINES;
  const modulePath = require.resolve('../src/memory');
  process.env.MEMORY_MAX_LINES = '2';
  delete require.cache[modulePath];
  try {
    const fresh = require('../src/memory');
    const many = Array.from({ length: 5 }, (_, i) => reflection(`x-${i}`, 0.9));
    assert.equal(fresh.condenseMemoryContext(many).length, 2);
  } finally {
    if (previous === undefined) delete process.env.MEMORY_MAX_LINES;
    else process.env.MEMORY_MAX_LINES = previous;
    delete require.cache[modulePath];
  }
});

test('renderMemoryContext returns null when there is nothing to show', () => {
  assert.equal(renderMemoryContext([]), null);
  assert.equal(renderMemoryContext(null), null);
});

test('condenseMemoryContext appends the real age when Hindsight gave an event time', () => {
  const now = Date.parse('2026-10-17T18:42:00Z');
  const lines = condenseMemoryContext([
    { text: 'Bo verhuist binnenkort', occurredStart: '2026-10-14T12:00:00Z', scores: { final: 0.9 } },
    { text: 'Twijfelgeval', occurredStart: '2026-10-14T12:00:00Z', scores: { final: 0.4 } },
  ], now);
  assert.equal(lines[0], '- Bo verhuist binnenkort (3 dagen geleden)');
  assert.equal(lines[1], '- Twijfelgeval (uncertain, 3 dagen geleden)');
});

test('condenseMemoryContext says what KIND of thing each item is', () => {
  const lines = condenseMemoryContext([
    { text: 'Yassine is een vriend', tags: ['gaia:hypothesis', 'gaia:confirmed_fact'], scores: { final: 0.9 } },
    { text: 'Er was een afscheidsritueel', tags: ['gaia:hypothesis'], scores: { final: 0.7 } },
    { text: 'Nachtwerk en doorbraken hangen samen', tags: ['gaia:pattern'], scores: { final: 0.8 } },
    { text: 'Wat letterlijk gezegd is', tags: ['gaia-turn'], scores: { final: 0.8 } },
    { text: 'Wat Aion eerder dacht', tags: ['gaia:aion'], scores: { final: 0.8 } },
    { text: 'Geen markering', scores: { final: 0.9 } },
  ]);
  assert.equal(lines[0], '- Yassine is een vriend (confirmed by the person)');
  assert.equal(lines[1], '- Er was een afscheidsritueel (your own hypothesis, never confirmed)');
  assert.equal(lines[2], '- Nachtwerk en doorbraken hangen samen (a pattern you formed)');
  assert.equal(lines[3], '- Wat letterlijk gezegd is (a record of what was said)');
  assert.equal(lines[4], '- Wat Aion eerder dacht (your own reflection)');
  // A tagless item keeps its old shape: nothing invented, nothing added.
  assert.equal(lines[5], '- Geen markering');
});

test('condenseMemoryContext composes kind, uncertainty and age, and ignores tags it does not know', () => {
  const now = Date.parse('2026-10-17T18:42:00Z');
  const lines = condenseMemoryContext([
    { text: 'Twijfel', tags: ['gaia:hypothesis'], occurredStart: '2026-10-14T12:00:00Z', scores: { final: 0.4 } },
    { text: 'Onbekende tag', tags: ['context'], scores: { final: 0.9 } },
  ], now);
  assert.equal(lines[0], '- Twijfel (your own hypothesis, never confirmed, uncertain, 3 dagen geleden)');
  assert.equal(lines[1], '- Onbekende tag');
});

test('memoryKindOf: the strongest tag wins, and an unknown shape is never a kind', () => {
  assert.equal(memoryKindOf(null), null);
  assert.equal(memoryKindOf({}), null);
  assert.equal(memoryKindOf({ tags: [] }), null);
  assert.equal(memoryKindOf({ tags: ['context'] }), null);
  assert.equal(memoryKindOf({ tags: ['GAIA:CONFIRMED_FACT'] }), 'confirmed');
  assert.equal(memoryKindOf({ tags: ['foundation:fact'] }), 'confirmed');
  // Promoted knowledge carries the hypothesis tag too — knowledge wins.
  assert.equal(memoryKindOf({ tags: ['gaia:hypothesis', 'gaia:knowledge'] }), 'knowledge');
  assert.equal(memoryKindOf({ tags: ['gaia:hypothesis', 'gaia:confirmed_fact'] }), 'confirmed');
});

test('the memory header teaches the markers and the ask-instead-of-assert rule', () => {
  const block = renderMemoryContext([reflection('A', 0.9)]);
  assert.match(block, /confirmed by the person/);
  assert.match(block, /never state/);
  assert.match(block, /ask instead of asserting/);
});

test('renderMemoryContext renders a block when there is something to show', () => {
  const block = renderMemoryContext([reflection('Bo prefers async updates', 0.9)]);
  assert.match(block, /long-term memory \(Hindsight\)/);
  assert.match(block, /- Bo prefers async updates$/m);
});

test('renderDualRecallContext without evidence is byte-for-byte renderMemoryContext', () => {
  const reflections = [reflection('Bo prefers async updates', 0.9), reflection('B', 0.4)];
  assert.equal(renderDualRecallContext(reflections, null), renderMemoryContext(reflections));
  assert.equal(renderDualRecallContext(reflections, new Map()), renderMemoryContext(reflections));
  assert.equal(renderDualRecallContext(null, new Map()), null);
});

test('renderDualRecallContext lays the literal Foundation records under the item that cited them', () => {
  const item = { id: 'h1', text: 'Bo prefers async updates', scores: { final: 0.9 } };
  const other = { id: 'h2', text: 'Unrelated memory', scores: { final: 0.9 } };
  const evidence = new Map([['h1', ['raw words from the source email', 'a second exact fragment']]]);

  const block = renderDualRecallContext([item, other], evidence);

  assert.match(block, /literal Foundation records/);
  assert.match(block, /- Bo prefers async updates\n {2}- \[observatie\] raw words from the source email\n {2}- \[observatie\] a second exact fragment/);
  // The item with no evidence still renders, but never fabricates any.
  assert.match(block, /- Unrelated memory$/m);
  assert.equal((block.match(/\n {2}- \[observatie\] /g) || []).length, 2);
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

test('spokenPart keeps what the person said and leaves their questions out', () => {
  // A question is not something the person said — it is what the extractor
  // turned into "user asked about X" records (measured 18-10-2026).
  assert.equal(spokenPart('Wat weet jij over Yassin?'), '');
  assert.equal(spokenPart('Kun je wel bij het geheugen?'), '');
  assert.equal(spokenPart('Yassine, wat weet je van hem?'), '');
  assert.equal(spokenPart('Oké, en wat weet je dan van Luca?'), '');
  assert.equal(spokenPart(''), '');
  assert.equal(spokenPart(null), '');
  // A statement always stays, and a sentence that corrects and asks at once
  // stays whole.
  assert.equal(
    spokenPart('Nee, hij heeft mij gisteren bezocht en dat was gezellig.'),
    'Nee, hij heeft mij gisteren bezocht en dat was gezellig.'
  );
  assert.equal(
    spokenPart('Dat klopt niet, wat weet je over Luca?'),
    'Dat klopt niet, wat weet je over Luca?'
  );
  // A mixed turn keeps its stating part and drops the asking part.
  assert.equal(spokenPart('Hoe werkt het? Vertel eens.'), 'Vertel eens.');
  assert.equal(
    spokenPart('Wat weet je over MelodiQ? Ik heb gisteren de player gerepareerd.'),
    'Ik heb gisteren de player gerepareerd.'
  );
});

test('reflectOnTurn keeps a statement turn and drops a question-only turn', async () => {
  const captured = [];
  const hindsight = { reflect: async (opts) => { captured.push(opts); } };

  // A turn that only asks states nothing of its own: her answer to a memory
  // question is a restatement of what is already stored, and retaining that
  // exchange is how "Gaia knows nothing about Yassine" became a stored fact
  // (dry-run-extract, 18-10-2026).
  reflectOnTurn(hindsight, {
    userText: 'Wat weet jij over Yassin?',
    assistantText: 'Yassine is een vriend van Bo die een opleiding volgt.',
    conversationId: 'c1',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(captured.length, 0);

  reflectOnTurn(hindsight, {
    userText: 'Hij heeft mij gisteren bezocht en dat was gezellig.',
    assistantText: 'Wat fijn.',
    conversationId: 'c1',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(captured.length, 1);
  assert.match(captured[0].summary, /^Bojan: Hij heeft mij gisteren bezocht/);

  // A question attached to something the person states keeps the statement,
  // and the question itself is not handed over as if it were said.
  reflectOnTurn(hindsight, {
    userText: 'Wat weet je over MelodiQ? Ik heb gisteren de player gerepareerd.',
    assistantText: 'Mooi.',
    conversationId: 'c1',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(captured.length, 2);
  assert.match(captured[1].summary, /^Bojan: Ik heb gisteren de player gerepareerd\./);
  assert.ok(!captured[1].summary.includes('Wat weet je over MelodiQ?'), captured[1].summary);
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
