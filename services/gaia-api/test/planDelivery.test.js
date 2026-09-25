'use strict';

/**
 * Delivery guarantees for multi-step (plan) turns — the client-visible half
 * of Decision Engine 3.0.
 *
 * The Orchestrator executes the plan; the Response Engine is the only thing
 * that produces what the client receives. Three rules are pinned here, all
 * of them about one promise: what Gaia composed as her answer is exactly
 * what the client sees, in full.
 *
 *   1. Only the LAST step's output is the reply. Earlier steps render into
 *      context for the steps that follow (orchestrator's stepOnDelta) —
 *      their raw retrieval/analysis text must never show up inside the
 *      client's stream.
 *   2. The reply reaches the client exactly once: streamed during execution
 *      when the last step streamed, written as one final delta when it did
 *      not. Never twice, never zero times (an empty stream while history
 *      keeps the full reply is the failure mode this guards).
 *   3. A plan that fails leaves no partial text on the wire — a calm error
 *      instead of a half-answer standing in for the real one.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { performStreamingTurn } = require('../src/turn');

function fakeRes() {
  return {
    statusCode: null,
    headers: null,
    written: [],
    ended: false,
    jsonBody: null,
    writeHead(code, headers) { this.statusCode = code; this.headers = headers; },
    write(chunk) { this.written.push(chunk); },
    end() { this.ended = true; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.jsonBody = body; },
  };
}

/** User-visible content of an SSE stream — reasoning-trace deltas excluded. */
function streamedText(res) {
  return res.written
    .filter((frame) => frame.startsWith('data: {'))
    .map((frame) => {
      const delta = JSON.parse(frame.slice('data: '.length)).choices[0].delta;
      return typeof delta.reasoning_content === 'string' ? '' : (delta.content || '');
    })
    .join('');
}

/** A Hermes stub whose stream() streams and whose chat() does not. */
function hermesStub(streamed) {
  return {
    chat: async () => streamed,
    stream: async (messages, { onDelta } = {}) => {
      if (onDelta) onDelta(streamed, false);
      return streamed;
    },
  };
}

function baseInput(res) {
  return {
    messages: [{ role: 'user', content: 'wat zei ik daar vorige maand over?' }],
    documents: { 'soul.md': 'SOUL' },
    res,
    historyStore: { saveConversation() {} },
    intentIQ: async () => ({ intent: 'memory.recall', status: 'accepted', sourceOfTruth: 'conversation' }),
  };
}

test('a plan delivers the composed answer once; the retrieval step contributes nothing to the stream', async () => {
  const res = fakeRes();
  const FINAL = 'Het samengestelde antwoord in Gaia\'s eigen stem.';
  await performStreamingTurn({
    ...baseInput(res),
    hermes: hermesStub('niet gebruikt'),
    tools: { conversation_search: { invoke: async () => 'RUWE PASSAGE DIE DE GEBRUIKER NIET HOORT' } },
    nativeGenerator: {
      generate: async () => FINAL,
      stream: async (messages, { onDelta }) => { onDelta(FINAL, false); return FINAL; },
    },
    decisionEngine: () => ({
      action: 'plan',
      reason: 'test',
      steps: [
        { id: 'step-1', type: 'retrieval', capability: 'conversation_search', input: { query: 'x', scope: 'all' } },
        { id: 'step-2', type: 'generation', mode: 'native', sources: ['step-1'] },
      ],
    }),
  });

  assert.equal(streamedText(res), FINAL);
  assert.ok(!streamedText(res).includes('RUWE PASSAGE'), 'raw retrieval output must not reach the client');
  assert.equal(res.ended, true);
});

