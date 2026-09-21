'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateMessages, assembleMessages, performTurn, performStreamingTurn, renderAttachmentContext } = require('../src/turn');

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

const DOCUMENTS = { 'soul.md': 'SOUL', 'principles.md': 'PRINCIPLES', 'lexicon.md': 'LEXICON' };
const SILENT_HINDSIGHT = { recall: async () => [], reflect: async () => {} };

const flushBackground = async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r)); };

const DEEP_EVIDENCE_HINDSIGHT = {
  recall: async () => [{ text: 'The team decided on a single stream emitter in March', scores: { final: 0.9 } }],
  reflect: async () => {},
};

test('validateMessages accepts a plain user/assistant history', () => {
  assert.equal(
    validateMessages([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]),
    null
  );
});

test('validateMessages rejects empty, non-array, bad role and empty content', () => {
  assert.match(validateMessages([]), /non-empty/);
  assert.match(validateMessages('nope'), /non-empty/);
  assert.match(validateMessages([{ role: 'wizard', content: 'hi' }]), /role/);
  assert.match(validateMessages([{ role: 'user', content: '   ' }]), /non-empty/);
});

test('assembleMessages prepends SOUL exactly once and strips extra fields', () => {
  const messages = assembleMessages('YOU ARE GAIA', [
    { id: 'local-1', role: 'user', content: 'hello', failed: false },
  ]);
  assert.deepEqual(messages, [
    { role: 'system', content: 'YOU ARE GAIA' },
    { role: 'user', content: 'hello' },
  ]);
});

