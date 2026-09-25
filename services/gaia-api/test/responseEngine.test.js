'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatReply, createStreamEmitter, resolveReplyText, toCalmError, CALM_FALLBACK, CLARIFY_FALLBACK, REFUSE_FALLBACK } = require('../src/responseEngine');

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

// --- formatReply (non-streaming boundary) ---------------------------------

test('formatReply turns a capability-produced string into the reply shape', () => {
  const result = formatReply('hello from Gaia');
  assert.deepEqual(result, { status: 200, body: { reply: 'hello from Gaia' } });
});

test('formatReply maps a missing/empty capability result to a calm 502, never the raw failure', () => {
  assert.deepEqual(formatReply(null), { status: 502, body: { error: CALM_FALLBACK } });
  assert.deepEqual(formatReply(undefined), { status: 502, body: { error: CALM_FALLBACK } });
  assert.deepEqual(formatReply(''), { status: 502, body: { error: CALM_FALLBACK } });
});

test('toCalmError never echoes the underlying error, no matter what it contains', () => {
  const leaky = new Error('hermes responded 401 at http://internal:8642 (model gpt-mystery)');
  const message = toCalmError(leaky);
  assert.equal(message, CALM_FALLBACK);
  assert.ok(!message.includes('hermes'));
  assert.ok(!message.includes('8642'));
  assert.ok(!message.includes('gpt-mystery'));
});

// --- createStreamEmitter (streaming boundary) -----------------------------

test('a capability-agnostic emitter: any source calling delta() produces the identical wire frame', () => {
  const res = fakeRes();
  const emitter = createStreamEmitter(res);
  // Simulates two different "capabilities" both just calling delta() —
  // the emitter has no idea which one it is, and the frame is identical.
  emitter.delta('from capability A', {});
  emitter.delta('from capability B', { reasoning: false });
  assert.equal(res.written[0], `data: ${JSON.stringify({ choices: [{ delta: { content: 'from capability A' } }] })}\n\n`);
  assert.equal(res.written[1], `data: ${JSON.stringify({ choices: [{ delta: { content: 'from capability B' } }] })}\n\n`);
});

test('reasoning deltas use a distinct frame shape but the same wire contract', () => {
  const res = fakeRes();
  const emitter = createStreamEmitter(res);
  emitter.delta('thinking...', { reasoning: true });
  assert.equal(res.written[0], `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'thinking...' } }] })}\n\n`);
});

test('headers are sent lazily, only on the first delta', () => {
  const res = fakeRes();
  const emitter = createStreamEmitter(res);
  assert.equal(res.headers, null);
  emitter.delta('hi', {});
  assert.equal(res.headers['Content-Type'], 'text/event-stream');
});

test('finish() writes [DONE] and ends the response', () => {
  const res = fakeRes();
  const emitter = createStreamEmitter(res);
  emitter.delta('hi', {});
  emitter.finish();
  assert.equal(res.written.at(-1), 'data: [DONE]\n\n');
  assert.equal(res.ended, true);
});

test('fail() before any delta returns a clean calm JSON error, not a half-open stream', () => {
  const res = fakeRes();
  const emitter = createStreamEmitter(res);
  emitter.fail(new Error('provider exploded, token xyz'));
  assert.equal(res.statusCode, 502);
  assert.equal(res.jsonBody.error, CALM_FALLBACK);
  assert.equal(res.headers, null); // never switched into SSE mode
});

test('fail() after a delta ends the stream calmly, without a fabricated error frame', () => {
  const res = fakeRes();
  const emitter = createStreamEmitter(res);
  emitter.delta('partial', {});
  emitter.fail(new Error('connection dropped'));
  assert.equal(res.ended, true);
  assert.ok(!res.written.includes('data: [DONE]\n\n')); // never claims a clean completion
});

