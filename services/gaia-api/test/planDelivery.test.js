'use strict';

/**
 * Delivery guarantees for v3.0 direct-generation turns — the
 * client-visible half of the live path.
 *
 * The configured generation route produces the answer; the Response
 * Engine is the only thing that puts it on the wire. Three rules are
 * pinned here, all of them about one promise: what generation composed
 * as the answer is exactly what the client sees, in full.
 *
 *   1. The reply reaches the client exactly once: streamed during
 *      generation when the generator streamed, written as one final
 *      delta when it did not. Never twice, never zero times.
 *   2. A failed turn leaves no partial answer standing in for the real
 *      one — a calm error instead, never [DONE] on failure, never a
 *      transport detail on the wire.
 *   3. Failover to the backup happens only before visible output; after
 *      the first token the failure is reported, never retried.
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

/** Every parsed JSON frame of the stream, in wire order. */
function frames(res) {
  return res.written
    .filter((frame) => frame.startsWith('data: {'))
    .map((frame) => JSON.parse(frame.slice('data: '.length)));
}

function baseInput(res) {
  return {
    messages: [{ role: 'user', content: 'wat zei ik daar vorige maand over?' }],
    documents: { 'soul.md': 'SOUL' },
    res,
    historyStore: { saveConversation() {} },
  };
}

test('direct generation delivers the answer once; nothing else reaches the stream', async () => {
  const res = fakeRes();
  const FINAL = 'Het antwoord in Gaia\'s eigen stem.';
  await performStreamingTurn({
    ...baseInput(res),
    generator: {
      generate: async () => FINAL,
      stream: async (messages, { onDelta }) => { onDelta(FINAL, false); return FINAL; },
    },
  });

  assert.equal(streamedText(res), FINAL);
  assert.equal(res.ended, true);
});

test('a reply that streamed during generation is not emitted a second time', async () => {
  const res = fakeRes();
  const FINAL = 'Alleen dit antwoord, precies één keer.';
  await performStreamingTurn({
    ...baseInput(res),
    generator: {
      generate: async () => FINAL,
      stream: async (messages, { onDelta }) => { onDelta(FINAL, false); return FINAL; },
    },
  });

  assert.equal(streamedText(res), FINAL);
  const contentFrames = res.written.filter((f) => f.startsWith('data: {')).length;
  assert.equal(contentFrames, 1, 'the reply must reach the client exactly once');
});

test('a generate-only provider behind a streaming transport still delivers its text', async () => {
  const res = fakeRes();
  const FOUND = 'Het antwoord van een niet-streamende generator.';
  await performStreamingTurn({
    ...baseInput(res),
    generator: {
      generate: async () => FOUND,
    },
  });

  assert.equal(streamedText(res), FOUND, 'a non-streaming generator must still deliver its text');
  assert.equal(res.ended, true);
  assert.equal(res.jsonBody, null);
});

test('a failed generation before any output is a clean calm JSON error, never a half-open stream', async () => {
  const res = fakeRes();
  await performStreamingTurn({
    ...baseInput(res),
    generator: {
      generate: async () => { throw new Error('primary unreachable'); },
      stream: async () => { throw new Error('primary unreachable at http://internal:8642'); },
    },
  });

  assert.equal(streamedText(res), '', 'no partial text may stand in for the answer');
  assert.equal(res.statusCode, 502);
  assert.equal(res.jsonBody.error, 'gaia could not answer right now');
  assert.equal(res.headers, null, 'the stream must never open for a failure with no output');
  assert.ok(!JSON.stringify(res.jsonBody).includes('8642'), 'no transport detail may reach the client');
});

test('a mid-stream generation failure ends the stream with a calm error frame, never [DONE]', async () => {
  const res = fakeRes();
  await performStreamingTurn({
    ...baseInput(res),
    generator: {
      generate: async () => { throw new Error('unreachable'); },
      stream: async (messages, { onDelta }) => {
        onDelta('partial', false);
        throw new Error('connection dropped at http://internal:8642');
      },
    },
  });

  // The open stream cannot become a JSON body anymore: the failure rides
  // as a calm error frame, without [DONE] ever claiming completion.
  const last = frames(res).at(-1);
  assert.equal(last.type, 'error');
  assert.equal(last.error, 'gaia could not answer right now');
  assert.equal(res.ended, true);
  assert.ok(!res.written.includes('data: [DONE]\n\n'));
  assert.ok(!res.written.join('').includes('8642'), 'no transport detail may reach the client');
});

test('no provider or model name ever reaches the wire', async () => {
  const res = fakeRes();
  await performStreamingTurn({
    ...baseInput(res),
    generator: {
      generate: async () => 'ok',
      stream: async (messages, { onDelta }) => { onDelta('ok', false); return 'ok'; },
    },
  });

  const wire = res.written.join('');
  assert.ok(!wire.toLowerCase().includes('hermes'), 'no capability name may reach the client');
  assert.ok(!wire.includes('8642'), 'no transport detail may reach the client');
});
