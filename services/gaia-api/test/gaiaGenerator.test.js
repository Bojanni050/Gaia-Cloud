'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGaiaGenerator, readNativeConfig, isConfigured, createFromEnv } = require('../src/generation/gaiaGenerator');

// --- Configuration --------------------------------------------------------

test('readNativeConfig reads from environment variables', () => {
  const env = {
    GAIA_NATIVE_BASE_URL: 'http://test:1234/v1',
    GAIA_NATIVE_MODEL: 'test-model',
    GAIA_NATIVE_AUTH_TOKEN: 'test-token',
  };
  const config = readNativeConfig(env);
  assert.equal(config.baseUrl, 'http://test:1234/v1');
  assert.equal(config.model, 'test-model');
  assert.equal(config.authToken, 'test-token');
});

test('readNativeConfig defaults to empty strings when env vars are unset', () => {
  const config = readNativeConfig({});
  assert.equal(config.baseUrl, '');
  assert.equal(config.model, '');
  assert.equal(config.authToken, '');
});

test('isConfigured requires both baseUrl and model', () => {
  assert.equal(isConfigured({ baseUrl: '', model: '' }), false);
  assert.equal(isConfigured({ baseUrl: 'http://x', model: '' }), false);
  assert.equal(isConfigured({ baseUrl: '', model: 'x' }), false);
  assert.equal(isConfigured({ baseUrl: 'http://x', model: 'x' }), true);
});

// --- createFromEnv (the composition server.js uses) -----------------------

test('createFromEnv returns undefined when GAIA_NATIVE_* is unset — the documented "route everything through Hermes" degrade', () => {
  assert.equal(createFromEnv({}), undefined);
});

test('createFromEnv returns undefined when only one of baseUrl/model is set', () => {
  assert.equal(createFromEnv({ GAIA_NATIVE_BASE_URL: 'http://test' }), undefined);
  assert.equal(createFromEnv({ GAIA_NATIVE_MODEL: 'test-model' }), undefined);
});

test('createFromEnv returns a working generator when both baseUrl and model are set', () => {
  const generator = createFromEnv({ GAIA_NATIVE_BASE_URL: 'http://test:1234/v1', GAIA_NATIVE_MODEL: 'test-model' });
  assert.ok(generator);
  assert.equal(typeof generator.generate, 'function');
  assert.equal(typeof generator.stream, 'function');
});

// --- createGaiaGenerator --------------------------------------------------

test('createGaiaGenerator throws when baseUrl is missing', () => {
  assert.throws(() => createGaiaGenerator({ model: 'test' }), /GAIA_NATIVE_BASE_URL/);
});

test('createGaiaGenerator throws when model is missing', () => {
  assert.throws(() => createGaiaGenerator({ baseUrl: 'http://test' }), /GAIA_NATIVE_MODEL/);
});

// --- generate (non-streaming) ---------------------------------------------

test('generate() calls the configured provider and returns the content', async () => {
  const fetchImpl = async (url, options) => {
    assert.match(url, /\/chat\/completions$/);
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'test-model');
    assert.equal(body.stream, false);
    assert.deepEqual(body.messages, [{ role: 'system', content: 'SOUL' }, { role: 'user', content: 'hello' }]);
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'Gaia says hello' } }] }),
    };
  };

  const generator = createGaiaGenerator({ baseUrl: 'http://test:1234/v1', model: 'test-model', fetchImpl });
  const result = await generator.generate([
    { role: 'system', content: 'SOUL' },
    { role: 'user', content: 'hello' },
  ]);
  assert.equal(result, 'Gaia says hello');
});

test('generate() sends auth token when configured', async () => {
  let seenHeaders;
  const fetchImpl = async (url, options) => {
    seenHeaders = options.headers;
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
    };
  };

  const generator = createGaiaGenerator({ baseUrl: 'http://test', model: 'test', authToken: 'secret', fetchImpl });
  await generator.generate([{ role: 'user', content: 'hi' }]);
  assert.equal(seenHeaders.Authorization, 'Bearer secret');
});

test('generate() throws on network failure without leaking details', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  const generator = createGaiaGenerator({ baseUrl: 'http://test', model: 'test', fetchImpl });
  await assert.rejects(
    () => generator.generate([{ role: 'user', content: 'hi' }]),
    /native generator unreachable/
  );
});

test('generate() throws on non-200 response', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, text: async () => 'internal error' });
  const generator = createGaiaGenerator({ baseUrl: 'http://test', model: 'test', fetchImpl });
  await assert.rejects(
    () => generator.generate([{ role: 'user', content: 'hi' }]),
    /native generator responded with an error/
  );
});

test('generate() throws when response has no content', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: '' } }] }),
  });
  const generator = createGaiaGenerator({ baseUrl: 'http://test', model: 'test', fetchImpl });
  await assert.rejects(
    () => generator.generate([{ role: 'user', content: 'hi' }]),
    /native generator returned no content/
  );
});