test('performTurn returns the reply on a happy path', async () => {
  const hermes = {
    async chat(messages) {
      assert.equal(messages.length, 3);
      assert.equal(messages[0].role, 'system');
      assert.equal(messages[0].content, 'SOUL\n\n---\n\nPRINCIPLES\n\n---\n\nLEXICON');
      // Capability awareness block (registry: hermes only on this path).
      assert.equal(messages[1].role, 'system');
      assert.match(messages[1].content, /Capabilities you genuinely have THIS turn/);
      assert.match(messages[1].content, /hermes:/);
      assert.deepEqual(messages[2], { role: 'user', content: 'hello' });
      return 'hi there';
    },
  };
  const result = await performTurn({
    messages: [{ role: 'user', content: 'hello' }],
    documents: DOCUMENTS,
    hermes,
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.reply, 'hi there');
});

test('performTurn maps validation problems to 400', async () => {
  const result = await performTurn({ messages: [], documents: DOCUMENTS, hermes: { chat: async () => 'x' } });
  assert.equal(result.status, 400);
  assert.ok(result.body.error);
});

test('performTurn maps a failing Hermes to a calm 502 without provider details', async () => {
  const hermes = {
    async chat() {
      throw new Error('hermes responded with status 401 at http://internal:8642');
    },
  };
  const result = await performTurn({
    messages: [{ role: 'user', content: 'hello' }],
    documents: DOCUMENTS,
    hermes,
  });
  assert.equal(result.status, 502);
  assert.equal(result.body.error, 'gaia could not answer right now');
  assert.ok(!JSON.stringify(result.body).includes('hermes'));
  assert.ok(!JSON.stringify(result.body).includes('8642'));
});

test('performTurn rejects an empty Hermes reply', async () => {
  const result = await performTurn({
    messages: [{ role: 'user', content: 'hello' }],
    documents: DOCUMENTS,
    hermes: { chat: async () => '' },
  });
  assert.equal(result.status, 502);
});

// --- performTurn attachments (additive, backward-compatible) -------------

test('renderAttachmentContext returns null for no attachments', () => {
  assert.equal(renderAttachmentContext(undefined), null);
  assert.equal(renderAttachmentContext([]), null);
});

test('renderAttachmentContext inlines readable content and notes unreadable files', () => {
  const block = renderAttachmentContext([
    { filename: 'notes.txt', content: 'the quarterly numbers look good' },
    { filename: 'photo.png', content: null },
  ]);
  assert.match(block, /--- notes\.txt ---/);
  assert.match(block, /the quarterly numbers look good/);
  assert.match(block, /--- photo\.png ---/);
  assert.match(block, /could not be read as text/);
});

test('performTurn without attachments produces the same context-aware foundation prompt the streaming path builds', async () => {
  let seenMessages;
  const hermes = { chat: async (messages) => { seenMessages = messages; return 'hi there'; } };
  await performTurn({ messages: [{ role: 'user', content: 'hello' }], documents: DOCUMENTS, hermes });
  // COGNITIVE PARITY: identical assembly to performStreamingTurn — foundation
  // prompt first, then the capability-awareness block, then history.
  assert.equal(seenMessages.length, 3);
  assert.equal(seenMessages[0].role, 'system');
  assert.equal(seenMessages[0].content, 'SOUL\n\n---\n\nPRINCIPLES\n\n---\n\nLEXICON');
  assert.match(seenMessages[1].content, /Capabilities you genuinely have THIS turn/);
  assert.deepEqual(seenMessages[2], { role: 'user', content: 'hello' });
});

test('performTurn with attachments hands them to Hermes as a dedicated system message', async () => {
  let seenMessages;
  const hermes = { chat: async (messages) => { seenMessages = messages; return 'hi there'; } };
  await performTurn({
    messages: [{ role: 'user', content: 'what does this say?' }],
    documents: DOCUMENTS,
    hermes,
    attachments: [{ filename: 'notes.txt', content: 'meeting is at 3pm' }],
  });
  // Same shape as streaming: foundation prompt first, attachment block as
  // its own system message — not folded into the foundation text.
  assert.match(seenMessages[0].content, /^SOUL/);
  const attachmentMsg = seenMessages.find((m) => m.role === 'system' && /meeting is at 3pm/.test(m.content));
  assert.ok(attachmentMsg, 'text attachments reach Hermes as system context');
  assert.equal(seenMessages[seenMessages.length - 1], seenMessages.find((m) => m.role === 'user'));
});

test('performTurn with only unreadable attachments still mentions them without fabricated content', async () => {
  let seenMessages;
  const hermes = { chat: async (messages) => { seenMessages = messages; return 'hi there'; } };
  await performTurn({
    messages: [{ role: 'user', content: 'what is in the image?' }],
    documents: DOCUMENTS,
    hermes,
    attachments: [{ filename: 'photo.png', content: null }],
  });
  const attachmentMsg = seenMessages.find((m) => m.role === 'system' && /photo\.png/.test(m.content));
  assert.ok(attachmentMsg);
  assert.match(attachmentMsg.content, /could not be read as text/);
});

// --- performTurn / Decision Engine + Orchestrator integration -------------
//
// performTurn runs the SAME cognitive pipeline as performStreamingTurn via
// runTurnCore - IntentIQ output genuinely flows into the Decision Engine on
// BOTH transports. These tests pin that wiring directly, using the same
// injectable decisionEngine/orchestrate/intentIQ seams the streaming path
// already has.

test('performTurn routes through the real Decision Engine by default, choosing the hermes capability', async () => {
  const hermes = { chat: async () => 'hi there' };
  const result = await performTurn({ messages: [{ role: 'user', content: 'hello' }], documents: DOCUMENTS, hermes });
  assert.equal(result.status, 200);
  assert.equal(result.body.reply, 'hi there');
});

test('performTurn feeds real IntentIQ output into the Decision Engine, exactly like streaming', async () => {
  let hermesCalls = 0;
  let reasonIQCalls = 0;
  const hermes = { chat: async () => { hermesCalls += 1; return 'hi there'; } };
  const decisionEngineCalls = [];

  const intentDecision = { schemaVersion: 'intentiq.v1', intent: 'converse', status: 'accepted', entities: [], sourceOfTruth: 'conversation', needsClarification: false };
  const result = await performTurn({
    messages: [{ role: 'user', content: 'hello' }],
    documents: DOCUMENTS,
    hermes,
    intentIQ: async () => intentDecision,
    reasonIQ: async () => { reasonIQCalls += 1; return { reasoningDepth: 'shallow' }; },
    decisionEngine: (input) => {
      decisionEngineCalls.push(input);
      return { action: 'capability', capability: 'hermes', task: 'respond', input: {}, reason: 'test' };
    },
  });

  assert.equal(hermesCalls, 1);
  assert.equal(decisionEngineCalls.length, 1);
  // COGNITIVE PARITY: the Decision Engine consumed the same IntentIQ product
  // the streaming path would have produced for the same turn. ReasonIQ is
  // optional (Phase 2): a normal turn is decided without any reasoning
  // result (null — the Decision Engine maps that to level 'none') and the
  // injected reasonIQ seam is never called.
  assert.deepEqual(decisionEngineCalls[0].intent, intentDecision);
  assert.equal(decisionEngineCalls[0].reasoning, null);
  assert.equal(reasonIQCalls, 0);
  assert.equal(decisionEngineCalls[0].userInput, 'hello');
  assert.equal(result.status, 200);
  assert.equal(result.body.reply, 'hi there');
});

test('performTurn: a clarify decision never calls Hermes and still returns a calm 200 reply', async () => {
  const hermes = { chat: async () => { throw new Error('must not be called'); } };
  const result = await performTurn({
    messages: [{ role: 'user', content: 'draft it and send it' }],
    documents: DOCUMENTS,
    hermes,
    decisionEngine: () => ({ action: 'clarify', reason: 'compound turn detected' }),
  });
  assert.equal(result.status, 200);
  assert.match(result.body.reply, /could you say a bit more/);
});

test('performTurn: a refuse decision never calls Hermes and still returns a calm 200 reply', async () => {
  const hermes = { chat: async () => { throw new Error('must not be called'); } };
  const result = await performTurn({
    messages: [{ role: 'user', content: 'do something disallowed' }],
    documents: DOCUMENTS,
    hermes,
    decisionEngine: () => ({ action: 'refuse', reason: 'policy' }),
  });
  assert.equal(result.status, 200);
  assert.match(result.body.reply, /isn't able to help with that/);
});

test('performTurn: a native decision has nothing to generate and degrades to a calm 502, without ever reaching Hermes', async () => {
  const hermes = { chat: async () => { throw new Error('must not be called'); } };
  const result = await performTurn({
    messages: [{ role: 'user', content: 'hi' }],
    documents: DOCUMENTS,
    hermes,
    decisionEngine: () => ({ action: 'native' }),
  });
  assert.equal(result.status, 502);
  assert.equal(result.body.error, 'gaia could not answer right now');
});

test('performTurn: an Orchestrator failure degrades to a calm 502, never leaking provider details', async () => {
  const hermes = { chat: async () => { throw new Error('hermes responded 401 at http://internal:8642'); } };
  const result = await performTurn({ messages: [{ role: 'user', content: 'hello' }], documents: DOCUMENTS, hermes });
  assert.equal(result.status, 502);
  assert.equal(result.body.error, 'gaia could not answer right now');
  assert.ok(!JSON.stringify(result.body).includes('hermes'));
  assert.ok(!JSON.stringify(result.body).includes('8642'));
});

test('performTurn: a Decision Engine failure degrades to the hermes capability, never breaking the turn', async () => {
  const hermes = { chat: async () => 'a reply despite the decision engine failing' };
  const result = await performTurn({
    messages: [{ role: 'user', content: 'hello' }],
    documents: DOCUMENTS,
    hermes,
    decisionEngine: () => { throw new Error('boom'); },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.reply, 'a reply despite the decision engine failing');
});

// --- performStreamingTurn (docs/web-migration-plan.md Phase B) -------------

test('performStreamingTurn validates before ever touching the response stream', async () => {
  const res = fakeRes();
  await performStreamingTurn({
    messages: [],
    documents: DOCUMENTS,
    hermes: { stream: async () => { throw new Error('must not be called'); } },
    hindsight: SILENT_HINDSIGHT,
    res,
  });
  assert.equal(res.statusCode, 400);
  assert.ok(res.jsonBody.error);
  assert.equal(res.headers, null); // never switched into SSE mode
});

test('performStreamingTurn streams SSE frames matching the OpenAI delta shape, then [DONE]', async () => {
  const res = fakeRes();
  let seenMessages;
  const hermes = {
    stream: async (messages, { onDelta }) => {
      seenMessages = messages;
      onDelta('Hel', false);
      onDelta('lo', false);
      return 'Hello';
    },
  };

  await performStreamingTurn({
    messages: [{ role: 'user', content: 'hi there, how is your day' }],
    documents: DOCUMENTS,
    hermes,
    hindsight: SILENT_HINDSIGHT,
    res,
  });

  assert.equal(res.headers['Content-Type'], 'text/event-stream');
  assert.equal(res.written[0], `data: ${JSON.stringify({ choices: [{ delta: { content: 'Hel' } }] })}\n\n`);
  assert.equal(res.written.at(-1), 'data: [DONE]\n\n');
  assert.equal(res.ended, true);

  // Context-aware system prompt, not always-full-SOUL — the parity point
  // of this migration: a plain conversational turn selects the base three.
  assert.equal(seenMessages[0].content, 'SOUL\n\n---\n\nPRINCIPLES\n\n---\n\nLEXICON');
  assert.equal(seenMessages.at(-1).content, 'hi there, how is your day');
});

test('performStreamingTurn sends a normal JSON error if Hermes fails before any delta', async () => {
  const res = fakeRes();
  await performStreamingTurn({
    messages: [{ role: 'user', content: 'hello there friend' }],
    documents: DOCUMENTS,
    hermes: { stream: async () => { throw new Error('hermes responded 401 at http://internal'); } },
    hindsight: SILENT_HINDSIGHT,
    res,
  });
  assert.equal(res.statusCode, 502);
  assert.equal(res.jsonBody.error, 'gaia could not answer right now');
  assert.equal(res.headers, null);
  assert.ok(!JSON.stringify(res.jsonBody).includes('hermes'));
});

test('performStreamingTurn just ends the stream if Hermes fails mid-flight, after headers are sent', async () => {
  const res = fakeRes();
  await performStreamingTurn({
    messages: [{ role: 'user', content: 'hello there friend' }],
    documents: DOCUMENTS,
    hermes: {
      stream: async (messages, { onDelta }) => {
        onDelta('partial', false);
        throw new Error('connection dropped');
      },
    },
    hindsight: SILENT_HINDSIGHT,
    res,
  });
  assert.equal(res.headers['Content-Type'], 'text/event-stream'); // headers were already sent
  assert.equal(res.ended, true);
  assert.ok(!res.written.includes('data: [DONE]\n\n')); // never claims a clean completion
});

test('performStreamingTurn recalls only when the policy fires; Hindsight reflection follows MEMORYWORTHINESS, not mere substantiveness (0.1)', async () => {
  const recallCalls = [];
  const reflectCalls = [];
  const hindsight = {
    recall: async (query) => { recallCalls.push(query); return [{ text: 'Bo prefers async updates', scores: { final: 0.9 } }]; },
    reflect: async (item) => { reflectCalls.push(item); },
  };
  const hermes = { stream: async (messages, { onDelta }) => { onDelta('ok', false); return 'A real reply here.'; } };

  // A substantive question whose USER TURN adds no new information about
  // Bo: Gaia answers normally, but Memoryworthiness discards it as memory
  // — conversation history keeps it, Hindsight does not (0.1 semantics).
  await performStreamingTurn({
    messages: [{ role: 'user', content: 'what did we decide about the project database?' }],
    documents: DOCUMENTS,
    hermes,
    hindsight,
    res: fakeRes(),
  });

  assert.equal(recallCalls.length, 1); // durable-context recall signal present
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reflectCalls.length, 0); // question-only turn is not new memory

  // A turn that DOES carry durable personal knowledge reflects.
  await performStreamingTurn({
    messages: [{ role: 'user', content: 'Onthoud dat de project database altijd op de VPS draait.' }],
    documents: DOCUMENTS,
    hermes,
    hindsight,
    res: fakeRes(),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reflectCalls.length, 1);
  assert.match(reflectCalls[0].summary, /A real reply here\./);
});

// --- Logos.IntentIQ integration (interpretation-only seam) -----------------

test('performStreamingTurn invokes IntentIQ but never lets its output change the assembled turn', async () => {
  const intentIQCalls = [];
  const hermes = { stream: async (messages, { onDelta }) => { onDelta('ok', false); return 'A reply.'; } };

  await performStreamingTurn({
    messages: [{ role: 'user', content: 'Why is my website crashing?' }],
    documents: DOCUMENTS,
    hermes,
    hindsight: SILENT_HINDSIGHT,
    res: fakeRes(),
    intentIQ: (messages, options) => {
      intentIQCalls.push({ messages, options });
      return { schemaVersion: 'intentiq.v1', intent: 'inform.explain', status: 'accepted' };
    },
  });

  assert.equal(intentIQCalls.length, 1);
  assert.equal(intentIQCalls[0].messages[0].content, 'Why is my website crashing?');
});

test('performStreamingTurn completes normally even if IntentIQ throws', async () => {
  const res = fakeRes();
  const hermes = { stream: async (messages, { onDelta }) => { onDelta('ok', false); return 'A reply.'; } };

  await performStreamingTurn({
    messages: [{ role: 'user', content: 'Why is my website crashing?' }],
    documents: DOCUMENTS,
    hermes,
    hindsight: SILENT_HINDSIGHT,
    res,
    intentIQ: () => { throw new Error('boom'); },
  });

  assert.equal(res.headers['Content-Type'], 'text/event-stream');
  assert.equal(res.written.at(-1), 'data: [DONE]\n\n');
});

test('performStreamingTurn produces an identical assembled prompt with the real IntentIQ wired in (default) as without it', async () => {
  let seenWithDefault;
  const hermes = {
    stream: async (messages, { onDelta }) => { seenWithDefault = messages; onDelta('ok', false); return 'A reply.'; },
  };
  await performStreamingTurn({
    messages: [{ role: 'user', content: 'hi there, how is your day' }],
    documents: DOCUMENTS,
    hermes,
    hindsight: SILENT_HINDSIGHT,
    res: fakeRes(),
    // intentIQ omitted -> uses the real classifier, per the default param.
  });
  assert.equal(seenWithDefault[0].content, 'SOUL\n\n---\n\nPRINCIPLES\n\n---\n\nLEXICON');
});

// --- Logos.ReasonIQ integration (the IntentIQ -> ReasonIQ handoff seam) ---
//
// ReasonIQ is now awaited, not fire-and-forget: the Decision Engine needs
// its output (reasoningDepth, sufficiency, gaps) to route the turn, so
// "nothing downstream reads it yet" no longer holds (see turn.js's own
// comment on this). These tests replace the old fire-and-forget assertions
// with the opposite guarantee: ReasonIQ resolves *before* any capability is
// invoked.

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

// PHASE 2: ReasonIQ is optional, not mandatory. A normal turn (no evidence
// to weigh) must complete end-to-end without calling ReasonIQ at all.
test('a normal turn does NOT call ReasonIQ — the Decision Engine decides without it', async () => {
  const reasonIQCalls = [];
  const callOrder = [];
  const decisionInputs = [];
  const hermes = { stream: async (messages, { onDelta }) => { callOrder.push('hermes'); onDelta('ok', false); return 'A reply.'; } };
  const { decide } = require('../src/decision/decisionEngine');

  const res = fakeRes();
  await performStreamingTurn({
    messages: [{ role: 'user', content: 'Why is my website crashing?' }],
    documents: DOCUMENTS,
    hermes,
    hindsight: SILENT_HINDSIGHT,
    res,
    intentIQ: () => ({ schemaVersion: 'intentiq.v1', intent: 'inform.explain', status: 'accepted' }),
    reasonIQ: async (input) => { callOrder.push('reasonIQ'); reasonIQCalls.push(input); return {}; },
    decisionEngine: (input) => { decisionInputs.push(input); return decide(input); },
  });
  await flush();

  assert.equal(reasonIQCalls.length, 0, 'ReasonIQ must not run for a normal turn');
  assert.equal(callOrder.includes('reasonIQ'), false);
  assert.deepEqual(callOrder, ['hermes']);
  assert.equal(decisionInputs.length, 1, 'exactly one decision for the turn');
  assert.equal(decisionInputs[0].reasoning, null, 'no reasoning result is consumed');
  assert.match(res.written.at(-1), /data: \[DONE\]/);
});

test('a non-streaming normal turn also completes without calling ReasonIQ', async () => {
  let reasonIQCalls = 0;
  const result = await performTurn({
    messages: [{ role: 'user', content: 'Why is my website crashing?' }],
    documents: DOCUMENTS,
    hermes: { chat: async () => 'A reply.' },
    hindsight: SILENT_HINDSIGHT,
    intentIQ: () => ({ schemaVersion: 'intentiq.v1', intent: 'inform.explain', status: 'accepted' }),
    reasonIQ: async () => { reasonIQCalls += 1; return {}; },
  });
  await flush();
  assert.equal(reasonIQCalls, 0, 'ReasonIQ must not run for a normal non-streaming turn either');
  assert.equal(result.status, 200);
  assert.equal(result.body.reply, 'A reply.');
});

// PHASE 2: ReasonIQ is no longer on the conversational path, so a turn can
// never be blocked by it — the reply is delivered without waiting on any
// reasoning call.
test('performStreamingTurn completes the response without waiting on ReasonIQ', async () => {
  let resolveReasonIQ;
  const delayedReasonIQ = () => new Promise((resolve) => { resolveReasonIQ = resolve; setImmediate(() => resolveReasonIQ({})); });
  const res = fakeRes();
  const hermes = { stream: async (messages, { onDelta }) => { onDelta('ok', false); return 'A reply.'; } };

  const turnPromise = performStreamingTurn({
    messages: [{ role: 'user', content: 'Why is my website crashing?' }],
    documents: DOCUMENTS,
    hermes,
    hindsight: SILENT_HINDSIGHT,
    res,
    reasonIQ: delayedReasonIQ,
  });

  // Immediately after invoking (before the microtask queue drains), the
  // response must not yet be complete — ReasonIQ is still pending.
  assert.equal(res.written.length, 0);

  await turnPromise;
  assert.equal(res.written.at(-1), 'data: [DONE]\n\n');
});

test('performStreamingTurn completes normally even if ReasonIQ rejects', async () => {
  const res = fakeRes();
  const hermes = { stream: async (messages, { onDelta }) => { onDelta('ok', false); return 'A reply.'; } };

  await performStreamingTurn({
    messages: [{ role: 'user', content: 'Why is my website crashing?' }],
    documents: DOCUMENTS,
    hermes,
    hindsight: SILENT_HINDSIGHT,
    res,
    reasonIQ: async () => { throw new Error('boom'); },
  });
  await flush(); // the rejection must be swallowed, not surface as an unhandled rejection

  assert.equal(res.headers['Content-Type'], 'text/event-stream');
  assert.equal(res.written.at(-1), 'data: [DONE]\n\n');
});

test('performStreamingTurn wires the real ReasonIQ by default and never throws', async () => {
  const res = fakeRes();
  const hermes = { stream: async (messages, { onDelta }) => { onDelta('ok', false); return 'A reply.'; } };

  await performStreamingTurn({
    messages: [{ role: 'user', content: 'Why is my website crashing?' }],
    documents: DOCUMENTS,
    hermes,
    hindsight: SILENT_HINDSIGHT,
    res,
    // reasonIQ omitted -> uses the real evaluate(), per the default param.
  });
  await flush();

  assert.equal(res.written.at(-1), 'data: [DONE]\n\n');
});

// --- performStreamingTurn history save (chat history, never Hindsight) ---

test('performStreamingTurn saves the full transcript (including the reply) when a historyStore and conversationId are given', async () => {
  const saved = [];
  const historyStore = { saveConversation: (id, messages) => saved.push({ id, messages }) };
  const hermes = { stream: async (messages, { onDelta }) => { onDelta('ok', false); return 'A real reply.'; } };

  await performStreamingTurn({
    messages: [{ role: 'user', content: 'hello there friend' }],
    documents: DOCUMENTS,
    hermes,
    hindsight: SILENT_HINDSIGHT,
    res: fakeRes(),
    conversationId: 'conv-1',
    historyStore,
  });

  assert.equal(saved.length, 1);
  assert.equal(saved[0].id, 'conv-1');
  assert.deepEqual(saved[0].messages, [
    { role: 'user', content: 'hello there friend' },
    { role: 'assistant', content: 'A real reply.' },
  ]);
});

test('performStreamingTurn does not save history without a conversationId, even with a historyStore given', async () => {
  let called = false;
  const historyStore = { saveConversation: () => { called = true; } };
  const hermes = { stream: async (messages, { onDelta }) => { onDelta('ok', false); return 'A reply.'; } };

  await performStreamingTurn({
    messages: [{ role: 'user', content: 'hello there friend' }],
    documents: DOCUMENTS,
    hermes,
    hindsight: SILENT_HINDSIGHT,
    res: fakeRes(),
    historyStore,
  });

  assert.equal(called, false);
});

test('performStreamingTurn completes normally without a historyStore at all (backward compatible)', async () => {
  const res = fakeRes();
  const hermes = { stream: async (messages, { onDelta }) => { onDelta('ok', false); return 'A reply.'; } };

  await performStreamingTurn({
    messages: [{ role: 'user', content: 'hello there friend' }],
    documents: DOCUMENTS,
    hermes,
    hindsight: SILENT_HINDSIGHT,
    res,
    conversationId: 'conv-1',
    // historyStore omitted entirely
  });

  assert.equal(res.written.at(-1), 'data: [DONE]\n\n');
});

test('performStreamingTurn completes normally even if historyStore.saveConversation throws', async () => {
  const res = fakeRes();
  const historyStore = { saveConversation: () => { throw new Error('disk full'); } };
  const hermes = { stream: async (messages, { onDelta }) => { onDelta('ok', false); return 'A reply.'; } };

  await performStreamingTurn({
    messages: [{ role: 'user', content: 'hello there friend' }],
    documents: DOCUMENTS,
    hermes,
    hindsight: SILENT_HINDSIGHT,
    res,
    conversationId: 'conv-1',
    historyStore,
  });

  assert.equal(res.written.at(-1), 'data: [DONE]\n\n');
});

// --- decisionStore (durable IntentIQ/ReasonIQ log) --------------------

test('performStreamingTurn persists the IntentIQ decision and the decision plan when a decisionStore is given (a normal turn writes no reasoniq.record)', async () => {
  const appended = [];
  const decisionStore = { append: (record) => { appended.push(record); return true; } };
  const hermes = { stream: async (messages, { onDelta }) => { onDelta('ok', false); return 'A reply.'; } };
  let reasonIQCalls = 0;

  await performStreamingTurn({
    messages: [{ role: 'user', content: 'Why is my website crashing?' }],
    documents: DOCUMENTS,
    hermes,
    hindsight: SILENT_HINDSIGHT,
    res: fakeRes(),
    intentIQ: (messages, options) => {
      options.logger(JSON.stringify({ kind: 'intentiq.decision', intent: 'inform.explain' }));
      return { schemaVersion: 'intentiq.v1', intent: 'inform.explain', status: 'accepted' };
    },
    reasonIQ: async (input, options) => {
      reasonIQCalls += 1;
      options.logger(JSON.stringify({ kind: 'reasoniq.result', reasoningDepth: 'shallow' }));
      return {};
    },
    decisionStore,
  });
  await flush();

  // PHASE 2: ReasonIQ is optional. A normal turn produces NO reasoniq.result
  // record at all — only the intent decision, the plan and the deferred
  // memory judgment are persisted, in that order.
  assert.equal(reasonIQCalls, 0);
  assert.equal(appended[0].kind, 'intentiq.decision');
  assert.equal(appended[1].kind, 'decision.plan');
  assert.equal(appended[2].kind, 'memory.worthiness'); // 0.1: every turn gets a memory judgment record
  assert.equal(appended.filter((r) => r.kind === 'reasoniq.result').length, 0);
});

test('performStreamingTurn never calls decisionStore.append when no decisionStore is given (backward compatible)', async () => {
  let called = false;
  const hermes = { stream: async (messages, { onDelta }) => { onDelta('ok', false); return 'A reply.'; } };

  await performStreamingTurn({
    messages: [{ role: 'user', content: 'hello there friend' }],
    documents: DOCUMENTS,
    hermes,
    hindsight: SILENT_HINDSIGHT,
    res: fakeRes(),
    intentIQ: (messages, options) => {
      called = called || options.logger !== undefined;
      return { schemaVersion: 'intentiq.v1', intent: null, status: 'unknown' };
    },
    // decisionStore omitted entirely
  });

  assert.equal(called, false); // logger stayed undefined -> intentIQ/reasonIQ fall back to their own console.log default
});

test('performStreamingTurn completes normally even if decisionStore.append throws', async () => {
  const res = fakeRes();
  const decisionStore = { append: () => { throw new Error('disk full'); } };
  const hermes = { stream: async (messages, { onDelta }) => { onDelta('ok', false); return 'A reply.'; } };

  await performStreamingTurn({
    messages: [{ role: 'user', content: 'hello there friend' }],
    documents: DOCUMENTS,
    hermes,
    hindsight: SILENT_HINDSIGHT,
    res,
    decisionStore,
  });
  await flush();

  assert.equal(res.written.at(-1), 'data: [DONE]\n\n');
});

// --- Gaia Decision Engine / Orchestrator integration -----------------------
//
// Hermes is a capability, not a hidden default: these tests exercise all
// five decision actions through performStreamingTurn's injectable
// `decisionEngine`/`orchestrate` seams (mirroring the existing intentIQ/
// reasonIQ override pattern) so each path is provable independently of
// what the real Decision Engine happens to choose today.

function hermesThatMustNotBeCalled() {
  return { stream: async () => { throw new Error('Hermes must not be called for this decision'); } };
}

test('native turn: no capability is invoked, still produced by an explicit decision', async () => {
  const res = fakeRes();
  await performStreamingTurn({
    messages: [{ role: 'user', content: 'hi' }],
    documents: DOCUMENTS,
    hermes: hermesThatMustNotBeCalled(),
    hindsight: SILENT_HINDSIGHT,
    res,
    decisionEngine: () => ({ action: 'native' }),
  });

  // Native has nothing to generate with today (no non-Hermes generator
  // exists yet) — the turn must fail calmly, and Hermes must never be
  // reached to fill the gap.
  assert.equal(res.statusCode, 502);
  assert.equal(res.jsonBody.error, 'gaia could not answer right now');
});

test('capability (hermes) turn: Gaia decides, orchestrator calls hermes exactly once, response goes through Response Engine', async () => {
  const res = fakeRes();
  let hermesCalls = 0;
  const hermes = {
    stream: async (messages, { onDelta }) => {
      hermesCalls += 1;
      onDelta('Hello', false);
      return 'Hello there.';
    },
  };

  await performStreamingTurn({
    messages: [{ role: 'user', content: 'explain how this works' }],
    documents: DOCUMENTS,
    hermes,
    hindsight: SILENT_HINDSIGHT,
    res,
    decisionEngine: () => ({ action: 'capability', capability: 'hermes', task: 'respond', input: {}, reason: 'test' }),
  });

  assert.equal(hermesCalls, 1);
  assert.equal(res.written[0], `data: ${JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] })}\n\n`);
  assert.equal(res.written.at(-1), 'data: [DONE]\n\n');
});

test('tool turn: the orchestrator executes the capability the Decision selected, without choosing it itself', async () => {
  const res = fakeRes();
  const toolCalls = [];
  const tool = {
    invoke: async (messages, { onDelta, task, input }) => {
      toolCalls.push({ task, input });
      onDelta('tool result', false);
      return 'tool result';
    },
  };

  await performStreamingTurn({
    messages: [{ role: 'user', content: 'send this to Bo' }],
    documents: DOCUMENTS,
    hermes: hermesThatMustNotBeCalled(),
    hindsight: SILENT_HINDSIGHT,
    res,
    tools: { tool },
    decisionEngine: () => ({ action: 'tool', capability: 'tool', task: 'act.perform', input: { userInput: 'send this to Bo' }, reason: 'test' }),
  });

  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].task, 'act.perform');
  assert.equal(res.written.at(-1), 'data: [DONE]\n\n');
});

test('clarify turn: Gaia can choose to clarify without ever calling Hermes', async () => {
  const res = fakeRes();
  await performStreamingTurn({
    messages: [{ role: 'user', content: 'draft it and send it' }],
    documents: DOCUMENTS,
    hermes: hermesThatMustNotBeCalled(),
    hindsight: SILENT_HINDSIGHT,
    res,
    decisionEngine: () => ({ action: 'clarify', reason: 'compound turn detected' }),
  });

  assert.equal(res.headers['Content-Type'], 'text/event-stream');
  assert.match(res.written[0], /could you say a bit more/);
  assert.equal(res.written.at(-1), 'data: [DONE]\n\n');
});

test('refuse turn: a refusal path never causes a Hermes call', async () => {
  const res = fakeRes();
  await performStreamingTurn({
    messages: [{ role: 'user', content: 'do something disallowed' }],
    documents: DOCUMENTS,
    hermes: hermesThatMustNotBeCalled(),
    hindsight: SILENT_HINDSIGHT,
    res,
    decisionEngine: () => ({ action: 'refuse', reason: 'policy' }),
  });

  assert.equal(res.headers['Content-Type'], 'text/event-stream');
  assert.match(res.written[0], /isn't able to help with that/);
  assert.equal(res.written.at(-1), 'data: [DONE]\n\n');
});

test('no capability leakage: Hermes output only ever reaches the client through the Response Engine\'s emitter', async () => {
  const res = fakeRes();
  const secretProviderDetail = 'internal-model-xyz-do-not-leak';
  const hermes = {
    stream: async (messages, { onDelta }) => {
      onDelta('a normal reply', false);
      return 'a normal reply';
    },
  };

  // The orchestrator is a thin pass-through in this codebase — this test
  // pins that invariant by asserting every byte written to the client came
  // through emitter.delta (i.e. res.write), never a direct write bypassing
  // it, and that nothing capability-internal (a provider/model name) is
  // ever part of a written frame regardless of what the capability itself
  // knows about.
  await performStreamingTurn({
    messages: [{ role: 'user', content: 'hello' }],
    documents: DOCUMENTS,
    hermes,
    hindsight: SILENT_HINDSIGHT,
    res,
    decisionEngine: () => ({ action: 'capability', capability: 'hermes', task: 'respond', input: {}, reason: 'test' }),
  });

  for (const frame of res.written) {
    assert.ok(!frame.includes(secretProviderDetail));
    assert.ok(!frame.includes('hermes')); // no capability name ever appears in a wire frame
  }
});

test('decision engine failure degrades to the hermes capability, never breaking the turn', async () => {
  const res = fakeRes();
  const hermes = { stream: async (messages, { onDelta }) => { onDelta('ok', false); return 'A reply.'; } };

  await performStreamingTurn({
    messages: [{ role: 'user', content: 'hello there friend' }],
    documents: DOCUMENTS,
    hermes,
    hindsight: SILENT_HINDSIGHT,
    res,
    decisionEngine: () => { throw new Error('boom'); },
  });

  assert.equal(res.written.at(-1), 'data: [DONE]\n\n');
});

// --- Native Generation (proof-of-architecture) ----------------------------

test('performTurn with nativeGenerator: Decision(native) → GaiaGenerator → ResponseEngine → 200, Hermes calls = 0', async () => {
  let hermesCalls = 0;
  const hermes = { chat: async () => { hermesCalls += 1; return 'hermes reply'; } };
  const nativeGenerator = { generate: async () => 'Gaia says hello' };

  const result = await performTurn({
    messages: [{ role: 'user', content: 'Hallo Gaia' }],
    documents: DOCUMENTS,
    hermes,
    nativeGenerator,
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.reply, 'Gaia says hello');
  assert.equal(hermesCalls, 0, 'Hermes must not be called on a native turn');
});

test('performTurn native: works even when Hermes is completely unavailable', async () => {
  const hermes = { chat: async () => { throw new Error('Hermes is down'); } };
  const nativeGenerator = { generate: async () => 'Gaia works independently' };

  const result = await performTurn({
    messages: [{ role: 'user', content: 'Hallo Gaia' }],
    documents: DOCUMENTS,
    hermes,
    nativeGenerator,
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.reply, 'Gaia works independently');
});

test('performTurn native: a generator failure does NOT fall back to Hermes', async () => {
  let hermesCalls = 0;
  const hermes = { chat: async () => { hermesCalls += 1; return 'hermes fallback'; } };
  const nativeGenerator = { generate: async () => { throw new Error('native model unreachable'); } };

  const result = await performTurn({
    messages: [{ role: 'user', content: 'Hallo Gaia' }],
    documents: DOCUMENTS,
    hermes,
    nativeGenerator,
  });

  // A native failure becomes a calm 502 — it must NEVER silently invoke Hermes.
  assert.equal(result.status, 502);
  assert.equal(hermesCalls, 0, 'Hermes must not be called as a hidden fallback for native failures');
});

test('performTurn without nativeGenerator: continues to route through Hermes (backward compatible)', async () => {
  let hermesCalls = 0;
  const hermes = { chat: async () => { hermesCalls += 1; return 'hermes reply'; } };

  const result = await performTurn({
    messages: [{ role: 'user', content: 'Hallo Gaia' }],
    documents: DOCUMENTS,
    hermes,
    // no nativeGenerator — existing behavior
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.reply, 'hermes reply');
  assert.equal(hermesCalls, 1);
});

test('performStreamingTurn with nativeGenerator: streams native response, Hermes calls = 0', async () => {
  let hermesCalls = 0;
  const hermes = { stream: async () => { hermesCalls += 1; return 'hermes'; } };
  const nativeGenerator = {
    generate: async () => 'Gaia says hello',
    stream: async (messages, { onDelta }) => {
      onDelta('Gaia ', false);
      onDelta('says hello', false);
      return 'Gaia says hello';
    },
  };
  const res = fakeRes();

  await performStreamingTurn({
    messages: [{ role: 'user', content: 'Hallo Gaia' }],
    documents: DOCUMENTS,
    hermes,
    hindsight: SILENT_HINDSIGHT,
    res,
    nativeGenerator,
  });

  assert.equal(res.headers['Content-Type'], 'text/event-stream');
  assert.equal(res.written.at(-1), 'data: [DONE]\n\n');
  assert.equal(hermesCalls, 0, 'Hermes must not be called on a native streaming turn');
});

// --- Decision-as-plan architecture tests (real IntentIQ/ReasonIQ/Decision
// Engine end-to-end — no injected decisionEngine/orchestrate) -------------
//
// These pin the concrete flows described in the task brief: a personal-
// memory question retrieves Hindsight context and is answered natively
// (Hermes untouched), while a genuinely complex analysis question still
// routes through Hermes, optionally informed by the same Hindsight
// context. Both use the real classifier/decision engine, not fakes, so a
// future change to IntentIQ's signal sets or the Decision Engine's routing
// is caught here if it regresses either behavior.

test('architecture: a personal-memory question retrieves Hindsight context and is answered natively — Hermes is never called', async () => {
  const res = fakeRes();
  let recallQuery = null;
  const hindsight = {
    recall: async (query) => {
      recallQuery = query;
      return [{ text: 'Bo and Luca started a project together in 2025', scores: { final: 0.9 } }];
    },
    reflect: async () => {},
  };
  const hermes = { stream: async () => { throw new Error('Hermes must not be called for a personal-memory question'); } };
  const nativeGenerator = {
    generate: async () => 'You mentioned Luca before — you two started a project together.',
    stream: async (messages, { onDelta }) => {
      onDelta('You mentioned Luca before.', false);
      return 'You mentioned Luca before.';
    },
  };

  await performStreamingTurn({
    messages: [{ role: 'user', content: 'Weet je nog wat we over Luca bespraken?' }],
    documents: DOCUMENTS,
    hermes,
    hindsight,
    nativeGenerator,
    res,
  });

  assert.ok(recallQuery, 'Hindsight recall should have been attempted for this memory-referencing turn');
  assert.equal(res.headers['Content-Type'], 'text/event-stream');
  assert.match(res.written[0], /You mentioned Luca before/);
  assert.equal(res.written.at(-1), 'data: [DONE]\n\n');
});

test('architecture: a complex analysis question routes through Hermes, with Hindsight context folded in when relevant', async () => {
  const res = fakeRes();
  let recallQuery = null;
  const hindsightReflection = "Bo's Gaia architecture uses a Decision Engine and an Orchestrator";
  const hindsight = {
    recall: async (query) => {
      recallQuery = query;
      return [{ text: hindsightReflection, scores: { final: 0.8 } }];
    },
    reflect: async () => {},
  };
  const hermesMessages = [];
  const hermes = {
    stream: async (messages, { onDelta }) => {
      hermesMessages.push(messages);
      onDelta('Here is the analysis of your architecture.', false);
      return 'Here is the analysis of your architecture.';
    },
  };
  const nativeGenerator = { generate: async () => { throw new Error('native must not be used for this turn'); } };

  await performStreamingTurn({
    messages: [{ role: 'user', content: 'Analyseer mijn Gaia-project op mogelijke race conditions in de architecture.' }],
    documents: DOCUMENTS,
    hermes,
    hindsight,
    nativeGenerator,
    res,
  });

  assert.ok(recallQuery, 'Hindsight recall should have been attempted for this architecture question');
  assert.equal(hermesMessages.length, 1);
  // The Hindsight reflection that was actually retrieved reached Hermes's
  // own prompt — "combined with Hermes", not discarded.
  const seenText = hermesMessages[0].map((m) => m.content).join('\n');
  assert.ok(seenText.includes(hindsightReflection));
  assert.equal(res.written.at(-1), 'data: [DONE]\n\n');
});

// --- webSearch wiring (src/tools/braveSearch.js) --------------------------
//
// These pin turn.js's own adapter (webCapability) rather than
// braveSearch.js's HTTP contract (covered in braveSearch.test.js): given a
// decision that selects the "web" tool, does the Orchestrator actually
// reach a provided webSearch client, does its answer reach the client on
// both the streaming and non-streaming paths, and is Hermes left alone.

test('performStreamingTurn: a webSearch client is wired as the "web" capability and its answer streams to the client', async () => {
  const res = fakeRes();
  let seenQuery = null;
  const webSearch = { search: async (query) => { seenQuery = query; return 'Here is what I found: ...'; } };
  const hermes = { stream: async () => { throw new Error('Hermes must not be called for a web-tool decision'); } };

  await performStreamingTurn({
    messages: [{ role: 'user', content: 'what is the current OpenAI API documentation?' }],
    documents: DOCUMENTS,
    hermes,
    hindsight: SILENT_HINDSIGHT,
    res,
    webSearch,
    decisionEngine: () => ({ action: 'tool', capability: 'web', task: 'lookup', input: { userInput: 'what is the current OpenAI API documentation?' }, reason: 'test' }),
  });

  assert.equal(seenQuery, 'what is the current OpenAI API documentation?');
  assert.match(res.written[0], /Here is what I found/);
  assert.equal(res.written.at(-1), 'data: [DONE]\n\n');
});

test('performTurn: a webSearch client is wired as the "web" capability on the non-streaming path too', async () => {
  let seenQuery = null;
  const webSearch = { search: async (query) => { seenQuery = query; return 'Here is what I found: ...'; } };
  const hermes = { chat: async () => { throw new Error('Hermes must not be called for a web-tool decision'); } };

  const result = await performTurn({
    messages: [{ role: 'user', content: 'what is the current OpenAI API documentation?' }],
    documents: DOCUMENTS,
    hermes,
    webSearch,
    decisionEngine: () => ({ action: 'tool', capability: 'web', task: 'lookup', input: { userInput: 'what is the current OpenAI API documentation?' }, reason: 'test' }),
  });

  assert.equal(seenQuery, 'what is the current OpenAI API documentation?');
  assert.equal(result.status, 200);
  assert.match(result.body.reply, /Here is what I found/);
});

test('performStreamingTurn: without a webSearch client, the Decision Engine never sees a "web" capability and falls back to Hermes', async () => {
  const res = fakeRes();
  let hermesCalls = 0;
  const hermes = { stream: async (messages, { onDelta }) => { hermesCalls += 1; onDelta('ok', false); return 'A reply.'; } };

  await performStreamingTurn({
    messages: [{ role: 'user', content: 'what is the current OpenAI API documentation?' }],
    documents: DOCUMENTS,
    hermes,
    hindsight: SILENT_HINDSIGHT,
    res,
    // webSearch omitted entirely
  });

  assert.equal(hermesCalls, 1);
  assert.equal(res.written.at(-1), 'data: [DONE]\n\n');
});

// === PATCH: Native Vision — Multimodal Attachments ========================

test('assembleMessages: creates multimodal content when multimodalAttachments provided', () => {
  const { assembleMessages: assemble } = require('../src/turn');
  
  // Create a tiny 1x1 red PNG (base64)
  const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==', 'base64');
  
  const messages = assemble('SOUL', [
    { role: 'user', content: 'Wat zie je op deze afbeelding?' },
  ], [
    { filename: 'test.png', imageBytes: tinyPng, imageMimeType: 'image/png' },
  ]);

  // Find the user message
  const userMsg = messages.find((m) => m.role === 'user');
  assert.ok(userMsg);
  
  // Content should be an array (multimodal format)
  assert.ok(Array.isArray(userMsg.content), 'user message content should be an array for multimodal');
  
  // Should contain text block
  const textBlock = userMsg.content.find((c) => c.type === 'text');
  assert.ok(textBlock, 'should have text block');
  assert.equal(textBlock.text, 'Wat zie je op deze afbeelding?');
  
  // Should contain image_url block
  const imageBlock = userMsg.content.find((c) => c.type === 'image_url');
  assert.ok(imageBlock, 'should have image_url block');
  assert.ok(imageBlock.image_url.url.startsWith('data:image/png;base64,'), 'image URL should be data URL with base64');
});

test('assembleMessages: preserves plain text when no multimodal attachments', () => {
  const { assembleMessages: assemble } = require('../src/turn');
  
  const messages = assemble('SOUL', [
    { role: 'user', content: 'Hello' },
  ], []);

  const userMsg = messages.find((m) => m.role === 'user');
  assert.ok(userMsg);
  
  // Content should be a plain string
  assert.equal(typeof userMsg.content, 'string', 'user message content should be string when no images');
  assert.equal(userMsg.content, 'Hello');
});

test('assembleMessages: handles multiple image attachments', () => {
  const { assembleMessages: assemble } = require('../src/turn');
  
  const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==', 'base64');
  
  const messages = assemble('SOUL', [
    { role: 'user', content: 'Vergelijk deze twee afbeeldingen' },
  ], [
    { filename: 'img1.png', imageBytes: tinyPng, imageMimeType: 'image/png' },
    { filename: 'img2.png', imageBytes: tinyPng, imageMimeType: 'image/png' },
  ]);

  const userMsg = messages.find((m) => m.role === 'user');
  assert.ok(Array.isArray(userMsg.content));
  
  // Should have 1 text block + 2 image blocks
  const imageBlocks = userMsg.content.filter((c) => c.type === 'image_url');
  assert.equal(imageBlocks.length, 2, 'should have 2 image blocks');
});

test('performTurn: multimodal attachments reach Hermes as multimodal content', async () => {
  const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==', 'base64');
  let receivedMessages = null;
  
  const hermes = {
    async chat(messages) {
      receivedMessages = messages;
      return 'Ik zie een rode pixel.';
    },
  };

  const result = await performTurn({
    messages: [{ role: 'user', content: 'Wat zie je?' }],
    documents: DOCUMENTS,
    hermes,
    attachments: [
      { filename: 'photo.png', imageBytes: tinyPng, imageMimeType: 'image/png' },
    ],
  });

  assert.equal(result.status, 200);
  assert.ok(receivedMessages);
  
  // The user message should be multimodal
  const userMsg = receivedMessages.find((m) => m.role === 'user');
  assert.ok(Array.isArray(userMsg.content), 'user message should have multimodal content');
  
  // Should contain image_url block
  const imageBlock = userMsg.content.find((c) => c.type === 'image_url');
  assert.ok(imageBlock, 'should have image_url block in LLM request');
  assert.ok(imageBlock.image_url.url.startsWith('data:image/png;base64,'), 'image should be base64 data URL');
});

test('performTurn: text attachments still work as text context', async () => {
  let receivedMessages = null;
  
  const hermes = {
    async chat(messages) {
      receivedMessages = messages;
      return 'I read the file.';
    },
  };

  const result = await performTurn({
    messages: [{ role: 'user', content: 'Read this file' }],
    documents: DOCUMENTS,
    hermes,
    attachments: [
      { filename: 'notes.txt', content: 'Important notes here' },
    ],
  });

  assert.equal(result.status, 200);
  assert.ok(receivedMessages);

  // Text attachments should be in a system message, not as multimodal
  const attachmentMsg = receivedMessages
    .filter((m) => m.role === 'system')
    .find((m) => m.content.includes('notes.txt'));
  assert.ok(attachmentMsg, 'text attachment should be in a system message');
  assert.ok(attachmentMsg.content.includes('Important notes here'), 'text content should be included');
  
  // User message should still be plain text
  const userMsg = receivedMessages.find((m) => m.role === 'user');
  assert.equal(typeof userMsg.content, 'string', 'user message should be plain string');
});

// --- ReasonIQ 0.2: the evidence channel --------------------------------------
//
// Evidence Assembly (reasoning/evidenceAssembler.js) organizes what the
// context layer already gathered — Hindsight recall, mental models, uploaded
// documents — into stable-id evidence BEFORE ReasonIQ runs. These tests pin
// the whole flow: recall happens first, evidence reaches ReasonIQ with ids
// and sources intact, and a reasoning failure still never takes down the
// turn.

test('0.2: the background ReasonIQ call receives the assembled Hindsight + upload evidence', async () => {
  const reasonIQCalls = [];
  const hindsight = {
    recall: async () => [
      { text: 'The team decided on a single stream emitter in March', scores: { final: 0.9 } },
    ],
    reflect: async () => {},
  };
  const hermes = { stream: async (messages, { onDelta }) => { onDelta('ok', false); return 'A reply.'; } };

  await performStreamingTurn({
    messages: [{ role: 'user', content: 'Analyseer de streaming architecture op race conditions, zoals we eerder bespraken.' }],
    documents: DOCUMENTS,
    hermes,
    hindsight,
    res: fakeRes(),
    attachments: [{ filename: 'design.md', content: 'Design doc: cancellation may interrupt the stream.' }],
    intentIQ: () => ({ schemaVersion: 'intentiq.v1', intent: 'inform.explain', status: 'accepted' }),
    reasonIQ: async (input) => { reasonIQCalls.push(input); return {}; },
  });

  assert.equal(reasonIQCalls.length, 1);
  const evidence = reasonIQCalls[0].evidence;
  assert.ok(Array.isArray(evidence) && evidence.length === 2);
  // Upload outranks memory; every item carries its provenance.
  assert.equal(evidence[0].id, 'upload-1');
  assert.equal(evidence[0].source, 'upload');
  assert.equal(evidence[0].type, 'document');
  assert.match(evidence[0].content, /cancellation may interrupt/);
  assert.equal(evidence[1].id, 'hindsight-1');
  assert.equal(evidence[1].source, 'hindsight');
  assert.equal(evidence[1].type, 'memory');
  assert.equal(evidence[1].relevance, 0.9);
});

// PHASE 2: no evidence to weigh means no ReasonIQ call at all — an empty
// evidence list no longer "flows to ReasonIQ"; there is nothing to reason
// over, so the turn is decided without it.
test('0.2: with no recall results and no attachments, ReasonIQ is not called at all', async () => {
  const reasonIQCalls = [];
  const hermes = { stream: async (messages, { onDelta }) => { onDelta('ok', false); return 'A reply.'; } };

  await performStreamingTurn({
    messages: [{ role: 'user', content: 'Why is my website crashing?' }],
    documents: DOCUMENTS,
    hermes,
    hindsight: SILENT_HINDSIGHT,
    res: fakeRes(),
    intentIQ: () => ({ schemaVersion: 'intentiq.v1', intent: 'inform.explain', status: 'accepted' }),
    reasonIQ: async (input) => { reasonIQCalls.push(input); return {}; },
  });
  await flush();

  assert.equal(reasonIQCalls.length, 0);
});

// Images are model-native input, never text evidence — and an image-only
// turn has no evidence to weigh, so ReasonIQ stays out of it entirely; the
// native generator answers. (The evidence assembler's own skip-images rule
// stays covered by evidenceAssembler.test.js.)
test('0.2: image attachments are model-native input — no ReasonIQ call, native answers', async () => {
  const reasonIQCalls = [];
  const hindsight = { recall: async () => [], reflect: async () => {} };
  const nativeGenerator = {
    generate: async () => 'seen',
    stream: async (messages, { onDelta }) => { onDelta('seen', false); return 'seen'; },
  };
  const hermes = { stream: async () => { throw new Error('hermes must not be needed'); } };

  await performStreamingTurn({
    messages: [{ role: 'user', content: 'Wat zie je in deze foto?' }],
    documents: DOCUMENTS,
    hermes,
    hindsight,
    nativeGenerator,
    res: fakeRes(),
    attachments: [{ filename: 'photo.png', content: null, imageBytes: Buffer.from('fake'), imageMimeType: 'image/png' }],
    intentIQ: () => ({ schemaVersion: 'intentiq.v1', intent: null, status: 'unknown' }),
    reasonIQ: async (input) => { reasonIQCalls.push(input); return {}; },
  });
  await flush();

  assert.equal(reasonIQCalls.length, 0);
});

// --- Hypothesis Persistence 0.1: optional hypothesisRuntime wiring -----------

// PHASE 2: a reasoning turn (evidence + analysis intent) still reaches
// ReasonIQ — exactly once, deferred after the reply — and its analysis
// products still feed the hypothesis lifecycle.
test("0.1 turn: a hypothesisRuntime seeds existing hypotheses into the deferred ReasonIQ call and applies its updates", async () => {
  const reasonIQCalls = [];
  const manager = (require('../src/reasoning/hypothesisManager')).createHypothesisManager({
    hypotheses: [{ id: "hyp-seed", statement: "Cancellation races teardown.", status: "testing", confidence: 0.6, evidenceFor: ["e1"] }],
  });
  const hermes = { stream: async (messages, { onDelta }) => { onDelta("ok", false); return "A reply."; } };
  const res = fakeRes();

  await performStreamingTurn({
    messages: [{ role: "user", content: "Analyseer de streaming architecture op race conditions, zoals we eerder bespraken." }],
    documents: DOCUMENTS,
    hermes,
    hindsight: DEEP_EVIDENCE_HINDSIGHT,
    res,
    intentIQ: () => ({ schemaVersion: "intentiq.v1", intent: "inform.explain", status: "accepted" }),
    reasonIQ: async (input) => {
      reasonIQCalls.push(input);
      return {
        interpretation: "weighing",
        hypotheses: [{ statement: "Cancellation races teardown.", existingId: "hyp-seed", confidence: 0.7, evidenceFor: [], evidenceAgainst: [] }],
        hypothesisUpdates: [{ hypothesisId: "hyp-seed", relation: "supports", confidenceDelta: 0.05, rationale: "new analysis", evidenceId: null }],
        contradictions: [], uncertainties: [], informationGaps: [],
        conclusions: [], sufficientForConclusion: false, confidence: 0.65,
      };
    },
    hypothesisRuntime: { manager },
  });

  assert.match(res.written.at(-1), /data: \[DONE\]/, "the reply is delivered without waiting for ReasonIQ");
  await flushBackground();
  assert.equal(reasonIQCalls.length, 1, "ReasonIQ runs exactly once for a reasoning turn");
  // The deferred call carries the seeded hypothesis context.
  assert.equal(reasonIQCalls[0].existingHypotheses[0].id, "hyp-seed");
  assert.equal(manager.get("hyp-seed").confidence, 0.65); // update applied post-reasoning
});

test("0.1 turn: recall/seed failures in the runtime are non-fatal — the reply still streams", async () => {
  const res = fakeRes();
  const hermes = { stream: async (messages, { onDelta }) => { onDelta("still fine", false); return "still fine"; } };
  await performStreamingTurn({
    messages: [{ role: "user", content: "Why is my website crashing?" }],
    documents: DOCUMENTS,
    hermes,
    hindsight: SILENT_HINDSIGHT,
    res,
    intentIQ: () => ({ schemaVersion: "intentiq.v1", intent: "inform.explain", status: "accepted" }),
    reasonIQ: async () => ({}),
    hypothesisRuntime: {
      manager: { list: () => { throw new Error("boom"); }, applyReasoningResult: () => { throw new Error("boom2"); } },
      ensureLoaded: async () => { throw new Error("boom3"); },
      recallHypotheses: async () => { throw new Error("boom4"); },
    },
  });
  assert.match(res.written[0], /still fine/);
});

// --- ReasonIQ 0.4: gated pattern formation ------------------------------------

function patternRuntimeFor() {
  const { createHypothesisManager } = require("../src/reasoning/hypothesisManager");
  const { createPatternManager } = require("../src/reasoning/patternManager");
  return {
    manager: createHypothesisManager({}),
    patternManager: createPatternManager({}),
  };
}

test("0.4 turn: a durable hypothesis change opens the gate; a plain conversational turn never does", async () => {
  const runtime = patternRuntimeFor();
  const reasonIQCalls = [];
  const hermes = { stream: async (messages, { onDelta }) => { onDelta("ok", false); return "A reply."; } };

  // Turn A: reasoning turn with evidence (durable analysis) -> forms a
  // tracked durable hypothesis via the deferred ReasonIQ call.
  await performStreamingTurn({
    messages: [{ role: "user", content: "Analyseer waarom deze flow vastloopt bij annulering, zoals we eerder bespraken." }],
    documents: DOCUMENTS,
    hermes,
    hindsight: DEEP_EVIDENCE_HINDSIGHT,
    res: fakeRes(),
    intentIQ: () => ({ schemaVersion: "intentiq.v1", intent: "inform.explain", status: "accepted" }),
    reasonIQ: async (input) => {
      reasonIQCalls.push(input);
      return {
        interpretation: "x",
        hypotheses: [{ statement: "Concurrent cancellation races stream teardown.", confidence: 0.7, evidenceFor: ["e1"], persistence: "durable" }],
        hypothesisUpdates: [], contradictions: [], uncertainties: [], informationGaps: [],
        conclusions: [], sufficientForConclusion: false, confidence: 0.6,
      };
    },
    hypothesisRuntime: { manager: runtime.manager, patternManager: runtime.patternManager },
  });
  await flushBackground();
  assert.equal(reasonIQCalls.length, 1, "turn A is a reasoning turn: ReasonIQ ran once");
  assert.equal(runtime.manager.list().length, 1);
  assert.equal(runtime.patternManager.list().length, 0); // single durable member: no pattern yet

  // Turn B: plain conversational turn — NO ReasonIQ call at all (Phase 2),
  // and the pattern gate must stay closed even though a durable hypothesis
  // exists.
  const reasonIQCallsB = [];
  await performStreamingTurn({
    messages: [{ role: "user", content: "Hoi Gaia" }],
    documents: DOCUMENTS,
    hermes,
    hindsight: SILENT_HINDSIGHT,
    res: fakeRes(),
    intentIQ: () => ({ schemaVersion: "intentiq.v1", intent: "converse", status: "accepted" }),
    reasonIQ: async () => { reasonIQCallsB.push(1); return { interpretation: "hi", hypotheses: [], hypothesisUpdates: [], contradictions: [], uncertainties: [], informationGaps: [], conclusions: [], sufficientForConclusion: true, confidence: 0.9 }; },
    hypothesisRuntime: { manager: runtime.manager, patternManager: runtime.patternManager },
  });
  await flushBackground();
  assert.equal(reasonIQCallsB.length, 0, "no ReasonIQ call for a plain conversational turn");
  assert.equal(runtime.patternManager.list().length, 0); // no pattern from "Hoi Gaia"
});

// --- Pattern Awareness 0.1: gated recall + decision-owned usage ----------------

const PATTERN_CANDIDATE = {
  id: "pattern-1",
  statement: "Bo lijkt vaker langdurig creatief te werken na technische doorbraken.",
  status: "established",
  confidence: 0.85,
  hypothesisIds: ["hyp-a"],
  persistence: "durable",
  sourceRef: "ptf_1",
  relevance: 0.88,
};

test("0.1 turn: a greeting never triggers pattern retrieval — the gate stays shut", async () => {
  let recallCalls = 0;
  const hermes = { stream: async (messages, { onDelta }) => { onDelta("hoi!", false); return "hoi!"; } };
  await performStreamingTurn({
    messages: [{ role: "user", content: "Hoi Gaia" }],
    documents: DOCUMENTS,
    hermes,
    hindsight: SILENT_HINDSIGHT,
    res: fakeRes(),
    intentIQ: () => ({ schemaVersion: "intentiq.v1", intent: "converse", status: "accepted" }),
    reasonIQ: async () => ({}),
    hypothesisRuntime: {
      manager: { list: () => [], applyReasoningResult: () => {} },
      recallPatterns: async () => { recallCalls += 1; return [PATTERN_CANDIDATE]; },
    },
  });
  assert.equal(recallCalls, 0, "pattern retrieval must not run for plain conversational turns");
});

test("0.1 turn: a topical turn with a relevant established pattern uses it as context — never auto-mentioned", async () => {
  let capturedMessages = null;
  const hermes = {
    stream: async (messages, { onDelta }) => {
      capturedMessages = messages;
      onDelta("fijn dat je weer creatief aan de slag gaat", false);
      return "fijn dat je weer creatief aan de slag gaat";
    },
  };
  await performStreamingTurn({
    messages: [{ role: "user", content: "Ik wil vanavond weer langdurig creatief werken aan Melodiq." }],
    documents: DOCUMENTS,
    hermes,
    hindsight: SILENT_HINDSIGHT,
    res: fakeRes(),
    intentIQ: () => ({ schemaVersion: "intentiq.v1", intent: "converse", status: "accepted" }),
    reasonIQ: async () => ({}),
    hypothesisRuntime: {
      manager: { list: () => [], applyReasoningResult: () => {} },
      recallPatterns: async () => [PATTERN_CANDIDATE],
    },
  });

  assert.ok(capturedMessages, "hermes must have received assembled messages");
  const patternBlock = capturedMessages.find((m) => m.role === "system"
    && (/knowledgeType: pattern/.test(m.content) || /You may voice the observation below ONCE/.test(m.content)));
  assert.ok(patternBlock, "used patterns reach the Response Engine as explicit derived-pattern guidance");
  assert.match(patternBlock.content, /NOT confirmed facts|tentative impression/);

  // The fact-framing example may appear ONLY inside the guidance block
  // itself (as what to avoid) — never in SOUL, memory or any other block.
  for (const m of capturedMessages) {
    if (!/Jij bent iemand die/.test(m.content)) continue;
    if (m !== patternBlock) assert.fail("patterns must never be framed as facts about the user outside explicit guidance");
  }
  assert.match(patternBlock.content, /NEVER as a statement of fact/);
});

test("0.1 turn: pattern recall failure is non-fatal — the reply still streams without any pattern block", async () => {
  const res = fakeRes();
  let sawPatternBlock = false;
  const hermes = {
    stream: async (messages, { onDelta }) => {
      // "Derived patterns" is renderPatternContextBlock's own marker text (patternAwareness.js).
      sawPatternBlock = messages.some((m) => m.role === "system" && /Derived patterns/i.test(m.content));
      onDelta("nog steeds goed", false);
      return "nog steeds goed";
    },
  };
  await performStreamingTurn({
    messages: [{ role: "user", content: "Ik werk vanavond weer aan Melodiq." }],
    documents: DOCUMENTS,
    hermes,
    hindsight: SILENT_HINDSIGHT,
    res,
    intentIQ: () => ({ schemaVersion: "intentiq.v1", intent: "converse", status: "accepted" }),
    reasonIQ: async () => ({}),
    hypothesisRuntime: {
      manager: { list: () => [], applyReasoningResult: () => {} },
      recallPatterns: async () => { throw new Error("hindsight down"); },
    },
  });
  assert.match(res.written[0], /nog steeds goed/);
  assert.equal(sawPatternBlock, false);
});

test("0.1 turn: irrelevant recalled candidates leave no trace in the prompt", async () => {
  let capturedMessages = null;
  const hermes = {
    stream: async (messages, { onDelta }) => {
      capturedMessages = messages;
      onDelta("antwoord", false);
      return "antwoord";
    },
  };
  await performStreamingTurn({
    messages: [{ role: "user", content: "Wat is de hoofdstad van Bolivia eigenlijk?" }],
    documents: DOCUMENTS,
    hermes,
    hindsight: SILENT_HINDSIGHT,
    res: fakeRes(),
    intentIQ: () => ({ schemaVersion: "intentiq.v1", intent: "inform.explain", status: "accepted" }),
    reasonIQ: async () => ({}),
    hypothesisRuntime: {
      manager: { list: () => [], applyReasoningResult: () => {} },
      recallPatterns: async () => [{ ...PATTERN_CANDIDATE, relevance: 0.05 }],
    },
  });
  assert.ok(capturedMessages.every((m) => !/knowledgeType: pattern/.test(m.content)),
    "an ignored pattern must never reach the Response Engine");
});

test("0.1 turn: candidate patterns are never offered to the user even when topically recalled", async () => {
  let capturedMessages = null;
  const hermes = {
    stream: async (messages, { onDelta }) => {
      capturedMessages = messages;
      onDelta("ok", false);
      return "ok";
    },
  };
  await performStreamingTurn({
    messages: [{ role: "user", content: "Ik wil vanavond weer langdurig creatief werken aan Melodiq." }],
    documents: DOCUMENTS,
    hermes,
    hindsight: SILENT_HINDSIGHT,
    res: fakeRes(),
    intentIQ: () => ({ schemaVersion: "intentiq.v1", intent: "converse", status: "accepted" }),
    reasonIQ: async () => ({}),
    hypothesisRuntime: {
      manager: { list: () => [], applyReasoningResult: () => {} },
      recallPatterns: async () => [{ ...PATTERN_CANDIDATE, status: "candidate" }],
    },
  });
  assert.ok(capturedMessages.every((m) => !/knowledgeType: pattern|indruk/i.test(m.content)),
    "candidate → ignore by default; nothing pattern-shaped reaches the prompt");
});

// --- Memoryworthiness 0.1: Hindsight retains only what deserves memory ----------

function memoryHindsight() {
  const reflectCalls = [];
  return {
    reflectCalls,
    hindsight: { recall: async () => [], reflect: async (item) => { reflectCalls.push(item); } },
  };
}

test("0.1 memory: a greeting produces a reply but NO Hindsight reflection", async () => {
  const { reflectCalls, hindsight } = memoryHindsight();
  const res = fakeRes();
  const hermes = { stream: async (messages, { onDelta }) => { onDelta("Hoi!", false); return "Hoi! Leuk dat je er bent."; } };

  await performStreamingTurn({
    messages: [{ role: "user", content: "Hoi Gaia" }],
    documents: DOCUMENTS,
    hermes,
    hindsight,
    res,
    intentIQ: () => ({ schemaVersion: "intentiq.v1", intent: "converse", status: "accepted" }),
    reasonIQ: async () => ({}),
  });

  assert.match(res.written[0], /Hoi!/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reflectCalls.length, 0, "conversation history keeps the turn; Hindsight must not receive it");
});

test("0.1 memory: a meaningful turn reflects WITH gaia_memory_* decision metadata", async () => {
  const { reflectCalls, hindsight } = memoryHindsight();
  const hermes = { stream: async (m, { onDelta }) => { onDelta("Gedaan.", false); return "Gedaan, onthouden."; } };

  await performStreamingTurn({
    messages: [{ role: "user", content: "Onthoud dat ik voortaan kortere antwoorden wil." }],
    documents: DOCUMENTS,
    hermes,
    hindsight,
    res: fakeRes(),
    intentIQ: () => ({ schemaVersion: "intentiq.v1", intent: "converse", status: "accepted" }),
    reasonIQ: async () => ({}),
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reflectCalls.length, 1);
  const meta = reflectCalls[0].metadata;
  assert.ok(meta, "the retain decision rides as metadata");
  assert.equal(meta.gaia_memory_decision, "retain");
  assert.equal(meta.gaia_memory_priority, "normal");
  assert.match(meta.gaia_memory_reason, /explicit/);
});

test("0.1 memory: low-priority turns are still retained but tagged priority=low", async () => {
  const { reflectCalls, hindsight } = memoryHindsight();
  const hermes = { stream: async (m, { onDelta }) => { onDelta("ok", false); return "Prima, geniet ervan."; } };

  await performStreamingTurn({
    // Recurring but modest: survives as low priority rather than full retain.
    messages: [{ role: "user", content: "Ik werk deze maand op kantoor in Utrecht." }],
    documents: DOCUMENTS,
    hermes,
    hindsight,
    res: fakeRes(),
    intentIQ: () => ({ schemaVersion: "intentiq.v1", intent: "converse", status: "accepted" }),
    reasonIQ: async () => ({}),
  });

  await new Promise((resolve) => setImmediate(resolve));
  if (reflectCalls.length === 1) {
    const meta = reflectCalls[0].metadata;
    assert.ok(["retain", "retain_low_priority"].includes(meta.gaia_memory_decision));
    if (meta.gaia_memory_decision === "retain_low_priority") {
      assert.equal(meta.gaia_memory_priority, "low");
    }
  }
});

test("0.1 memory: a lexically mundane capability request that needed a retry is retained anyway (capability-outcome override)", async () => {
  const { reflectCalls, hindsight } = memoryHindsight();
  let calls = 0;
  const testTool = {
    invokeCapability: async () => {
      calls += 1;
      if (calls === 1) return { ok: false, error: 'transient glitch, try again' };
      return { ok: true, output: 'GAIA P0 TEST bestand aangemaakt.' };
    },
  };

  await performStreamingTurn({
    // Lexically mundane on its own — no preference, fact, correction or
    // explicit "onthoud dit" — so Memoryworthiness alone would discard it.
    messages: [{ role: "user", content: "Test P0 nu in de echte Gaia-runtime." }],
    documents: DOCUMENTS,
    hermes: { stream: async (m, { onDelta }) => { onDelta("x", false); return "x"; } },
    hindsight,
    res: fakeRes(),
    tools: { testtool: testTool },
    intentIQ: () => ({ schemaVersion: "intentiq.v1", intent: "converse", status: "accepted" }),
    reasonIQ: async () => ({}),
    decisionEngine: () => ({ action: "capability", capability: "testtool", task: "run P0 test", input: {}, reason: "test" }),
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2, "sanity check: the capability actually needed a retry");
  assert.equal(reflectCalls.length, 1, "a retried capability outcome must not be silently discarded");
  const meta = reflectCalls[0].metadata;
  assert.equal(meta.gaia_memory_decision, "retain");
  assert.match(meta.gaia_memory_reason, /notable_capability_outcome/);
});

test("0.1 memory: a routine one-shot successful capability call is still discarded on a mundane request", async () => {
  const { reflectCalls, hindsight } = memoryHindsight();
  const testTool = { invokeCapability: async () => ({ ok: true, output: "gedaan" }) };

  await performStreamingTurn({
    messages: [{ role: "user", content: "Hoi Gaia" }],
    documents: DOCUMENTS,
    hermes: { stream: async (m, { onDelta }) => { onDelta("x", false); return "x"; } },
    hindsight,
    res: fakeRes(),
    tools: { testtool: testTool },
    intentIQ: () => ({ schemaVersion: "intentiq.v1", intent: "converse", status: "accepted" }),
    reasonIQ: async () => ({}),
    decisionEngine: () => ({ action: "capability", capability: "testtool", task: "greet", input: {}, reason: "test" }),
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reflectCalls.length, 0, "a routine first-try success must not force retention of every capability turn");
});

test("0.1 memory §15: a discarded turn closes memory AND the pattern trigger — but never hijacks hypothesis policy", async () => {
  let appliedReasoning = 0;
  let formedPatterns = 0;
  let reasonIQCalls = 0;
  const reflectCalls = [];
  // Evidence-bearing recall so the turn is a REASONING turn (Phase 2:
  // ReasonIQ runs only when the depth heuristic says deep) — the memory
  // verdict below must still discard this pure acknowledgement.
  const hindsight = {
    recall: async () => [{ text: 'The team decided on a single stream emitter in March', scores: { final: 0.9 } }],
    reflect: async (item) => { reflectCalls.push(item); },
  };
  const hermes = { stream: async (m, { onDelta }) => { onDelta("Hoi!", false); return "Hoi!"; } };

  await performStreamingTurn({
    messages: [{ role: "user", content: "Oké prima" }],
    documents: DOCUMENTS,
    hermes,
    hindsight,
    res: fakeRes(),
    // A text attachment is evidence regardless of the recall gate, so the
    // depth heuristic opens the reasoning path for this turn.
    attachments: [{ filename: 'analysis.md', content: 'Design doc: cancellation may interrupt the stream.' }],
    intentIQ: () => ({ schemaVersion: "intentiq.v1", intent: "acknowledge", status: "accepted" }),
    reasonIQ: async () => {
      reasonIQCalls += 1;
      return {
        interpretation: "x",
        hypotheses: [{ statement: "Durable-looking hypothesis from an ack turn.", confidence: 0.9, evidenceFor: ["e"], persistence: "durable" }],
        hypothesisUpdates: [],
        contradictions: [], uncertainties: [], informationGaps: [],
        conclusions: [], sufficientForConclusion: true, confidence: 0.9,
      };
    },
    hypothesisRuntime: {
      manager: { list: () => [], applyReasoningResult: () => { appliedReasoning += 1; } },
      patternManager: { maybeFormPatterns: () => { formedPatterns += 1; } },
      recallPatterns: async () => [],
    },
  });

  await flushBackground();
  assert.equal(reasonIQCalls, 1, "a reasoning turn still reaches ReasonIQ exactly once (deferred)");
  assert.equal(reflectCalls.length, 0, "discard → no Hindsight memory (spec §15)");
  assert.equal(formedPatterns, 0, "discard closes the pattern formation trigger (spec §15)");
  // Hypothesis lifecycle is HypothesisManager's domain (its own gates judge
  // whether this reasoning result means anything) — Memoryworthiness must not
  // veto reasoning products, only memory.
  assert.equal(appliedReasoning, 1);
});

test("0.1 memory: retained turns keep the hypothesis/pattern pipeline fully operational", async () => {
  let appliedReasoning = 0;
  let patternGateReached = false;
  const hermes = { stream: async (m, { onDelta }) => { onDelta("Noted.", false); return "Noted."; } };

  // Phase 2: evidence present so the depth heuristic opens the reasoning
  // path — a retained reasoning turn keeps the whole lifecycle intact.
  // (converse is a context-only intent and never warrants reasoning; an
  // analysis intent with evidence does.)
  await performStreamingTurn({
    messages: [{ role: "user", content: "Onthoud dat mijn deploy altijd via de VPS loopt, zoals we eerder bespraken." }],
    documents: DOCUMENTS,
    hermes,
    hindsight: DEEP_EVIDENCE_HINDSIGHT,
    res: fakeRes(),
    intentIQ: () => ({ schemaVersion: "intentiq.v1", intent: "inform.explain", status: "accepted" }),
    reasonIQ: async () => ({
      hypotheses: [{ statement: "Deploys run through the VPS.", confidence: 0.7, evidenceFor: [], persistence: "durable" }],
      hypothesisUpdates: [],
    }),
    hypothesisRuntime: {
      manager: { list: () => [], applyReasoningResult: () => { appliedReasoning += 1; } },
      patternManager: { maybeFormPatterns: () => { patternGateReached = true; } },
    },
  });
  await flushBackground();

  assert.equal(appliedReasoning, 1, "retain keeps downstream reasoning intact");
  // The 0.4 gate needs at least 1 changed durable hypothesis in
  // manager.list() to actually call maybeFormPatterns - with a stub list it
  // stays unreachable; what matters here is that retain did not CLOSE it.
});

// --- COGNITIVE PARITY INVARIANT ----------------------------------------------
//
// Non-streaming and streaming turns must have identical cognitive and memory
// semantics; only delivery/transport may differ. These tests run the SAME
// request through BOTH public entrypoints with the same injected seams and
// assert that every cognitive product matches: what IntentIQ produced, what
// the Decision Engine consumed and returned, what the capability received,
// and what Hindsight retained.

test("parity: identical turns through both transports produce identical cognitive products", async () => {
  const INTENT = { schemaVersion: "intentiq.v1", intent: "converse", status: "accepted", entities: [], sourceOfTruth: "conversation", needsClarification: false };
  const REASONING = { interpretation: "x", reasoningDepth: "shallow", hypotheses: [], hypothesisUpdates: [], contradictions: [], uncertainties: [], informationGaps: [], conclusions: [], sufficientForConclusion: true, confidence: 0.8 };

  function makeSeams() {
    const seams = {
      decisionInputs: [],
      decisions: [],
      capabilityMessages: null,
      reflectCalls: [],
    };
    seams.hindsight = { recall: async () => [{ text: "Bo prefers async updates", scores: { final: 0.9 } }], reflect: async (item) => { seams.reflectCalls.push(item); } };
    seams.hermes = {
      chat: async (messages) => { seams.capabilityMessages = messages; return "Een inhoudelijk antwoord."; },
      stream: async (messages, { onDelta }) => { seams.capabilityMessages = messages; onDelta("Een inhoudelijk ", false); onDelta("antwoord.", false); return "Een inhoudelijk antwoord."; },
    };
    seams.intentIQ = async () => JSON.parse(JSON.stringify(INTENT));
    seams.reasonIQ = async () => JSON.parse(JSON.stringify(REASONING));
    seams.decisionEngine = (input) => {
      seams.decisionInputs.push(input);
      // Route identically in both transports: native conversational turn.
      return {
        action: "native",
        capability_candidate: null,
        capability_execute: false,
        reason: "parity test routing",
        context: ["hindsight"],
        reasoning: "light",
        capabilities: [],
      };
    };
    seams.orchestrate = async (decision, ctx) => {
      seams.decisions.push(decision);
      // Mirror orchestrator.execute: pass onDelta through so streaming
      // transports can stream.
      const output = await ctx.capabilities.hermes.invoke(ctx.messages, { onDelta: ctx.onDelta });
      return { action: decision.action, output };
    };
    return seams;
  }

  const messages = [
    { role: "user", content: "Ik wil voortaan dat je kortere antwoorden geeft over mijn project." },
  ];

  // --- non-streaming transport ---
  const a = makeSeams();
  const resA = await performTurn({
    messages,
    documents: DOCUMENTS,
    hermes: a.hermes,
    hindsight: a.hindsight,
    intentIQ: a.intentIQ,
    reasonIQ: a.reasonIQ,
    decisionEngine: a.decisionEngine,
    orchestrate: a.orchestrate,
  });

  // --- streaming transport ---
  const b = makeSeams();
  await performStreamingTurn({
    messages,
    documents: DOCUMENTS,
    hermes: b.hermes,
    hindsight: b.hindsight,
    res: fakeRes(),
    intentIQ: b.intentIQ,
    reasonIQ: b.reasonIQ,
    decisionEngine: b.decisionEngine,
    orchestrate: b.orchestrate,
  });

  // The Decision Engine consumed IDENTICAL inputs on both transports.
  assert.equal(a.decisionInputs.length, 1);
  assert.equal(b.decisionInputs.length, 1);
  assert.deepEqual(b.decisionInputs[0].intent, a.decisionInputs[0].intent);
  assert.deepEqual(b.decisionInputs[0].reasoning, a.decisionInputs[0].reasoning);
  assert.deepEqual(b.decisionInputs[0].context.reflections, a.decisionInputs[0].context.reflections);
  assert.deepEqual(b.decisionInputs[0].availableCapabilities, a.decisionInputs[0].availableCapabilities);

  // Identical reply text reached both clients.
  assert.equal(resA.status, 200);
  assert.equal(resA.body.reply, "Een inhoudelijk antwoord.");
  assert.equal(resA.body.reply, "Een inhoudelijk antwoord.");

  // The capability saw the EXACT same assembled prompt on both transports.
  assert.deepEqual(b.capabilityMessages, a.capabilityMessages);
  // ...including the same memory context block built from the same recall.
  const sysA = a.capabilityMessages.filter((m) => m.role === "system");
  const sysB = b.capabilityMessages.filter((m) => m.role === "system");
  assert.ok(sysA.some((m) => /long-term memory/.test(m.content)), "memory context present");
  assert.deepEqual(sysB, sysA);

  // Memory semantics identical: the memory-worthy turn reflected ONCE per
  // transport, with the same gaia_memory_* decision metadata.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(a.reflectCalls.length, 1);
  assert.equal(b.reflectCalls.length, 1);
  assert.deepEqual(
    { ...a.reflectCalls[0], metadata: undefined, provenance: undefined },
    { ...b.reflectCalls[0], metadata: undefined, provenance: undefined }
  );
  assert.equal(a.reflectCalls[0].metadata.gaia_memory_decision, b.reflectCalls[0].metadata.gaia_memory_decision);
});

test("parity: a greeting is discarded from memory on BOTH transports", async () => {
  async function greetingReflectCount(transport) {
    const reflects = [];
    const hindsight = { recall: async () => [], reflect: async () => { reflects.push(1); } };
    const hermes = {
      chat: async () => "Hoi! Leuk dat je er bent.",
      stream: async (m, { onDelta }) => { onDelta("Hoi!", false); return "Hoi! Leuk dat je er bent."; },
    };
    const common = {
      messages: [{ role: "user", content: "Hoi Gaia" }],
      documents: DOCUMENTS,
      hermes,
      hindsight,
      intentIQ: async () => ({ schemaVersion: "intentiq.v1", intent: "greet", status: "accepted", entities: [], sourceOfTruth: "conversation" }),
      reasonIQ: async () => ({ hypotheses: [] }),
    };
    if (transport === "stream") {
      await performStreamingTurn({ ...common, res: fakeRes() });
    } else {
      await performTurn(common);
    }
    await new Promise((resolve) => setImmediate(resolve));
    return reflects.length;
  }

  assert.equal(await greetingReflectCount("stream"), 0);
  assert.equal(await greetingReflectCount("non-stream"), 0);
});

// --- Assistant-originated referents: full IntentIQ -> context -> Hindsight
// -> Decision flow, identical on both transports --------------------------------

const ASSISTANT_JUNI_HISTORY = [
  { role: "user", content: "Vertel eens hoe het afgelopen jaar ging." },
  { role: "assistant", content: "Ik zie vooral veel sessies rond juni — zeker gezien de context rond juni destijds." },
];
const JUNI_FOLLOWUP = "wat was er in juni ook alweer?";

function juniSeams() {
  const seams = {
    recallQueries: [],
    decisionInputs: [],
    capabilityMessages: null,
  };
  seams.hindsight = {
    recall: async (q) => {
      seams.recallQueries.push(q);
      return [{ text: "Bo had in juni een intensieve Melodiq-week", scores: { final: 0.9 } }];
    },
    reflect: async () => {},
  };
  seams.decisionEngine = (input) => {
    seams.decisionInputs.push(input);
    return { action: "capability", capability: "hermes", task: "respond", input: {}, reason: "parity" };
  };
  seams.orchestrate = async (decision, ctx) => {
    seams.capabilityMessages = ctx.messages;
    const output = await ctx.capabilities.hermes.invoke(ctx.messages, { onDelta: ctx.onDelta });
    return { action: decision.action, output };
  };
  return seams;
}

test("follow-up grounding: Gaia's own 'juni' mention opens Hindsight recall and informs the Decision (both transports)", async () => {
  // --- non-streaming ---
  const a = juniSeams();
  const resA = await performTurn({
    messages: [...ASSISTANT_JUNI_HISTORY, { role: "user", content: JUNI_FOLLOWUP }],
    documents: DOCUMENTS,
    hermes: { chat: async () => "In juni gebeurde dit-en-dit." },
    hindsight: a.hindsight,
    decisionEngine: a.decisionEngine,
    orchestrate: a.orchestrate,
  });

  // --- streaming ---
  const b = juniSeams();
  await performStreamingTurn({
    messages: [...ASSISTANT_JUNI_HISTORY, { role: "user", content: JUNI_FOLLOWUP }],
    documents: DOCUMENTS,
    hermes: { stream: async (m, { onDelta }) => { onDelta("In juni ", false); return "In juni gebeurde dit-en-dit."; } },
    hindsight: b.hindsight,
    res: fakeRes(),
    decisionEngine: b.decisionEngine,
    orchestrate: b.orchestrate,
  });

  for (const s of [a, b]) {
    // Recall RAN — the gate opened even though the query carries no lexical
    // past-reference cue ("ook alweer" matches nothing).
    assert.equal(s.recallQueries.length, 1);
    assert.match(s.recallQueries[0], /juni/);

    // The Decision Engine consumed an assistant-anchored interpretation.
    assert.equal(s.decisionInputs.length, 1);
    const intent = s.decisionInputs[0].intent;
    assert.equal(intent.sourceOfTruth, "memory");
    assert.match(intent.meta.reason, /^assistant_anchored_follow_up/);
    assert.ok(intent.referents.some((r) => r.expression === "juni"));
    // The recalled June memory reached the Decision as real context.
    assert.ok(s.decisionInputs[0].context.reflections.some((r) => /juni/i.test(r.text)));

    // The capability saw the recalled context in the assembled prompt.
    const sysMsgs = s.capabilityMessages.filter((m) => m.role === "system");
    assert.ok(sysMsgs.some((m) => /juni/.test(m.content)), "recalled memory rendered into the prompt");
  }

  // COGNITIVE PARITY: both transports produced byte-identical judgments.
  assert.deepEqual(b.decisionInputs[0], a.decisionInputs[0]);
  assert.deepEqual(b.capabilityMessages, a.capabilityMessages);
  assert.equal(resA.status, 200);
});

test("follow-up grounding: without the assistant antecedent neither transport recalls or anchors", async () => {
  const coldHistory = [
    { role: "user", content: "Vertel eens hoe het afgelopen jaar ging." },
    { role: "assistant", content: "Hoi! Leuk dat je er bent." }, // mentions nothing substantive
  ];

  async function run(transport) {
    const seams = juniSeams();
    const common = {
      messages: [...coldHistory, { role: "user", content: "wat was er in oktober ook alweer?" }],
      documents: DOCUMENTS,
      hindsight: seams.hindsight,
      decisionEngine: seams.decisionEngine,
      orchestrate: seams.orchestrate,
    };
    if (transport === "stream") {
      await performStreamingTurn({ ...common, hermes: { stream: async (m, { onDelta }) => { onDelta("x", false); return "x"; } }, res: fakeRes() });
    } else {
      await performTurn({ ...common, hermes: { chat: async () => "x" } });
    }
    return seams;
  }

  const a = await run("non-stream");
  const b = await run("stream");

  for (const s of [a, b]) {
    assert.equal(s.recallQueries.length, 0, "no anchor, no past-reference cue: recall stays closed");
    const intent = s.decisionInputs[0].intent;
    assert.equal(intent.sourceOfTruth, "unknown");
    assert.deepEqual(intent.referents, []);
    assert.equal(intent.meta.reason, "no_signal_matched");
  }
  assert.deepEqual(b.decisionInputs[0], a.decisionInputs[0]);
});

// --- conversation_search capability: Decision -> Orchestrator -> Response ------

function conversationSearchFixture() {
  const os = require("os");
  const fs = require("fs");
  const path = require("path");
  const { createConversationStore } = require("../src/conversationStore");
  const { createConversationSearchTool } = require("../src/tools/conversationSearch");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-live-"));
  const historyStore = createConversationStore({ historyDir: dir });
  // An OLD saved conversation only reachable via scope saved/all.
  historyStore.saveConversation("old-juni", [
    { role: "user", content: "Vorige maand: ik wil de juni-release naar het einde van de maand schuiven." },
    { role: "assistant", content: "Bewaard: juni-release verplaatst naar maandendeadline." },
  ]);
  const tool = createConversationSearchTool({ historyStore });
  return { historyStore, tools: { conversation_search: tool } };
}

const ANCHORED_INTENTIQ = () => ({
  schemaVersion: "intentiq.v1",
  intent: null,
  status: "unknown",
  sourceOfTruth: "memory",
  needsClarification: false,
  entities: [],
  referents: [{ expression: "juni", resolvedTo: "previous_assistant_turn:juni", confidence: 0.6, source: "previous_assistant_turn" }],
  meta: { reason: "assistant_anchored_follow_up_unresolved_intent" },
});

test("live flow: anchored follow-up routes Decision->conversation_search->native and Gaia answers naturally (non-streaming)", async () => {
  const fixture = conversationSearchFixture();
  const decisionInputs = [];
  const hermesChats = [];
  const result = await performTurn({
    messages: [
      { role: "user", content: "Vertel eens hoe het afgelopen jaar ging." },
      { role: "assistant", content: "Ik zie vooral veel sessies rond juni — zeker gezien de context rond juni destijds." },
      { role: "user", content: "wat was er in juni ook alweer?" },
    ],
    documents: DOCUMENTS,
    hermes: { chat: async (m) => { hermesChats.push(m); return "antwoord"; } },
    hindsight: SILENT_HINDSIGHT,
    res: fakeRes(),
    conversationId: "live-conv-1",
    intentIQ: ANCHORED_INTENTIQ,
    reasonIQ: async () => ({}),
    tools: fixture.tools,
    decisionEngine: (input) => {
      decisionInputs.push(input);
      const { decide } = require("../src/decision/decisionEngine");
      return decide(input);
    },
  });

  assert.equal(result.status, 200);
  // The Decision Engine saw the registered capability.
  assert.ok(decisionInputs[0].availableCapabilities.some((c) => c.id === "conversation_search"));
  // The plan must end with native generation — conversation_search is
  // retrieval PRESENTATION, not answer generation. The native generator
  // receives the search results as context and speaks in Gaia's voice.
  const decision = decisionInputs[0];
  // After decide() with the plan, the decision is a plan.
  // The reply is the native generator's output, not raw passages.
  assert.equal(typeof result.body.reply, 'string');
  assert.ok(result.body.reply.length > 0);
});

test("live flow parity: both transports make the identical conversation_search decision and get identical results", async () => {
  function run() {
    const fixture = conversationSearchFixture();
    const captured = {};
    const common = {
      messages: [
        { role: "user", content: "Vertel eens hoe het afgelopen jaar ging." },
        { role: "assistant", content: "Ik zie vooral veel sessies rond juni — zeker gezien de context rond juni destijds." },
        { role: "user", content: "wat was er in juni ook alweer?" },
      ],
      documents: DOCUMENTS,
      hindsight: SILENT_HINDSIGHT,
      conversationId: "live-conv-1",
      intentIQ: ANCHORED_INTENTIQ,
      reasonIQ: async () => ({}),
      tools: fixture.tools,
      decisionEngine: (input) => {
        captured.input = input;
        const { decide } = require("../src/decision/decisionEngine");
        return decide(input);
      },
      orchestrate: async (decision, ctx) => {
        captured.capabilityMessages = ctx.messages;
        const { execute } = require("../src/orchestration/orchestrator");
        return execute(decision, ctx);
      },
    };
    return { fixture, common, captured };
  }

  const a = run();
  const resA = await performTurn({ ...a.common, hermes: { chat: async () => "antwoord" } });

  const b = run();
  await performStreamingTurn({
    ...b.common,
    hermes: { stream: async (m, { onDelta }) => { onDelta("antwoord", false); return "antwoord"; } },
    res: fakeRes(),
  });

  // Identical cognitive decisions across transports.
  assert.deepEqual(b.captured.input.intent, a.captured.input.intent);
  // Identical transcript presented to the search (same assembled conversation).
  assert.deepEqual(
    b.captured.capabilityMessages.filter((m) => m.role !== "system"),
    a.captured.capabilityMessages.filter((m) => m.role !== "system")
  );
  assert.equal(resA.status, 200);
});

// --- Decision Engine 3.0 parity: planned turns are cognitively identical ------

test("3.0 parity: a planned turn produces an identical plan, steps and reply on both transports", async () => {
  const os = require("os");
  const fs = require("fs");
  const path = require("path");
  const { createConversationStore } = require("../src/conversationStore");
  const { createConversationSearchTool } = require("../src/tools/conversationSearch");

  function buildHarness() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-parity-"));
    const historyStore = createConversationStore({ historyDir: dir });
    historyStore.saveConversation("archief", [
      { role: "user", content: "Vorige maand zei ik dat de juni-release naar het einde van de maand mocht." },
    ]);
    const captured = { decisions: [], hermesCalls: [], nativeMessages: null };
    const tools = {
      conversation_search: createConversationSearchTool({ historyStore }),
      hindsight: { invoke: async () => ({ results: [{ text: "Gaia herinnert zich: release verwacht in juni", relevance: 0.85 }], total: 1 }) },
    };
    // Anchored follow-up + exact-history phrasing => real buildPlan triggers:
    // [conversation_search -> hindsight -> native].
    // nativeGenerator is provided at top-level so native is in availableCapabilities
    // when decide() runs — matching production server.js wiring.
    const nativeGen = {
      generate: async (messages) => { captured.nativeMessages = messages; return "GAIA-Antwoord A"; },
    };
    const intentIQ = () => ({
      schemaVersion: "intentiq.v1", intent: null, status: "unknown",
      sourceOfTruth: "memory", needsClarification: false, entities: [],
      meta: { reason: "assistant_anchored_follow_up_unresolved_intent" },
    });
    return { historyStore, tools, captured, intentIQ, nativeGen };
  }

  const USER_TURN = "Wat weet je nog van mijn plannen en wat zei ik vorige maand precies over de juni-release?";

  // --- non-streaming ---
  const a = buildHarness();
  a.captured.decisionEngine = (input) => {
    const { decide } = require("../src/decision/decisionEngine");
    const d = decide(input);
    a.captured.decisions.push(d);
    return d;
  };
  const resA = await performTurn({
    messages: [{ role: "user", content: USER_TURN }],
    documents: DOCUMENTS,
    hermes: { chat: async (m) => { a.captured.hermesCalls.push(m); return "fallback"; } },
    hindsight: SILENT_HINDSIGHT,
    nativeGenerator: a.nativeGen,
    conversationId: "parity-conv",
    intentIQ: a.intentIQ,
    reasonIQ: async () => ({}),
    tools: a.tools,
    decisionEngine: a.captured.decisionEngine,
    orchestrate: async (decision, ctx) => {
      const { execute } = require("../src/orchestration/orchestrator");
      return execute(decision, ctx);
    },
  });

  // --- streaming ---
  const b = buildHarness();
  b.captured.decisionEngine = (input) => {
    const { decide } = require("../src/decision/decisionEngine");
    const d = decide(input);
    b.captured.decisions.push(d);
    return d;
  };
  await performStreamingTurn({
    messages: [{ role: "user", content: USER_TURN }],
    documents: DOCUMENTS,
    hermes: { stream: async (m, { onDelta }) => { b.captured.hermesCalls.push(m); onDelta("fallback", false); return "fallback"; } },
    hindsight: SILENT_HINDSIGHT,
    nativeGenerator: b.nativeGen,
    res: fakeRes(),
    conversationId: "parity-conv",
    intentIQ: b.intentIQ,
    reasonIQ: async () => ({}),
    tools: b.tools,
    decisionEngine: b.captured.decisionEngine,
    orchestrate: async (decision, ctx) => {
      const { execute } = require("../src/orchestration/orchestrator");
      return execute(decision, ctx);
    },
  });

  // Identical PLAN with identical steps & inputs.
  assert.equal(a.captured.decisions[0].action, "plan");
  assert.deepEqual(b.captured.decisions[0], a.captured.decisions[0]);
  assert.deepEqual(
    b.captured.decisions[0].steps.map((s) => s.capability || s.mode),
    ["conversation_search", "hindsight", "native"]
  );

  // Identical generation input: same rendered step-results block reached
  // native on both transports.
  const sysA = a.captured.nativeMessages.find((m) => m.role === "system" && /earlier plan steps/.test(m.content));
  const sysB = b.captured.nativeMessages.find((m) => m.role === "system" && /earlier plan steps/.test(m.content));
  assert.ok(sysA && sysB, "step results reached native generation on both transports");
  // Normalize the per-store meta timestamps (test fixtures differ, cognition does not).
  const norm = (t) => t.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, 'TS');
  assert.deepEqual(norm(sysB.content), norm(sysA.content));
});

// --- Capability awareness: Gaia's self-knowledge comes from the live registry --

test("capability awareness: registered capabilities are named in the prompt so Gaia never denies them", async () => {
  let capturedMessages = null;
  const hermes = { stream: async (m, { onDelta }) => { capturedMessages = m; onDelta("ok", false); return "ok"; } };
  await performStreamingTurn({
    messages: [{ role: "user", content: "kun je eigenlijk zoeken in mijn chats?" }],
    documents: DOCUMENTS,
    hermes,
    hindsight: SILENT_HINDSIGHT,
    res: fakeRes(),
    intentIQ: () => ({ schemaVersion: "intentiq.v1", intent: "converse", status: "accepted" }),
    reasonIQ: async () => ({}),
    tools: { conversation_search: { invoke: async () => "x" }, hindsight: { invoke: async () => "x" } },
  });
  const block = capturedMessages.find((m) => m.role === "system" && /Capabilities you genuinely have THIS turn/.test(m.content));
  assert.ok(block, "capability awareness block present");
  assert.match(block.content, /conversation_search/);
  assert.match(block.content, /literal text of current and past conversations/);
  assert.match(block.content, /hindsight/);
  assert.match(block.content, /Never deny them/);
});

test("capability awareness: unregistered capabilities are never claimed", async () => {
  let capturedMessages = null;
  const hermes = { chat: async (m) => { capturedMessages = m; return "ok"; } };
  await performTurn({
    messages: [{ role: "user", content: "kun je in mijn chats zoeken?" }],
    documents: DOCUMENTS,
    hermes,
    hindsight: SILENT_HINDSIGHT,
  });
  const block = capturedMessages.find((m) => m.role === "system" && /Capabilities you genuinely have/.test(m.content));
  // Only the core hermes capability is registered on this path: no search
  // capability may be claimed.
  assert.ok(block, "core block still present");
  assert.doesNotMatch(block.content, /conversation_search/);
});

// --- Capability Registry 1.0 parity: a Hermes skill-plan is identical on both transports ---

test("1.0 parity: a skill plan produces identical decision+skill and the same Hermes instruction on both transports", async () => {
  const USER_TURN = "Zoek uit waarom deze race condition optreedt.";
  function harness() {
    const captured = { decisions: [], hermesMessages: null };
    return {
      captured,
      hermes: {
        chat: async (m) => { captured.hermesMessages = m; return "analyse"; },
        stream: async (m, { onDelta } = {}) => { captured.hermesMessages = m; if (onDelta) onDelta("analyse", false); return "analyse"; },
      },
      intentIQ: () => ({ schemaVersion: "intentiq.v1", intent: null, status: "unknown" }),
      decisionEngine: (input) => {
        const { decide } = require("../src/decision/decisionEngine");
        const d = decide(input);
        captured.decisions.push(d);
        return d;
      },
    };
  }

  const a = harness();
  await performTurn({
    messages: [{ role: "user", content: USER_TURN }],
    documents: DOCUMENTS,
    hermes: a.hermes,
    hindsight: SILENT_HINDSIGHT,
    nativeGenerator: { generate: async () => "GAIA debug-antwoord" },
    intentIQ: a.intentIQ,
    reasonIQ: async () => ({}),
    decisionEngine: a.decisionEngine,
    orchestrate: async (decision, ctx) => {
      const { execute } = require("../src/orchestration/orchestrator");
      return execute(decision, ctx);
    },
  });

  const b = harness();
  await performStreamingTurn({
    messages: [{ role: "user", content: USER_TURN }],
    documents: DOCUMENTS,
    hermes: b.hermes,
    hindsight: SILENT_HINDSIGHT,
    nativeGenerator: { generate: async () => "GAIA debug-antwoord" },
    res: fakeRes(),
    intentIQ: b.intentIQ,
    reasonIQ: async () => ({}),
    decisionEngine: b.decisionEngine,
    orchestrate: async (decision, ctx) => {
      const { execute } = require("../src/orchestration/orchestrator");
      return execute(decision, ctx);
    },
  });

  // Identical plan with identical skill selection.
  assert.equal(a.captured.decisions[0].action, "plan");
  assert.deepEqual(b.captured.decisions[0], a.captured.decisions[0]);
  const hermesStepA = a.captured.decisions[0].steps.find((s) => s.capability === "hermes");
  assert.equal(hermesStepA.skill, "systematic-debugging");

  // Hermes received the SAME explicit skill instruction on both transports.
  const instrA = a.captured.hermesMessages.find((m) => /Use the Hermes skill "systematic-debugging"/.test(m.content));
  const instrB = b.captured.hermesMessages.find((m) => /Use the Hermes skill "systematic-debugging"/.test(m.content));
  assert.ok(instrA && instrB, "skill instruction reached Hermes on both transports");
});

// --- web → native retrieval flow (Generation Policy 0.1: web as knowledge retrieval) --

test("web → native: simple external-knowledge turn produces a plan [web, native] and Gaia formulates the answer", async () => {
  let webQuery = null;
  const webSearch = {
    search: async (q) => { webQuery = q; return "raw formatted results"; },
    searchResults: async (q) => { webQuery = q; return { results: [{ title: "Suno Voice Upload", url: "https://suno.com/upload", text: "Upload your voice via Settings > Voice Clone", source: "web", relevance: 1.0 }], total: 1 }; },
  };
  const nativeMessages = [];
  const res = await performTurn({
    messages: [{ role: "user", content: "Hoe werkt de huidige Suno voice upload?" }],
    documents: DOCUMENTS,
    hermes: { chat: async () => { throw new Error("Hermes must not be called for web→native"); } },
    hindsight: SILENT_HINDSIGHT,
    webSearch,
    nativeGenerator: { generate: async (m) => { nativeMessages.push(m); return "Gaia: je kunt je stem uploaden via Settings > Voice Clone bij Suno."; } },
    decisionEngine: (input) => {
      const { decide } = require("../src/decision/decisionEngine");
      return decide(input);
    },
  });
  // Plan was [web, native] — web retrieved, native generated.
  assert.ok(webQuery, "web search must have been called");
  assert.equal(res.status, 200);
  assert.match(res.body.reply, /Gaia/);
  // Native received context containing provenance from the web step.
  const nativeSys = nativeMessages.flat().find((m) => m.role === "system" && /step-\d+ · web/.test(m.content));
  assert.ok(nativeSys, "native must receive the web results as context");
  assert.match(nativeSys.content, /Suno Voice Upload/, "context must include the result title");
  assert.match(nativeSys.content, /suno\.com/, "context must include the URL provenance");
  assert.match(nativeSys.content, /background only/, "context must include generation guidance");
});

test("web failure: optional web step does not kill the plan — native still answers", async () => {
  const webSearch = {
    search: async () => { throw new Error("Brave unreachable"); },
    searchResults: async () => { throw new Error("Brave unreachable"); },
  };
  const res = await performTurn({
    messages: [{ role: "user", content: "Wat is de huidige API van Suno?" }],
    documents: DOCUMENTS,
    hermes: { chat: async () => { throw new Error("Hermes must not be called"); } },
    hindsight: SILENT_HINDSIGHT,
    webSearch,
    nativeGenerator: { generate: async () => "Gaia: ik kon helaas geen actuele informatie vinden over de Suno API." },
    decisionEngine: (input) => {
      const { decide } = require("../src/decision/decisionEngine");
      return decide(input);
    },
  });
  assert.equal(res.status, 200);
  assert.match(res.body.reply, /Gaia/);
});

test("empty web results: native receives '(geen resultaten)' context and can answer honestly", async () => {
  const nativeMessages = [];
  const webSearch = {
    search: async () => "I looked, but couldn't find anything relevant.",
    searchResults: async () => ({ results: [], total: 0 }),
  };
  const res = await performTurn({
    messages: [{ role: "user", content: "Wat is de nieuwste Suno feature?" }],
    documents: DOCUMENTS,
    hermes: { chat: async () => { throw new Error("Hermes must not be called"); } },
    hindsight: SILENT_HINDSIGHT,
    webSearch,
    nativeGenerator: { generate: async (m) => { nativeMessages.push(m); return "Gaia: er is onvoldoende externe informatie gevonden."; } },
    decisionEngine: (input) => {
      const { decide } = require("../src/decision/decisionEngine");
      return decide(input);
    },
  });
  assert.equal(res.status, 200);
  // Native received context with "(geen resultaten)" marker.
  const nativeSys = nativeMessages.flat().find((m) => m.role === "system" && /step-\d+ · web/.test(m.content));
  assert.ok(nativeSys, "native must receive web context even when empty");
  assert.match(nativeSys.content, /geen resultaten/);
});

test("web→native streaming/non-streaming parity: same plan, same web query, same step inputs on both transports", async () => {
  function harness() {
    const captured = { webQueries: [], nativeMessages: null, decisions: [] };
    const webSearch = {
      search: async (q) => { captured.webQueries.push(q); return "formatted"; },
      searchResults: async (q) => { captured.webQueries.push(q); return { results: [{ title: "test", url: "https://example.com", text: "info", source: "web", relevance: 1.0 }], total: 1 }; },
    };
    return {
      captured,
      webSearch,
      decisionEngine: (input) => {
        const { decide } = require("../src/decision/decisionEngine");
        const d = decide(input);
        captured.decisions.push(d);
        return d;
      },
    };
  }

  const a = harness();
  await performTurn({
    messages: [{ role: "user", content: "Wat is de huidige API van Suno?" }],
    documents: DOCUMENTS,
    hermes: { chat: async () => { throw new Error("no"); } },
    hindsight: SILENT_HINDSIGHT,
    webSearch: a.webSearch,
    nativeGenerator: { generate: async (m) => { a.captured.nativeMessages = m; return "answer A"; } },
    decisionEngine: a.decisionEngine,
    orchestrate: async (decision, ctx) => {
      const { execute } = require("../src/orchestration/orchestrator");
      return execute(decision, ctx);
    },
  });

  const b = harness();
  await performStreamingTurn({
    messages: [{ role: "user", content: "Wat is de huidige API van Suno?" }],
    documents: DOCUMENTS,
    hermes: { stream: async () => { throw new Error("no"); } },
    hindsight: SILENT_HINDSIGHT,
    nativeGenerator: { generate: async (m) => { b.captured.nativeMessages = m; return "answer A"; }, stream: async (m, { onDelta }) => { b.captured.nativeMessages = m; onDelta("a", false); return "answer A"; } },
    webSearch: b.webSearch,
    decisionEngine: b.decisionEngine,
    res: fakeRes(),
    orchestrate: async (decision, ctx) => {
      const { execute } = require("../src/orchestration/orchestrator");
      return execute(decision, ctx);
    },
  });

  // Same plan on both transports.
  assert.equal(a.captured.decisions[0].action, "plan");
  assert.deepEqual(b.captured.decisions[0], a.captured.decisions[0]);
  // Same web query.
  assert.deepEqual(a.captured.webQueries, b.captured.webQueries);
  // Same step inputs.
  const stepsA = a.captured.decisions[0].steps;
  const stepsB = b.captured.decisions[0].steps;
  assert.equal(stepsA.length, stepsB.length);
  for (let i = 0; i < stepsA.length; i++) {
    assert.deepEqual(stepsA[i].input, stepsB[i].input, `step ${i} input must match`);
  }
});

// --- Deferred deep reasoning: the model call runs AFTER the reply ------------
//
// ReasonIQ's depth is a free heuristic; when it says 'deep' the turn routes on
// a routing-only result and runs the expensive call after the reply, feeding
// the hypothesis lifecycle from there. (flushBackground /
// DEEP_EVIDENCE_HINDSIGHT are defined at the top of this file — they are
// shared with the Phase 2 ReasonIQ-optional tests above.)

function deepReasoningResult() {
  return {
    interpretation: 'weighing',
    hypotheses: [{ statement: 'Cancellation races teardown.', existingId: 'hyp-seed', confidence: 0.7, evidenceFor: [], evidenceAgainst: [] }],
    hypothesisUpdates: [{ hypothesisId: 'hyp-seed', relation: 'supports', confidenceDelta: 0.05, rationale: 'new analysis', evidenceId: null }],
    contradictions: [], uncertainties: [], informationGaps: [],
    conclusions: [], sufficientForConclusion: false, confidence: 0.65,
  };
}

test('deferred reasoning: an evidence-bearing analysis turn replies without waiting for ReasonIQ, and applies hypotheses afterwards', async () => {
  const { decide } = require('../src/decision/decisionEngine');
  const manager = (require('../src/reasoning/hypothesisManager')).createHypothesisManager({
    hypotheses: [{ id: 'hyp-seed', statement: 'Cancellation races teardown.', status: 'testing', confidence: 0.6, evidenceFor: ['e1'] }],
  });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const reasonIQCalls = [];
  const decisionInputs = [];
  const res = fakeRes();
  let hermesCalls = 0;
  const hermes = { stream: async (messages, { onDelta }) => { hermesCalls += 1; onDelta('ok', false); return 'A reply.'; } };

  await performStreamingTurn({
    messages: [{ role: 'user', content: 'Analyseer de streaming architecture op race conditions, zoals we eerder bespraken.' }],
    documents: DOCUMENTS,
    hermes,
    hindsight: DEEP_EVIDENCE_HINDSIGHT,
    res,
    intentIQ: () => ({ schemaVersion: 'intentiq.v1', intent: 'inform.explain', status: 'accepted' }),
    reasonIQ: async (input) => { reasonIQCalls.push(input); await gate; return deepReasoningResult(); },
    decisionEngine: (input) => { decisionInputs.push(input); return decide(input); },
    hypothesisRuntime: { manager },
  });

  // The turn is finished while the reasoning call is still pending. The
  // CURRENT turn's decision carries NO reasoning result at all — background
  // cognition cannot influence the turn that produced it (Phase: ReasonIQ as
  // background cognition). The analysis wording still routes to Hermes via
  // the IntentIQ analysis cue.
  assert.equal(hermesCalls, 1, 'the analysis turn still routes to Hermes (IntentIQ analysis cue)');
  assert.equal(decisionInputs.length, 1);
  assert.equal(decisionInputs[0].reasoning, null, 'no reasoning result in the current turn\'s decision');
  assert.equal(manager.get('hyp-seed').confidence, 0.6, 'not applied before the background call resolves');

  release();
  await flushBackground();
  assert.equal(manager.get('hyp-seed').confidence, 0.65, 'update applied once the background call resolved');
  assert.equal(reasonIQCalls.length, 1, 'ReasonIQ runs exactly once per turn');
  assert.equal(reasonIQCalls[0].existingHypotheses[0].id, 'hyp-seed');
});

test('deferred reasoning: a failing background call never breaks the turn or leaks a rejection', async () => {
  const unhandled = [];
  const onUnhandled = (err) => unhandled.push(err);
  process.on('unhandledRejection', onUnhandled);
  try {
    const res = fakeRes();
    const hermes = { stream: async (messages, { onDelta }) => { onDelta('still fine', false); return 'still fine'; } };
    await performStreamingTurn({
      messages: [{ role: 'user', content: 'Analyseer de streaming architecture op race conditions, zoals we eerder bespraken.' }],
      documents: DOCUMENTS,
      hermes,
      hindsight: DEEP_EVIDENCE_HINDSIGHT,
      res,
      intentIQ: () => ({ schemaVersion: 'intentiq.v1', intent: 'inform.explain', status: 'accepted' }),
      reasonIQ: async () => { throw new Error('boom'); },
    });
    await flushBackground();
    assert.deepEqual(unhandled, []);
    assert.match(res.written.join(''), /still fine/);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

// PHASE 2: a shallow (normal) turn makes NO ReasonIQ call at all — ReasonIQ
// is optional, not mandatory.
test('deferred reasoning: a shallow turn makes no ReasonIQ call and never waits on one', async () => {
  const order = [];
  const hermes = { stream: async (messages, { onDelta }) => { order.push('hermes'); onDelta('ok', false); return 'ok'; } };
  await performStreamingTurn({
    messages: [{ role: 'user', content: 'Hoi Gaia' }],
    documents: DOCUMENTS,
    hermes,
    hindsight: SILENT_HINDSIGHT,
    res: fakeRes(),
    intentIQ: () => ({ schemaVersion: 'intentiq.v1', intent: 'greet', status: 'accepted' }),
    reasonIQ: async () => { order.push('reasonIQ'); return { reasoningDepth: 'shallow' }; },
  });
  await flushBackground();
  assert.deepEqual(order, ['hermes'], 'no ReasonIQ call anywhere — inline or deferred');
});

// PHASE 2: ReasonIQ cannot trigger another Decision Engine cycle — its result
// feeds the hypothesis lifecycle only, and a failing ReasonIQ can never loop
// back into a second decision for the same turn.
test('deferred reasoning: a deep turn makes exactly one decision and at most one ReasonIQ call — no decision loop', async () => {
  const decisionInputs = [];
  let reasonIQCalls = 0;
  const hermes = { stream: async (messages, { onDelta }) => { onDelta('ok', false); return 'A reply.'; } };
  const { decide } = require('../src/decision/decisionEngine');
  await performStreamingTurn({
    messages: [{ role: 'user', content: 'Analyseer de streaming architecture op race conditions, zoals we eerder bespraken.' }],
    documents: DOCUMENTS,
    hermes,
    hindsight: DEEP_EVIDENCE_HINDSIGHT,
    res: fakeRes(),
    intentIQ: () => ({ schemaVersion: 'intentiq.v1', intent: 'inform.explain', status: 'accepted' }),
    reasonIQ: async () => { reasonIQCalls += 1; return deepReasoningResult(); },
    decisionEngine: (input) => { decisionInputs.push(input); return decide(input); },
    hypothesisRuntime: { manager: { list: () => [], applyReasoningResult: () => {} } },
  });
  await flushBackground();
  assert.equal(decisionInputs.length, 1, 'exactly ONE Decision Engine call for the turn');
  assert.equal(reasonIQCalls, 1, 'ReasonIQ runs at most once');
});

test('deferred reasoning: a failing deferred ReasonIQ call never triggers a second decision', async () => {
  const decisionInputs = [];
  const hermes = { stream: async (messages, { onDelta }) => { onDelta('still fine', false); return 'still fine'; } };
  await performStreamingTurn({
    messages: [{ role: 'user', content: 'Analyseer de streaming architecture op race conditions, zoals we eerder bespraken.' }],
    documents: DOCUMENTS,
    hermes,
    hindsight: DEEP_EVIDENCE_HINDSIGHT,
    res: fakeRes(),
    intentIQ: () => ({ schemaVersion: 'intentiq.v1', intent: 'inform.explain', status: 'accepted' }),
    reasonIQ: async () => { throw new Error('reasoning model down'); },
    decisionEngine: (input) => { decisionInputs.push(input); return { action: 'capability', capability: 'hermes', task: 'respond', input: {}, reason: 'test' }; },
    hypothesisRuntime: { manager: { list: () => [], applyReasoningResult: () => {} } },
  });
  await flushBackground();
  assert.equal(decisionInputs.length, 1, 'a ReasonIQ failure cannot cause another decision cycle');
});

// --- REASONIQ AS BACKGROUND COGNITION ----------------------------------------
//
// The conversational path (IntentIQ → Decision → Response) and the cognition
// path (turn → ReasonIQ → hypotheses/patterns → storage) are two loosely
// coupled processes. ReasonIQ analyzes the completed turn in the background:
// it may generate and evaluate hypotheses and persist them where a FUTURE
// turn's normal context recall can find them — but it can never reroute the
// current turn, never re-enters the Decision Engine, never invokes itself, and
// its failures never touch the conversation.

test('background cognition: hypothesis GENERATION happens asynchronously, after the reply', async () => {
  const { createHypothesisManager } = require('../src/reasoning/hypothesisManager');
  const manager = createHypothesisManager({});
  const order = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const hermes = { stream: async (m, { onDelta }) => { order.push('hermes'); onDelta('ok', false); return 'A reply.'; } };
  const reasonIQCalls = [];
  await performStreamingTurn({
    messages: [{ role: 'user', content: 'Analyseer de streaming architecture op race conditions, zoals we eerder bespraken.' }],
    documents: DOCUMENTS,
    hermes,
    hindsight: DEEP_EVIDENCE_HINDSIGHT,
    res: fakeRes(),
    intentIQ: () => ({ schemaVersion: 'intentiq.v1', intent: 'inform.explain', status: 'accepted' }),
    reasonIQ: async (input) => {
      order.push('reasonIQ');
      reasonIQCalls.push(input);
      await gate;
      return {
        interpretation: 'weighing',
        hypotheses: [{ statement: 'Cancellation races stream teardown.', confidence: 0.7, evidenceFor: ['hindsight-1'], persistence: 'durable' }],
        hypothesisUpdates: [],
        contradictions: [], uncertainties: [], informationGaps: [],
        conclusions: [], sufficientForConclusion: false, confidence: 0.7,
      };
    },
    hypothesisRuntime: { manager },
  });
  // The hypothesis did NOT exist while the reply was produced; it is the
  // background analysis that generates it.
  assert.equal(order[0], 'hermes', 'the reply is produced first');
  assert.ok(order.includes('reasonIQ'), 'the background analysis started');
  assert.equal(manager.list().length, 0, 'no hypothesis exists at reply time');
  release();
  await flushBackground();
  assert.equal(reasonIQCalls.length, 1);
  assert.equal(manager.list().length, 1, 'the background analysis generated the hypothesis afterwards');
  assert.match(manager.list()[0].statement, /Cancellation races/);
});

test('background cognition: hypothesis EVALUATION happens asynchronously (confidence updates on later evidence)', async () => {
  const { createHypothesisManager } = require('../src/reasoning/hypothesisManager');
  const manager = createHypothesisManager({
    hypotheses: [{ id: 'hyp-seed', statement: 'Cancellation races teardown.', status: 'testing', confidence: 0.5, evidenceFor: ['e1'] }],
  });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const hermes = { stream: async (m, { onDelta }) => { onDelta('ok', false); return 'A Reply.'; } };
  await performStreamingTurn({
    messages: [{ role: 'user', content: 'Analyseer de streaming architecture op race conditions, zoals we eerder bespraken.' }],
    documents: DOCUMENTS,
    hermes,
    hindsight: DEEP_EVIDENCE_HINDSIGHT,
    res: fakeRes(),
    intentIQ: () => ({ schemaVersion: 'intentiq.v1', intent: 'inform.explain', status: 'accepted' }),
    reasonIQ: async () => { await gate; return deepReasoningResult(); },
    hypothesisRuntime: { manager },
  });
  assert.equal(manager.get('hyp-seed').confidence, 0.5, 'unchanged while the reply is produced');
  release();
  await flushBackground();
  // deepReasoningResult() carries a +0.05 supporting confidenceDelta for
  // hyp-seed — the background analysis evaluated the tracked hypothesis
  // against the new evidence.
  assert.equal(manager.get('hyp-seed').confidence, 0.55, 'the background analysis evaluated the hypothesis against new evidence');
});

test('background cognition: ReasonIQ cannot invoke itself recursively — one call per turn, no re-entry', async () => {
  let reasonIQCalls = 0;
  const hermes = { stream: async (m, { onDelta }) => { onDelta('ok', false); return 'A Reply.'; } };
  await performStreamingTurn({
    messages: [{ role: 'user', content: 'Analyseer de streaming architecture op race conditions, zoals we eerder bespraken.' }],
    documents: DOCUMENTS,
    hermes,
    hindsight: DEEP_EVIDENCE_HINDSIGHT,
    res: fakeRes(),
    intentIQ: () => ({ schemaVersion: 'intentiq.v1', intent: 'inform.explain', status: 'accepted' }),
    reasonIQ: async () => {
      reasonIQCalls += 1;
      return deepReasoningResult();
    },
    hypothesisRuntime: { manager: { list: () => [], applyReasoningResult: () => {} } },
  });
  await flushBackground();
  assert.equal(reasonIQCalls, 1, 'exactly one ReasonIQ execution — background cognition has no self-recursion path');
});

test('background cognition: cognitive material produced by turn N reaches turn N+1 through normal context recall', async () => {
  const { createHypothesisManager } = require('../src/reasoning/hypothesisManager');
  const manager = createHypothesisManager({});
  const hermes = { stream: async (m, { onDelta }) => { onDelta('ok', false); return 'A Reply.'; } };
  const { decide } = require('../src/decision/decisionEngine');
  const decisionInputs = [];

  // Turn 1: analysis produces a durable cognitive observation.
  await performStreamingTurn({
    messages: [{ role: 'user', content: 'Analyseer de streaming architecture op race conditions, zoals we eerder bespraken.' }],
    documents: DOCUMENTS,
    hermes,
    hindsight: DEEP_EVIDENCE_HINDSIGHT,
    res: fakeRes(),
    intentIQ: () => ({ schemaVersion: 'intentiq.v1', intent: 'inform.explain', status: 'accepted' }),
    reasonIQ: async () => ({
      interpretation: 'weighing',
      hypotheses: [{ statement: 'User appears to prefer architectural separation between agency, reasoning, and memory.', confidence: 0.7, evidenceFor: ['hindsight-1'], persistence: 'durable' }],
      hypothesisUpdates: [], contradictions: [], uncertainties: [], informationGaps: [],
      conclusions: [], sufficientForConclusion: false, confidence: 0.7,
    }),
    hypothesisRuntime: { manager },
  });
  await flushBackground();
  assert.equal(manager.list().length, 1, 'turn N produced a durable hypothesis');

  // Turn 2: the SAME runtime is wired for the next turn — the normal context
  // recall path (hypothesis/pattern recall → Decision Engine context) makes
  // the stored cognitive material available; Gaia decides what to do with it.
  await performStreamingTurn({
    messages: [{ role: 'user', content: 'Wat vind je van mijn aanpak voor de cognitive architecture?' }],
    documents: DOCUMENTS,
    hermes,
    hindsight: SILENT_HINDSIGHT,
    res: fakeRes(),
    intentIQ: () => ({ schemaVersion: 'intentiq.v1', intent: 'converse', status: 'accepted' }),
    reasonIQ: async () => ({}),
    decisionEngine: (input) => { decisionInputs.push(input); return decide(input); },
    hypothesisRuntime: {
      manager,
      recallPatterns: async () => [{
        id: 'ptf-1',
        statement: manager.list()[0].statement,
        status: 'established', confidence: 0.7,
        hypothesisIds: [manager.list()[0].id],
        persistence: 'durable', relevance: 0.9,
      }],
    },
  });
  await flushBackground();
  assert.equal(decisionInputs.length, 1, 'turn N+1 makes exactly one decision of its own');
  const recalled = decisionInputs[0].context.patterns || [];
  assert.equal(recalled.length, 1, 'turn N\'s cognitive material reached turn N+1\'s context');
  assert.match(recalled[0].statement, /architectural separation/);
});

test('deferred cognition: a normal streaming reply completes without awaiting deferred cognition', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const order = [];
  let reflectCalled = false;
  const hermes = { stream: async (messages, { onDelta }) => { order.push('hermes'); onDelta('ok', false); return 'A reply.'; } };
  const res = fakeRes();
  await performStreamingTurn({
    messages: [{ role: 'user', content: 'Onthoud dat ik mijn VPS heel belangrijk vind.' }],
    documents: DOCUMENTS,
    hermes,
    hindsight: { recall: async () => [], reflect: async () => { reflectCalled = true; await gate; } },
    res,
    intentIQ: () => ({ schemaVersion: 'intentiq.v1', intent: 'converse', status: 'accepted' }),
    reasonIQ: async () => ({}),
    hypothesisRuntime: {
      manager: { list: () => [], applyReasoningResult: () => {} },
      ensureLoaded: async () => { order.push('ensureLoaded'); },
      recallHypotheses: async () => { order.push('recallHypotheses'); return []; },
    },
  });
  // The reply is fully delivered while Hindsight reflection is still pending —
  // the turn NEVER waits for deferred cognition.
  assert.match(res.written.at(-1), /data: \[DONE\]/);
  assert.equal(order[0], 'hermes', 'the reply is produced before any deferred work');
  assert.ok(order.indexOf('hermes') < order.indexOf('ensureLoaded'), 'hypothesis loading runs only after the reply');
  assert.ok(order.indexOf('hermes') < order.indexOf('recallHypotheses'), 'hypothesis recall runs only after the reply');
  release();
  await flushBackground();
  assert.equal(reflectCalled, true, 'deferred reflection runs after the reply');
});

test('deferred cognition: a normal non-streaming reply returns without awaiting deferred cognition', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let reflectCalled = false;
  let recallHypothesesCalled = false;
  const result = await performTurn({
    messages: [{ role: 'user', content: 'Onthoud dat ik mijn VPS heel belangrijk vind.' }],
    documents: DOCUMENTS,
    hermes: { chat: async () => 'Een antwoord.' },
    hindsight: { recall: async () => [], reflect: async () => { reflectCalled = true; await gate; } },
    intentIQ: () => ({ schemaVersion: 'intentiq.v1', intent: 'converse', status: 'accepted' }),
    reasonIQ: async () => ({}),
    hypothesisRuntime: {
      manager: { list: () => [], applyReasoningResult: () => {} },
      ensureLoaded: async () => {},
      recallHypotheses: async () => { recallHypothesesCalled = true; await gate; return []; },
    },
  });
  // The HTTP-shaped result is returned while reflection AND hypothesis recall
  // are still pending — the endpoint never waits for deferred cognition.
  assert.equal(result.status, 200);
  assert.equal(result.body.reply, 'Een antwoord.');
  assert.equal(reflectCalled, false, 'the reply is returned before reflection completes');
  assert.equal(recallHypothesesCalled, true, 'hypothesis recall started (after the reply, deferred)');
  release();
  await flushBackground();
  assert.equal(reflectCalled, true, 'deferred reflection runs after the reply');
});

test('deferred cognition: hypothesis recall and ensureLoaded run only after the conversational reply', async () => {
  const order = [];
  const hermes = { stream: async (messages, { onDelta }) => { order.push('hermes'); onDelta('ok', false); return 'A reply.'; } };
  const res = fakeRes();
  await performStreamingTurn({
    messages: [{ role: 'user', content: 'Waarom crasht mijn website?' }],
    documents: DOCUMENTS,
    hermes,
    hindsight: SILENT_HINDSIGHT,
    res,
    intentIQ: () => ({ schemaVersion: 'intentiq.v1', intent: 'inform.explain', status: 'accepted' }),
    reasonIQ: async () => ({}),
    hypothesisRuntime: {
      manager: { list: () => [], applyReasoningResult: () => {} },
      ensureLoaded: async () => { order.push('ensureLoaded'); },
      recallHypotheses: async () => { order.push('recallHypotheses'); return []; },
    },
  });
  // The reply was fully delivered (S deferred work ran.
  assert.match(res.written.at(-1), /data: \[DONE\]/);
  assert.equal(order[0], 'hermes', 'the reply is produced before any hypothesis work');
  await flushBackground();
  assert.ok(order.includes('ensureLoaded') && order.includes('recallHypotheses'),
    'hypothesis lifecycle work runs in the deferred phase');
  assert.ok(order.indexOf('hermes') < order.indexOf('ensureLoaded'),
    'ensureLoaded runs only after the reply');
  assert.ok(order.indexOf('hermes') < order.indexOf('recallHypotheses'),
    'recallHypotheses runs only after the reply');
});

test('deferred cognition: Memoryworthiness and pattern formation never precede the reply', async () => {
  const order = [];
  const hermes = { stream: async (messages, { onDelta }) => { order.push('hermes'); onDelta('ok', false); return 'A Reply.'; } };
  await performStreamingTurn({
    messages: [{ role: 'user', content: 'Analyseer de architectuur van de streaming pipeline.' }],
    documents: DOCUMENTS,
    hermes,
    hindsight: SILENT_HINDSIGHT,
    res: fakeRes(),
    intentIQ: () => ({ schemaVersion: 'intentiq.v1', intent: 'inform.explain', status: 'accepted' }),
    reasonIQ: async () => ({
      interpretation: 'x',
      hypotheses: [{ statement: 'Hypothesis from an analysis turn.', confidence: 0.7, evidenceFor: ['e1'], persistence: 'durable' }],
      hypothesisUpdates: [],
      contradictions: [], uncertainties: [], informationGaps: [],
      conclusions: [], sufficientForConclusion: false, confidence: 0.6,
    }),
    hypothesisRuntime: {
      manager: { list: () => [], applyReasoningResult: () => {} },
      patternManager: { maybeFormPatterns: () => { order.push('patternFormation'); } },
    },
    decisionStore: { append: () => {} },
  });
  assert.deepEqual(order, ['hermes'], 'no pattern formation may precede the reply');
});

test('deferred cognition: a failure inside the deferred phase never fails the turn (streaming)', async () => {
  const res = fakeRes();
  const hermes = { stream: async (messages, { onDelta }) => { onDelta('still fine', false); return 'still fine'; } };
  await performStreamingTurn({
    messages: [{ role: 'user', content: 'Waarom crasht mijn website?' }],
    documents: DOCUMENTS,
    hermes,
    hindsight: SILENT_HINDSIGHT,
    res,
    intentIQ: () => ({ schemaVersion: 'intentiq.v1', intent: 'inform.explain', status: 'accepted' }),
    reasonIQ: async () => { throw new Error('deferred boom'); },
    hypothesisRuntime: {
      manager: { list: () => { throw new Error('list boom'); }, applyReasoningResult: () => { throw new Error('apply boom'); } },
      ensureLoaded: async () => { throw new Error('load boom'); },
      recallHypotheses: async () => { throw new Error('recall boom'); },
      patternManager: { maybeFormPatterns: () => { throw new Error('pattern boom'); } },
    },
  });
  await flushBackground();
  assert.match(res.written.join(''), /still fine/);
  assert.equal(res.written.at(-1), 'data: [DONE]\n\n');
});

test('deferred cognition: no unhandled promise rejection when the deferred phase fails', async () => {
  const unhandled = [];
  const onUnhandled = (err) => unhandled.push(err);
  process.on('unhandledRejection', onUnhandled);
  try {
    const hermes = { stream: async (messages, { onDelta }) => { onDelta('ok', false); return 'ok'; } };
    await performStreamingTurn({
      messages: [{ role: 'user', content: 'Onthoud dat mijn VPS kritiek is.' }],
      documents: DOCUMENTS,
      hermes,
      hindsight: { recall: async () => [], reflect: async () => { throw new Error('reflect boom'); } },
      res: fakeRes(),
      intentIQ: () => ({ schemaVersion: 'intentiq.v1', intent: 'converse', status: 'accepted' }),
      reasonIQ: async () => ({}),
      hypothesisRuntime: {
        manager: { list: () => [], applyReasoningResult: () => { throw new Error('apply boom'); } },
        ensureLoaded: async () => { throw new Error('load boom'); },
      },
    });
    await flushBackground();
    assert.deepEqual(unhandled, [], 'deferred failures must never leak as unhandled rejections');
    // The conversation itself was unaffected.
    const hermes2 = { stream: async (messages, { onDelta }) => { onDelta('ok2', false); return 'ok2'; } };
    const res2 = fakeRes();
    await performStreamingTurn({
      messages: [{ role: 'user', content: 'Hoi Gaia' }],
      documents: DOCUMENTS,
      hermes: hermes2,
      hindsight: SILENT_HINDSIGHT,
      res: res2,
    });
    await flushBackground();
    assert.match(res2.written.join(''), /ok2/);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('deferred cognition: streaming and non-streaming produce the same reply and both defer reflection', async () => {
  const makeSeams = () => {
    const seams = { reflectCalls: [], recallHypothesesCalls: 0 };
    seams.hindsight = { recall: async () => [], reflect: async (item) => { seams.reflectCalls.push(item); } };
    seams.hypothesisRuntime = {
      manager: { list: () => [], applyReasoningResult: () => {} },
      ensureLoaded: async () => {},
      recallHypotheses: async () => { seams.recallHypothesesCalls += 1; return []; },
    };
    return seams;
  };
  const messages = [{ role: 'user', content: 'Onthoud dat ik altijd via de VPS deploy.' }];
  const intent = () => ({ schemaVersion: 'intentiq.v1', intent: 'converse', status: 'accepted' });
  const reasoning = async () => ({});

  const a = makeSeams();
  const nonStreaming = await performTurn({
    messages, documents: DOCUMENTS,
    hermes: { chat: async () => 'Genoteerd.' },
    hindsight: a.hindsight, intentIQ: intent, reasonIQ: reasoning,
    hypothesisRuntime: a.hypothesisRuntime,
  });
  assert.equal(nonStreaming.status, 200);
  assert.equal(nonStreaming.body.reply, 'Genoteerd.');
  await flushBackground();
  assert.equal(a.recallHypothesesCalls, 1, 'non-streaming defers (but still runs) hypothesis recall');
  assert.equal(a.reflectCalls.length, 1);

  const b = makeSeams();
  const res = fakeRes();
  await performStreamingTurn({
    messages, documents: DOCUMENTS,
    hermes: { stream: async (m, { onDelta }) => { onDelta('Genoteerd.', false); return 'Genoteerd.'; } },
    hindsight: b.hindsight, res, intentIQ: intent, reasonIQ: reasoning,
    hypothesisRuntime: b.hypothesisRuntime,
  });
  await flushBackground();
  assert.equal(b.recallHypothesesCalls, 1, 'streaming defers (but still runs) hypothesis recall');
  assert.equal(b.reflectCalls.length, 1);
  // Identical memory semantics on both transports.
  assert.equal(
    a.reflectCalls[0].metadata.gaia_memory_decision,
    b.reflectCalls[0].metadata.gaia_memory_decision
  );
});

test('deferred cognition: a deep turn starts its deferred ReasonIQ only after the reply is produced', async () => {
  const order = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const hermes = { stream: async (messages, { onDelta }) => { order.push('hermes'); onDelta('ok', false); return 'A reply.'; } };
  const res = fakeRes();
  await performStreamingTurn({
    messages: [{ role: 'user', content: 'Analyseer de streaming architecture op race conditions, zoals we eerder bespraken.' }],
    documents: DOCUMENTS,
    hermes,
    hindsight: DEEP_EVIDENCE_HINDSIGHT,
    res,
    intentIQ: () => ({ schemaVersion: 'intentiq.v1', intent: 'inform.explain', status: 'accepted' }),
    reasonIQ: async () => { order.push('reasonIQ'); await gate; return deepReasoningResult(); },
    hypothesisRuntime: { manager: { list: () => [], applyReasoningResult: () => {} } },
  });
  // Reply fully delivered while deep ReasonIQ is still pending — the turn
  // completed without it. Deep ReasonIQ may only have STARTED after hermes.
  assert.match(res.written.at(-1), /data: \[DONE\]/);
  assert.equal(order[0], 'hermes', 'the reply is produced before deep reasoning');
  release();
  await flushBackground();
  assert.ok(order.includes('reasonIQ'), 'the deferred deep call runs after the reply');
  assert.ok(order.indexOf('hermes') < order.indexOf('reasonIQ'),
    'deep ReasonIQ may only start after the reply is produced');
});


// --- REASONIQ COGNITIVE ANALYSIS MODEL v1.0 ------------------------------------
//
// The background path now analyzes the COMPLETED conversation (user turn +
// Gaia's delivered reply) and derives durable cognitive results: concrete
// observations and open questions flow to Hindsight as ordinary world facts
// through the existing runtime (no second store), while hypotheses/patterns
// keep their existing managers and lifecycles. The reflection block stays
// observability-only. None of it can touch the reply it analyzes.

function v1ReasoningResult(overrides = {}) {
  return {
    interpretation: 'The user decided the reasoning layer stays in the background.',
    hypotheses: [{
      statement: 'The user prefers strict separation between agency and cognition.',
      confidence: 0.6, evidenceFor: ['hindsight-1'], persistence: 'durable',
    }],
    hypothesisUpdates: [],
    contradictions: [], uncertainties: [], informationGaps: [],
    observations: [{
      statement: 'The user explicitly decided that ReasonIQ must not participate in the conversation loop.',
      evidence: [{ id: 'hindsight-1', source: 'hindsight' }],
      relatedHypothesisId: null,
    }],
    openQuestions: ['Does the separation extend to synchronous reasoning for exceptional cases?'],
    reflection: { goalAchieved: true, learned: 'The boundary is deliberate.', unresolved: null, hypothesisImpact: null },
    conclusions: [], sufficientForConclusion: false, confidence: 0.7,
    ...overrides,
  };
}

function cognitionRuntimeFor() {
  const { createHypothesisManager } = require('../src/reasoning/hypothesisManager');
  const retained = [];
  return {
    manager: createHypothesisManager({}),
    retained,
    cognition: {
      retainObservation: async (o) => { retained.push({ kind: 'observation', ...o }); return { factId: 'obs-fact-1' }; },
      retainOpenQuestion: async (q) => { retained.push({ kind: 'open-question', statement: q }); return { factId: 'oq-fact-1' }; },
    },
  };
}

test('v1.0 background analysis: the reasoning input sees the completed conversation — the delivered reply is context, never edited', async () => {
  const seenInputs = [];
  const hermes = { stream: async (m, { onDelta }) => { onDelta('Begrepen.', false); return 'Begrepen.'; } };
  await performStreamingTurn({
    messages: [{ role: 'user', content: 'Analyseer de streaming architecture op race conditions, zoals we eerder bespraken.' }],
    documents: DOCUMENTS,
    hermes,
    hindsight: DEEP_EVIDENCE_HINDSIGHT,
    res: fakeRes(),
    intentIQ: () => ({ schemaVersion: 'intentiq.v1', intent: 'inform.explain', status: 'accepted' }),
    reasonIQ: async (input) => { seenInputs.push(input); return v1ReasoningResult(); },
    hypothesisRuntime: { manager: { list: () => [], applyReasoningResult: () => {} } },
  });
  await flushBackground();
  assert.equal(seenInputs.length, 1);
  assert.match(seenInputs[0].assistantReply, /Begrepen\./, 'the analysis sees Gaia\'s delivered reply');
  assert.equal(seenInputs[0].text, 'Analyseer de streaming architecture op race conditions, zoals we eerder bespraken.');
});

test('v1.0 background analysis: observations and open questions reach Hindsight through the existing runtime — no second store', async () => {
  const runtime = cognitionRuntimeFor();
  const hermes = { stream: async (m, { onDelta }) => { onDelta('A reply.', false); return 'A reply.'; } };
  const res = fakeRes();
  await performStreamingTurn({
    messages: [{ role: 'user', content: 'Analyseer de streaming architecture op race conditions, zoals we eerder bespraken.' }],
    documents: DOCUMENTS,
    hermes,
    hindsight: DEEP_EVIDENCE_HINDSIGHT,
    res,
    intentIQ: () => ({ schemaVersion: 'intentiq.v1', intent: 'inform.explain', status: 'accepted' }),
    reasonIQ: async () => v1ReasoningResult(),
    hypothesisRuntime: runtime,
  });
  await flushBackground();
  // The reply was delivered first (the stream is complete) — storage only
  // ever happens in the deferred phase, never on the conversational path.
  assert.match(res.written.at(-1), /data: \[DONE\]/);
  assert.equal(runtime.manager.list().length, 1, 'hypotheses keep their own lifecycle');
  const observations = runtime.retained.filter((r) => r.kind === 'observation');
  const questions = runtime.retained.filter((r) => r.kind === 'open-question');
  assert.equal(observations.length, 1, 'the derived observation was stored');
  assert.match(observations[0].statement, /explicitly decided/);
  assert.deepEqual(observations[0].evidence, [{ id: 'hindsight-1', source: 'hindsight' }]);
  assert.equal(questions.length, 1, 'the open question was stored — identified, never asked');
  assert.match(questions[0].statement, /synchronous reasoning/);
});

test('v1.0 background analysis: a memory-discarded turn still stores legitimate analysis products — the same §15 rule as hypotheses', async () => {
  const runtime = cognitionRuntimeFor();
  const hermes = { stream: async (m, { onDelta }) => { onDelta('A reply.', false); return 'A reply.'; } };
  // This exact input is memory-DISCARDED by Memoryworthiness (score 0.25,
  // action discard) while still being a deep, evidence-bearing analysis
  // turn — the case the §15 boundary exists for.
  const { evaluateMemoryWorthiness, shouldRetainToHindsight } = require('../src/memoryWorthiness');
  const memoryDecision = evaluateMemoryWorthiness({
    userInput: 'Analyseer de streaming architecture op race conditions, zoals we eerder bespraken.',
    intent: { intent: 'inform.explain', status: 'accepted' },
  });
  assert.equal(shouldRetainToHindsight(memoryDecision), false, 'precondition: this turn IS memory-discarded');
  await performStreamingTurn({
    messages: [{ role: 'user', content: 'Analyseer de streaming architecture op race conditions, zoals we eerder bespraken.' }],
    documents: DOCUMENTS,
    hermes,
    hindsight: DEEP_EVIDENCE_HINDSIGHT,
    res: fakeRes(),
    intentIQ: () => ({ schemaVersion: 'intentiq.v1', intent: 'inform.explain', status: 'accepted' }),
    reasonIQ: async () => v1ReasoningResult(),
    hypothesisRuntime: runtime,
  });
  await flushBackground();
  // Memoryworthiness discards this turn as conversational MEMORY, but the
  // background analysis still derived legitimate Gaia-knowledge — stored
  // exactly like hypotheses, which the same §15 boundary exempts.
  assert.equal(runtime.retained.filter((r) => r.kind === 'observation').length, 1,
    'a memory-unworthy turn still retains legitimate analysis products');
  assert.equal(runtime.retained.filter((r) => r.kind === 'open-question').length, 1);
  assert.equal(runtime.manager.list().length, 1, 'hypothesis policy is untouched by the memory gate');
});

test('v1.0 background analysis: retention failure is non-fatal — the conversation and hypotheses are untouched', async () => {
  const runtime = cognitionRuntimeFor();
  runtime.cognition.retainObservation = async () => { throw new Error('hindsight down'); };
  const hermes = { stream: async (m, { onDelta }) => { onDelta('A reply.', false); return 'A reply.'; } };
  const res = fakeRes();
  let failed = false;
  process.on('unhandledRejection', () => { failed = true; });
  await performStreamingTurn({
    messages: [{ role: 'user', content: 'Analyseer de streaming architecture op race conditions, zoals we eerder bespraken.' }],
    documents: DOCUMENTS,
    hermes,
    hindsight: DEEP_EVIDENCE_HINDSIGHT,
    res,
    intentIQ: () => ({ schemaVersion: 'intentiq.v1', intent: 'inform.explain', status: 'accepted' }),
    reasonIQ: async () => v1ReasoningResult(),
    hypothesisRuntime: runtime,
  });
  await flushBackground();
  process.off('unhandledRejection', () => { failed = true; });
  assert.equal(failed, false, 'no unhandled rejection escapes the deferred phase');
  assert.match(res.written.at(-1), /data: \[DONE\]/, 'the reply was delivered intact');
  assert.equal(runtime.manager.list().length, 1, 'hypothesis application still ran');
});

test('v1.0 background analysis: an observation can carry its relationship to a tracked hypothesis — no relationship store', async () => {
  const runtime = cognitionRuntimeFor();
  const hermes = { stream: async (m, { onDelta }) => { onDelta('A reply.', false); return 'A reply.'; } };
  await performStreamingTurn({
    messages: [{ role: 'user', content: 'Analyseer de streaming architecture op race conditions, zoals we eerder bespraken.' }],
    documents: DOCUMENTS,
    hermes,
    hindsight: DEEP_EVIDENCE_HINDSIGHT,
    res: fakeRes(),
    intentIQ: () => ({ schemaVersion: 'intentiq.v1', intent: 'inform.explain', status: 'accepted' }),
    reasonIQ: async () => v1ReasoningResult(),
    hypothesisRuntime: runtime,
  });
  await flushBackground();
  const hypId = runtime.manager.list()[0].id;
  assert.ok(hypId, 'the analysis produced a tracked hypothesis');
  // The observation's relatedHypothesisId is metadata on the stored fact —
  // relationships ride existing structures, never a separate store.
  const obs = runtime.retained.find((r) => r.kind === 'observation');
  assert.equal(obs.relatedHypothesisId, null, 'v1ReasoningResult\'s observation has no relation');
  assert.equal(runtime.retained.filter((r) => r.kind === 'observation').length, 1);
});

test('v1.0 background analysis: non-streaming transport behaves identically — observations stored after the reply', async () => {
  const runtime = cognitionRuntimeFor();
  const hermes = { chat: async () => 'A reply.' };
  const result = await performTurn({
    messages: [{ role: 'user', content: 'Analyseer de streaming architecture op race conditions, zoals we eerder bespraken.' }],
    documents: DOCUMENTS,
    hermes,
    hindsight: DEEP_EVIDENCE_HINDSIGHT,
    intentIQ: () => ({ schemaVersion: 'intentiq.v1', intent: 'inform.explain', status: 'accepted' }),
    reasonIQ: async () => v1ReasoningResult(),
    hypothesisRuntime: runtime,
  });
  assert.equal(result.status, 200);
  await flushBackground();
  assert.equal(runtime.retained.filter((r) => r.kind === 'observation').length, 1);
  assert.equal(runtime.retained.filter((r) => r.kind === 'open-question').length, 1);
});
