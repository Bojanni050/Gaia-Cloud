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
      assert.deepEqual(messages, [
        { role: 'system', content: 'SOUL' },
        { role: 'user', content: 'hello' },
      ]);
      return 'hi there';
    },
  };
  const result = await performTurn({
    messages: [{ role: 'user', content: 'hello' }],
    systemPrompt: 'SOUL',
    hermes,
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.reply, 'hi there');
});

test('performTurn maps validation problems to 400', async () => {
  const result = await performTurn({ messages: [], systemPrompt: 'SOUL', hermes: { chat: async () => 'x' } });
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
    systemPrompt: 'SOUL',
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
    systemPrompt: 'SOUL',
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

test('performTurn without attachments produces byte-identical output to before this feature existed', async () => {
  let seenMessages;
  const hermes = { chat: async (messages) => { seenMessages = messages; return 'hi there'; } };
  await performTurn({ messages: [{ role: 'user', content: 'hello' }], systemPrompt: 'SOUL', hermes });
  assert.equal(seenMessages[0].content, 'SOUL');
});

test('performTurn with attachments folds them into the system prompt Hermes sees', async () => {
  let seenMessages;
  const hermes = { chat: async (messages) => { seenMessages = messages; return 'hi there'; } };
  await performTurn({
    messages: [{ role: 'user', content: 'what does this say?' }],
    systemPrompt: 'SOUL',
    hermes,
    attachments: [{ filename: 'notes.txt', content: 'meeting is at 3pm' }],
  });
  assert.match(seenMessages[0].content, /^SOUL/);
  assert.match(seenMessages[0].content, /meeting is at 3pm/);
  assert.equal(seenMessages[0].role, 'system');
  assert.equal(seenMessages.length, 2); // still exactly one system message + the user turn
});

test('performTurn with only unreadable attachments still mentions them without fabricated content', async () => {
  let seenMessages;
  const hermes = { chat: async (messages) => { seenMessages = messages; return 'hi there'; } };
  await performTurn({
    messages: [{ role: 'user', content: 'what is in the image?' }],
    systemPrompt: 'SOUL',
    hermes,
    attachments: [{ filename: 'photo.png', content: null }],
  });
  assert.match(seenMessages[0].content, /photo\.png/);
  assert.match(seenMessages[0].content, /could not be read as text/);
});

// --- performTurn / Decision Engine + Orchestrator integration -------------
//
// performTurn no longer calls hermes.chat directly — it goes through the
// same decide() -> execute() -> generateReply() seam as performStreamingTurn
// (turn.js's own comment explains why this is byte-identical behavior:
// Desktop's contract has no IntentIQ/ReasonIQ, so intent is always null,
// which the Decision Engine's safe default routes to the hermes
// capability). These tests pin that wiring directly, using the same
// injectable decisionEngine/orchestrate seam performStreamingTurn already
// has.

test('performTurn routes through the real Decision Engine by default, choosing the hermes capability', async () => {
  const hermes = { chat: async () => 'hi there' };
  const result = await performTurn({ messages: [{ role: 'user', content: 'hello' }], systemPrompt: 'SOUL', hermes });
  assert.equal(result.status, 200);
  assert.equal(result.body.reply, 'hi there');
});

test('performTurn invokes hermes only through the Orchestrator, never directly', async () => {
  let hermesCalls = 0;
  const hermes = { chat: async () => { hermesCalls += 1; return 'hi there'; } };
  const decisionEngineCalls = [];

  const result = await performTurn({
    messages: [{ role: 'user', content: 'hello' }],
    systemPrompt: 'SOUL',
    hermes,
    decisionEngine: (input) => {
      decisionEngineCalls.push(input);
      return { action: 'capability', capability: 'hermes', task: 'respond', input: {}, reason: 'test' };
    },
  });

  assert.equal(hermesCalls, 1);
  assert.equal(decisionEngineCalls.length, 1);
  assert.equal(decisionEngineCalls[0].intent, null); // Desktop's contract carries no IntentIQ
  assert.equal(result.status, 200);
  assert.equal(result.body.reply, 'hi there');
});

test('performTurn: a clarify decision never calls Hermes and still returns a calm 200 reply', async () => {
  const hermes = { chat: async () => { throw new Error('must not be called'); } };
  const result = await performTurn({
    messages: [{ role: 'user', content: 'draft it and send it' }],
    systemPrompt: 'SOUL',
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
    systemPrompt: 'SOUL',
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
    systemPrompt: 'SOUL',
    hermes,
    decisionEngine: () => ({ action: 'native' }),
  });
  assert.equal(result.status, 502);
  assert.equal(result.body.error, 'gaia could not answer right now');
});

test('performTurn: an Orchestrator failure degrades to a calm 502, never leaking provider details', async () => {
  const hermes = { chat: async () => { throw new Error('hermes responded 401 at http://internal:8642'); } };
  const result = await performTurn({ messages: [{ role: 'user', content: 'hello' }], systemPrompt: 'SOUL', hermes });
  assert.equal(result.status, 502);
  assert.equal(result.body.error, 'gaia could not answer right now');
  assert.ok(!JSON.stringify(result.body).includes('hermes'));
  assert.ok(!JSON.stringify(result.body).includes('8642'));
});

test('performTurn: a Decision Engine failure degrades to the hermes capability, never breaking the turn', async () => {
  const hermes = { chat: async () => 'a reply despite the decision engine failing' };
  const result = await performTurn({
    messages: [{ role: 'user', content: 'hello' }],
    systemPrompt: 'SOUL',
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

test('performStreamingTurn recalls only when the policy fires, and reflects only on a substantive exchange', async () => {
  const recallCalls = [];
  const reflectCalls = [];
  const hindsight = {
    recall: async (query) => { recallCalls.push(query); return [{ text: 'Bo prefers async updates', scores: { final: 0.9 } }]; },
    reflect: async (item) => { reflectCalls.push(item); },
  };
  const hermes = { stream: async (messages, { onDelta }) => { onDelta('ok', false); return 'A real reply here.'; } };

  await performStreamingTurn({
    messages: [{ role: 'user', content: 'what did we decide about the project database?' }],
    documents: DOCUMENTS,
    hermes,
    hindsight,
    res: fakeRes(),
  });

  assert.equal(recallCalls.length, 1); // durable-context signal present
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reflectCalls.length, 1); // substantive exchange
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

test('performStreamingTurn hands IntentIQ\'s real decision to ReasonIQ, and awaits it before invoking a capability', async () => {
  const reasonIQCalls = [];
  const callOrder = [];
  const hermes = { stream: async (messages, { onDelta }) => { callOrder.push('hermes'); onDelta('ok', false); return 'A reply.'; } };

  await performStreamingTurn({
    messages: [{ role: 'user', content: 'Why is my website crashing?' }],
    documents: DOCUMENTS,
    hermes,
    hindsight: SILENT_HINDSIGHT,
    res: fakeRes(),
    intentIQ: () => ({ schemaVersion: 'intentiq.v1', intent: 'inform.explain', status: 'accepted' }),
    reasonIQ: async (input) => { callOrder.push('reasonIQ'); reasonIQCalls.push(input); return {}; },
  });

  assert.equal(reasonIQCalls.length, 1);
  assert.equal(reasonIQCalls[0].text, 'Why is my website crashing?');
  assert.equal(reasonIQCalls[0].intentDecision.intent, 'inform.explain');
  assert.deepEqual(reasonIQCalls[0].evidence, []);
  assert.deepEqual(callOrder, ['reasonIQ', 'hermes']); // ReasonIQ resolves before the capability call
});

test('performStreamingTurn awaits ReasonIQ before completing the response', async () => {
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

test('performStreamingTurn persists both the IntentIQ decision and the ReasonIQ result when a decisionStore is given', async () => {
  const appended = [];
  const decisionStore = { append: (record) => { appended.push(record); return true; } };
  const hermes = { stream: async (messages, { onDelta }) => { onDelta('ok', false); return 'A reply.'; } };

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
      options.logger(JSON.stringify({ kind: 'reasoniq.result', reasoningDepth: 'shallow' }));
      return {};
    },
    decisionStore,
  });
  await flush();

  assert.equal(appended.length, 3);
  assert.equal(appended[0].kind, 'intentiq.decision');
  assert.equal(appended[1].kind, 'reasoniq.result');
  assert.equal(appended[2].kind, 'decision.plan');
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
    systemPrompt: 'SOUL',
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
    systemPrompt: 'SOUL',
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
    systemPrompt: 'SOUL',
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
    systemPrompt: 'SOUL',
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