// --- Architectural invariant: Hermes is never called ----------------------

test('the native generator has no code-level dependency on Hermes — it is a completely independent module', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.resolve(__dirname, '../src/generation/gaiaGenerator.js'), 'utf-8');
  // Strip comments (both // and /* */) to check only executable code.
  const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
  assert.ok(!codeOnly.includes('hermesClient'), 'gaiaGenerator.js must not import or require hermesClient');
  assert.ok(!codeOnly.includes("require('../hermesClient"), 'gaiaGenerator.js must not require hermesClient');
  assert.ok(!codeOnly.includes("require('./hermesClient"), 'gaiaGenerator.js must not require hermesClient');
});

// --- stream (streaming) ---------------------------------------------------

test('stream() returns accumulated text and calls onDelta for each chunk', async () => {
  const chunks = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'Hel' } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'lo' } }] })}\n\n`,
    'data: [DONE]\n\n',
  ];
  let chunkIndex = 0;

  const fetchImpl = async () => ({
    ok: true,
    body: {
      getReader: () => ({
        read: async () => {
          if (chunkIndex >= chunks.length) return { done: true };
          const value = new TextEncoder().encode(chunks[chunkIndex++]);
          return { value, done: false };
        },
      }),
    },
  });

  const deltas = [];
  const generator = createGaiaGenerator({ baseUrl: 'http://test', model: 'test', fetchImpl });
  const result = await generator.stream(
    [{ role: 'user', content: 'hi' }],
    { onDelta: (chunk, isReasoning) => deltas.push({ chunk, isReasoning }) }
  );

  assert.equal(result, 'Hello');
  assert.deepEqual(deltas, [
    { chunk: 'Hel', isReasoning: false },
    { chunk: 'lo', isReasoning: false },
  ]);
});

// --- tool loop (on-demand memory) -----------------------------------------

const REMEMBER_TOOL = [{ type: 'function', function: { name: 'remember', parameters: { type: 'object', properties: { text: { type: 'string' } } } } }];

function sseBody(frames) {
  let i = 0;
  return {
    getReader: () => ({
      read: async () => {
        if (i >= frames.length) return { done: true };
        return { value: new TextEncoder().encode(frames[i++]), done: false };
      },
    }),
  };
}

test('generate() executes a tool call and returns the final text', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    if (calls.length === 1) {
      return { ok: true, json: async () => ({ choices: [{ message: { content: '', tool_calls: [{ id: 'c1', function: { name: 'remember', arguments: '{"text":"Bo likes tea"}' } }] } }] }) };
    }
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'Noted.' } }] }) };
  };
  const executed = [];
  const generator = createGaiaGenerator({
    baseUrl: 'http://test', model: 'test', fetchImpl,
    tools: REMEMBER_TOOL,
    onToolCall: async (name, args) => { executed.push({ name, args }); return 'Kept.'; },
  });

  const result = await generator.generate([{ role: 'user', content: 'remember I like tea' }]);

  assert.equal(result, 'Noted.');
  assert.deepEqual(executed, [{ name: 'remember', args: { text: 'Bo likes tea' } }]);
  assert.ok(Array.isArray(calls[0].tools));
  assert.equal(calls[1].messages.at(-1).role, 'tool');
  assert.equal(calls[1].messages.at(-1).content, 'Kept.');
});

test('generate() retries without tools when the provider rejects them (4xx)', async () => {
  const bodies = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    bodies.push(body);
    if (bodies.length === 1) return { ok: false, status: 400, text: async () => 'tools not supported' };
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'hi' } }] }) };
  };
  const generator = createGaiaGenerator({
    baseUrl: 'http://test', model: 'test', fetchImpl,
    tools: REMEMBER_TOOL, onToolCall: async () => 'x',
  });

  assert.equal(await generator.generate([{ role: 'user', content: 'hi' }]), 'hi');
  assert.equal(bodies.length, 2);
  assert.ok(bodies[0].tools);
  assert.equal(bodies[1].tools, undefined);
});

// Tool usage used to be invisible: after the 18-10-2026 Yassine conversation
// there was no way to tell whether Gaia had reached for `search_memory` and
// found nothing, or never called it. These two tests pin the record that fixes
// that (see src/toolLog.js).
test('generate() logs one tool.call record per tool call, with round and conversation id', async () => {
  const lines = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    const answered = body.messages.some((message) => message.role === 'tool');
    return answered
      ? { ok: true, json: async () => ({ choices: [{ message: { content: 'Noted.' } }] }) }
      : { ok: true, json: async () => ({ choices: [{ message: { content: '', tool_calls: [{ id: 'c1', function: { name: 'search_memory', arguments: '{"query":"yassine"}' } }] } }] }) };
  };
  const generator = createGaiaGenerator({
    baseUrl: 'http://test', model: 'test', fetchImpl,
    logger: (line) => lines.push(line),
    tools: REMEMBER_TOOL,
    onToolCall: async () => 'Nothing in memory about that.',
  });

  const result = await generator.generate([{ role: 'user', content: 'wat weet je over Yassine?' }], { sessionId: 'conv-9' });

  assert.equal(result, 'Noted.');
  const records = lines.map((line) => JSON.parse(line)).filter((record) => record.kind === 'tool.call');
  assert.equal(records.length, 1);
  assert.equal(records[0].tool, 'search_memory');
  assert.equal(records[0].round, 1);
  assert.equal(records[0].conversationId, 'conv-9');
  assert.equal(records[0].outcome, 'empty');
  assert.equal(records[0].ok, true);
  assert.equal(records[0].resultChars, 'Nothing in memory about that.'.length);
  assert.ok(!lines.join('').includes('yassine'), 'the search phrase never reaches the log');
});

test('generate() records a tool round that failed instead of throwing', async () => {
  const lines = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    const answered = body.messages.some((message) => message.role === 'tool');
    return answered
      ? { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) }
      : { ok: true, json: async () => ({ choices: [{ message: { content: '', tool_calls: [{ id: 'c1', function: { name: 'search_memory', arguments: '{}' } }] } }] }) };
  };
  const generator = createGaiaGenerator({
    baseUrl: 'http://test', model: 'test', fetchImpl,
    logger: (line) => lines.push(line),
    tools: REMEMBER_TOOL,
    onToolCall: async () => { throw new Error('memory down'); },
  });

  await generator.generate([{ role: 'user', content: 'x' }]);

  const records = lines.map((line) => JSON.parse(line)).filter((record) => record.kind === 'tool.call');
  assert.equal(records.length, 1);
  assert.equal(records[0].ok, false);
  assert.equal(records[0].outcome, 'failed');
});

test('generate() records that a turn was retried without tools at all', async () => {
  const lines = [];
  const bodies = [];
  const fetchImpl = async (url, options) => {
    bodies.push(JSON.parse(options.body));
    if (bodies.length === 1) return { ok: false, status: 400, text: async () => 'tools not supported' };
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'hi' } }] }) };
  };
  const generator = createGaiaGenerator({
    baseUrl: 'http://test', model: 'test', fetchImpl,
    logger: (line) => lines.push(line),
    tools: REMEMBER_TOOL, onToolCall: async () => 'x',
  });

  await generator.generate([{ role: 'user', content: 'hi' }], { sessionId: 'conv-7' });

  const records = lines.map((line) => JSON.parse(line)).filter((record) => record.kind === 'tool.unavailable');
  assert.equal(records.length, 1);
  assert.equal(records[0].reason, 'tools_rejected');
  assert.equal(records[0].status, 400);
  assert.equal(records[0].conversationId, 'conv-7');
});

test('generate() stops after maxToolRounds and returns the last text', async () => {
  let n = 0;
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: '', tool_calls: [{ id: `c${n}`, function: { name: 'remember', arguments: '{}' } }] } }] }),
  });
  const generator = createGaiaGenerator({
    baseUrl: 'http://test', model: 'test', fetchImpl,
    tools: REMEMBER_TOOL, onToolCall: async () => { n += 1; return 'Kept.'; }, maxToolRounds: 2,
  });

  await assert.rejects(() => generator.generate([{ role: 'user', content: 'x' }]), /exhausted tool rounds/);
  assert.equal(n, 2); // two rounds of execution, then the budget is spent
});

test('stream() runs the tool loop and streams only the final answer', async () => {
  let call = 0;
  const toolFrame = `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'remember', arguments: '{"text":"x"}' } }] } }] })}\n\n`;
  const fetchImpl = async () => {
    call += 1;
    if (call === 1) return { ok: true, body: sseBody([toolFrame, 'data: [DONE]\n\n']) };
    return { ok: true, body: sseBody([`data: ${JSON.stringify({ choices: [{ delta: { content: 'Noted.' } }] })}\n\n`, 'data: [DONE]\n\n']) };
  };
  const deltas = [];
  const generator = createGaiaGenerator({
    baseUrl: 'http://test', model: 'test', fetchImpl,
    tools: REMEMBER_TOOL, onToolCall: async () => 'Kept.',
  });

  const result = await generator.stream([{ role: 'user', content: 'remember x' }], { onDelta: (c) => deltas.push(c) });

  assert.equal(result, 'Noted.');
  assert.deepEqual(deltas, ['Noted.']);
  assert.equal(call, 2);
});

test('stream() does not expose draft content emitted before a tool call', async () => {
  let call = 0;
  const firstFrame = `data: ${JSON.stringify({ choices: [{ delta: { content: 'internal draft', tool_calls: [{ index: 0, id: 'c1', function: { name: 'remember', arguments: '{}' } }] } }] })}\n\n`;
  const fetchImpl = async () => {
    call += 1;
    if (call === 1) return { ok: true, body: sseBody([firstFrame, 'data: [DONE]\n\n']) };
    return { ok: true, body: sseBody([`data: ${JSON.stringify({ choices: [{ delta: { content: 'Final answer.' } }] })}\n\n`, 'data: [DONE]\n\n']) };
  };
  const deltas = [];
  const generator = createGaiaGenerator({
    baseUrl: 'http://test', model: 'test', fetchImpl,
    tools: REMEMBER_TOOL, onToolCall: async () => 'Kept.',
  });

  const result = await generator.stream([{ role: 'user', content: 'remember this' }], { onDelta: (c) => deltas.push(c) });

  assert.equal(result, 'Final answer.');
  assert.deepEqual(deltas, ['Final answer.']);
});

// --- per-call tools (desktop) ------------------------------------------------------

test('stream() offers per-call tools on top of constructor tools and routes each call to its own handler', async () => {
  const { createGaiaGenerator } = require('../src/generation/gaiaGenerator');
  const sent = [];
  let round = 0;
  const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
  const fetchImpl = async (url, init) => {
    sent.push(JSON.parse(init.body));
    round += 1;
    const body = round === 1
      ? sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'desktop', arguments: '{"skill":"file-read","input":{}}' } }] } }] }) + 'data: [DONE]\n\n'
      : sse({ choices: [{ delta: { content: 'klaar' } }] }) + 'data: [DONE]\n\n';
    const encoder = new TextEncoder();
    return { ok: true, status: 200, body: new ReadableStream({ start(c) { c.enqueue(encoder.encode(body)); c.close(); } }) };
  };
  const ctorTool = { type: 'function', function: { name: 'remember', parameters: { type: 'object', properties: {} } } };
  const callTool = { type: 'function', function: { name: 'desktop', parameters: { type: 'object', properties: {} } } };
  const handled = [];
  const gen = createGaiaGenerator({
    baseUrl: 'http://x', model: 'm', fetchImpl,
    tools: [ctorTool], onToolCall: async (name) => { handled.push(`ctor:${name}`); return 'no'; },
  });
  const out = await gen.stream([{ role: 'user', content: 'hi' }], {
    onDelta() {},
    tools: [callTool],
    onToolCall: async (name) => { handled.push(`call:${name}`); return 'file data'; },
  });
  assert.equal(out, 'klaar');
  assert.deepEqual(sent[0].tools.map((t) => t.function.name), ['remember', 'desktop']);
  assert.deepEqual(handled, ['call:desktop']);
  // And the next call without per-call tools is back to the constructor's tools only.
  round = 1;
  await gen.stream([{ role: 'user', content: 'hi' }], { onDelta() {} });
  assert.deepEqual(sent.at(-1).tools.map((t) => t.function.name), ['remember']);
});

test('stream() records a refused desktop skill as a skill.gap, with the skill she asked for', async () => {
  const { createGaiaGenerator } = require('../src/generation/gaiaGenerator');
  const lines = [];
  let round = 0;
  const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
  const fetchImpl = async () => {
    round += 1;
    const body = round === 1
      ? sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'desktop', arguments: '{"skill":"send-email","input":{"to":"piet@example.nl"}}' } }] } }] }) + 'data: [DONE]\n\n'
      : sse({ choices: [{ delta: { content: 'dat kan ik niet' } }] }) + 'data: [DONE]\n\n';
    const encoder = new TextEncoder();
    return { ok: true, status: 200, body: new ReadableStream({ start(c) { c.enqueue(encoder.encode(body)); c.close(); } }) };
  };
  const callTool = { type: 'function', function: { name: 'desktop', parameters: { type: 'object', properties: {} } } };
  const gen = createGaiaGenerator({
    baseUrl: 'http://x', model: 'm', fetchImpl,
    logger: (line) => lines.push(line),
  });
  await gen.stream([{ role: 'user', content: 'mail Piet even' }], {
    sessionId: 'conv-3',
    onDelta() {},
    tools: [callTool],
    onToolCall: async () => 'That is not something the desktop can do.',
  });

  const gaps = lines.map((line) => JSON.parse(line)).filter((record) => record.kind === 'skill.gap');
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].reason, 'unknown-skill');
  assert.equal(gaps[0].capability, 'desktop');
  assert.equal(gaps[0].skill, 'send-email');
  assert.equal(gaps[0].conversationId, 'conv-3');
  assert.equal(gaps[0].round, 1);
  assert.ok(!lines.join('').includes('piet@example.nl'), 'no argument value reaches the log');
});