test('an intermediate reasoning step never streams its raw analysis into the answer', async () => {
  const res = fakeRes();
  const ANALYSIS = 'INTERNE ANALYSE DIE NIET IN HET ANTWOORD THOORT';
  const FINAL = 'Het eindantwoord, samengesteld uit de analyse.';
  await performStreamingTurn({
    ...baseInput(res),
    hermes: hermesStub(ANALYSIS),
    nativeGenerator: {
      generate: async () => FINAL,
      stream: async (messages, { onDelta }) => { onDelta(FINAL, false); return FINAL; },
    },
    decisionEngine: () => ({
      action: 'plan',
      reason: 'test',
      steps: [
        { id: 'step-1', type: 'reasoning', capability: 'hermes', input: {}, sources: [] },
        { id: 'step-2', type: 'generation', mode: 'native', sources: ['step-1'] },
      ],
    }),
  });

  assert.equal(streamedText(res), FINAL);
  assert.ok(!streamedText(res).includes('INTERNE ANALYSE'), 'the intermediate step is context, not the reply');
});

test('a plan whose last step returns text without streaming still delivers that text', async () => {
  const res = fakeRes();
  const FOUND = 'De gevonden passages uit je geschiedenis.';
  await performStreamingTurn({
    ...baseInput(res),
    hermes: hermesStub('niet gebruikt'),
    tools: { conversation_search: { invoke: async () => FOUND } },
    nativeGenerator: {
      generate: async () => { throw new Error('must not be reached'); },
      stream: async () => { throw new Error('must not be reached'); },
    },
    decisionEngine: () => ({
      action: 'plan',
      reason: 'test',
      steps: [
        { id: 'step-1', type: 'retrieval', capability: 'conversation_search', input: { query: 'x', scope: 'all' } },
      ],
    }),
  });

  assert.equal(streamedText(res), FOUND, 'a non-streaming last step used to finish with an empty stream');
  assert.equal(res.ended, true);
  assert.equal(res.jsonBody, null);
});

test('a single-action capability that returns text without streaming reaches the client', async () => {
  const res = fakeRes();
  const FOUND = 'Je zei destijds: we gaan de emigratie plannen.';
  await performStreamingTurn({
    ...baseInput(res),
    hermes: hermesStub('niet gebruikt'),
    tools: { conversation_search: { invoke: async () => FOUND } },
    decisionEngine: () => ({
      action: 'capability',
      capability: 'conversation_search',
      capability_execute: true,
      task: 'search.conversation',
      input: { query: 'wat zei ik', scope: 'current' },
      reason: 'test',
    }),
  });

  assert.equal(streamedText(res), FOUND);
  assert.equal(res.ended, true);
});

test('a reply that streamed during execution is not emitted a second time', async () => {
  const res = fakeRes();
  const FINAL = 'Alleen dit antwoord, precies één keer.';
  await performStreamingTurn({
    ...baseInput(res),
    hermes: hermesStub('niet gebruikt'),
    nativeGenerator: {
      generate: async () => FINAL,
      stream: async (messages, { onDelta }) => { onDelta(FINAL, false); return FINAL; },
    },
    decisionEngine: () => ({ action: 'native', reason: 'test' }),
  });

  assert.equal(streamedText(res), FINAL);
  const contentFrames = res.written.filter((f) => f.startsWith('data: {')).length;
  assert.equal(contentFrames, 1, 'the reply must reach the client exactly once');
});

test('a failed plan leaves no partial text on the wire — a calm error instead', async () => {
  const res = fakeRes();
  await performStreamingTurn({
    ...baseInput(res),
    hermes: hermesStub('stap 1 analyseert iets'),
    nativeGenerator: {
      generate: async () => { throw new Error('native unreachable at http://internal:8642'); },
      stream: async () => { throw new Error('native unreachable at http://internal:8642'); },
    },
    decisionEngine: () => ({
      action: 'plan',
      reason: 'test',
      steps: [
        { id: 'step-1', type: 'reasoning', capability: 'hermes', input: {}, sources: [] },
        { id: 'step-2', type: 'generation', mode: 'native', sources: ['step-1'] },
      ],
    }),
  });

  assert.equal(res.written.length, 0, 'the intermediate step must not have streamed partial content');
  assert.equal(res.statusCode, 502);
  assert.equal(res.jsonBody.error, 'gaia could not answer right now');
  assert.ok(!JSON.stringify(res.jsonBody).includes('8642'), 'no transport detail may reach the client');
});