test('an empty delta is a no-op and never opens the stream prematurely', () => {
  const res = fakeRes();
  const emitter = createStreamEmitter(res);
  emitter.delta('', {});
  emitter.delta(null, {});
  assert.equal(res.headers, null);
  assert.equal(res.written.length, 0);
});

// --- resolveReplyText (Decision Engine / Orchestrator seam) ---------------

test('resolveReplyText for a capability/tool result reports back the capability\'s returned text', () => {
  assert.equal(
    resolveReplyText({ action: 'capability', capability: 'hermes', output: 'already streamed via onDelta' }),
    'already streamed via onDelta'
  );
});

test('resolveReplyText treats a tool result the same way as a capability result', () => {
  assert.equal(resolveReplyText({ action: 'tool', capability: 'web', output: 'search result' }), 'search result');
});

test('resolveReplyText returns null when a capability/tool produced no usable output', () => {
  assert.equal(resolveReplyText({ action: 'capability', output: null }), null);
  assert.equal(resolveReplyText({ action: 'capability', output: '' }), null);
});

test('resolveReplyText for clarify renders Gaia\'s own calm words, without any capability', () => {
  assert.equal(resolveReplyText({ action: 'clarify', output: null, reason: 'ambiguous' }), CLARIFY_FALLBACK);
});

test('resolveReplyText for refuse renders Gaia\'s own calm words, without any capability', () => {
  assert.equal(resolveReplyText({ action: 'refuse', output: null, reason: 'policy' }), REFUSE_FALLBACK);
});

test('resolveReplyText for native with output reports back the native generator\'s text', () => {
  assert.equal(resolveReplyText({ action: 'native', output: 'already streamed via onDelta' }), 'already streamed via onDelta');
});

test('resolveReplyText returns null for native with no output', () => {
  assert.equal(resolveReplyText({ action: 'native', output: null }), null);
});

test('resolveReplyText returns null when there is no execution result at all', () => {
  assert.equal(resolveReplyText(null), null);
});

// === PATCH 1-3: Image availability responses ==============================

test('resolveReplyText returns image unavailable response for image_unavailable action', () => {
  const { IMAGE_UNAVAILABLE_RESPONSE } = require('../src/responseEngine');
  assert.equal(resolveReplyText({ action: 'image_unavailable', output: null }), IMAGE_UNAVAILABLE_RESPONSE);
});

test('resolveReplyText returns image unknown response for image_unknown action', () => {
  const { IMAGE_UNKNOWN_RESPONSE } = require('../src/responseEngine');
  assert.equal(resolveReplyText({ action: 'image_unknown', output: null }), IMAGE_UNKNOWN_RESPONSE);
});

// === PATCH 6: Response Engine override for meta-intents ===================

test('resolveReplyText returns null for meta-intents (override capability candidate)', () => {
  // When user asks about Gaia's previous behavior, Response Engine should override
  // the capability candidate and answer directly from conversation context
  const result = resolveReplyText(
    { action: 'capability', output: 'web search result' },
    { intent: { intent: 'meta.question', status: 'accepted' } }
  );
  // The Response Engine should override and return null to let native handle it
  assert.equal(result, null);
});

test('resolveReplyText returns null for meta.correction intents', () => {
  const result = resolveReplyText(
    { action: 'capability', output: 'some result' },
    { intent: { intent: 'meta.correction', status: 'accepted' } }
  );
  assert.equal(result, null);
});

test('resolveReplyText returns null for meta.capability_question intents', () => {
  const result = resolveReplyText(
    { action: 'tool', output: 'search result' },
    { intent: { intent: 'meta.capability_question', status: 'accepted' } }
  );
  assert.equal(result, null);
});

test('resolveReplyText does NOT override non-meta intents', () => {
  // For regular intents, the capability output should be returned
  const result = resolveReplyText(
    { action: 'capability', output: 'web search result' },
    { intent: { intent: 'inform.explain', status: 'accepted' } }
  );
  assert.equal(result, 'web search result');
});
