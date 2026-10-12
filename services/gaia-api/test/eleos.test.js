'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createEleosPass, buildEleosPrompt, parseEleosDecision, clampDelay } = require('../src/reasoning/eleos');
const { createEleosIntentStore } = require('../src/eleosIntentStore');

function tempStore(now) {
  return createEleosIntentStore({
    intentsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-eleos-pass-')),
    ...(now ? { now } : {}),
  });
}

function fakeModel(reply) {
  const calls = [];
  return {
    calls,
    isConfigured: () => true,
    async chat(messages, options) { calls.push({ messages, options }); if (reply instanceof Error) throw reply; return reply; },
  };
}

const convo = [
  { role: 'user', content: 'ik voel me echt rot, slechte week gehad' },
  { role: 'assistant', content: 'wat naar, Bo. wil je erover praten?' },
];

test('the gate stops ordinary turns before any model call', async () => {
  const model = fakeModel('{}');
  const store = tempStore();
  const pass = createEleosPass({ model, store });
  const out = await pass.noteTurn({ conversationId: 'c1', messages: [{ role: 'user', content: 'wat is 2+2?' }] });
  assert.equal(out.skipped, 'no-signal');
  assert.equal(model.calls.length, 0);
  assert.equal(store.listPending().length, 0);
});

test('a gated moment becomes a pending loop with a clamped delay', async () => {
  const model = fakeModel(JSON.stringify({ followUp: true, summary: 'Bo had een slechte week', kind: 'sadness', delayHours: 48, groundingQuote: 'ik voel me echt rot' }));
  const store = tempStore(() => new Date('2026-10-05T10:00:00Z'));
  const pass = createEleosPass({ model, store, now: () => new Date('2026-10-05T10:00:00Z'), delayMinMs: 20 * 3600e3, delayMaxMs: 28 * 3600e3 });
  const out = await pass.noteTurn({ conversationId: 'c1', messages: convo });
  assert.ok(out.created);
  const loop = store.get(out.created);
  assert.equal(loop.kind, 'sadness');
  assert.equal(loop.groundingQuote, 'ik voel me echt rot');
  // 48h clamped to the 28h max.
  assert.equal(loop.dueAt, '2026-10-06T14:00:00.000Z');
  assert.equal(model.calls.length, 1);
});

test('a turn with no loop creates nothing', async () => {
  const store = tempStore();
  const pass = createEleosPass({ model: fakeModel('{"followUp":false,"resolved":false}'), store });
  const out = await pass.noteTurn({ conversationId: 'c1', messages: convo });
  assert.equal(out.skipped, 'no-followup');
  assert.equal(store.listPending().length, 0);
});

test('a new moment in the same conversation updates the existing loop, not a second one', async () => {
  const store = tempStore();
  const existing = store.create({ conversationId: 'c1', summary: 'oud', kind: 'worry', dueAt: '2026-10-05T00:00:00Z' });
  const model = fakeModel('{"followUp":true,"summary":"nieuw","kind":"worry","delayHours":24,"groundingQuote":"q"}');
  const pass = createEleosPass({ model, store });
  const out = await pass.noteTurn({ conversationId: 'c1', messages: convo });
  assert.equal(out.updated, existing.id);
  assert.equal(store.list().length, 1);
  assert.equal(store.get(existing.id).summary, 'nieuw');
});

test('the model can let a resolved loop go', async () => {
  const store = tempStore();
  const existing = store.create({ conversationId: 'c1', summary: 'was verdrietig', kind: 'sadness', dueAt: '2026-10-05T00:00:00Z' });
  const model = fakeModel('{"followUp":false,"resolved":true}');
  const pass = createEleosPass({ model, store });
  const out = await pass.noteTurn({ conversationId: 'c1', messages: convo });
  assert.equal(out.cancelled, existing.id);
  assert.equal(store.get(existing.id).status, 'cancelled');
});

test('never throws on a failed or missing model, or a missing conversation', async () => {
  const store = tempStore();
  assert.equal((await createEleosPass({ model: fakeModel(new Error('boom')), store }).noteTurn({ conversationId: 'c1', messages: convo })).skipped, 'model-failed');
  assert.equal((await createEleosPass({ model: { isConfigured: () => false, chat: async () => '{}' }, store }).noteTurn({ conversationId: 'c1', messages: convo })).skipped, 'model-unconfigured');
  assert.equal((await createEleosPass({ model: fakeModel('{}'), store }).noteTurn({ messages: convo })).skipped, 'no-conversation');
  assert.equal((await createEleosPass({ model: fakeModel('{}'), store }).noteTurn({ conversationId: 'c1', messages: [] })).skipped, 'no-conversation');
});

test('a lazily-resolved model is used (getModel)', async () => {
  const store = tempStore();
  const model = fakeModel('{"followUp":true,"summary":"s","kind":"event","delayHours":24,"groundingQuote":"q"}');
  let resolved = 0;
  const pass = createEleosPass({ getModel: () => { resolved += 1; return model; }, store });
  const out = await pass.noteTurn({ conversationId: 'c1', messages: convo });
  assert.ok(out.created);
  assert.ok(resolved > 0);
});

test('parseEleosDecision tolerates prose, clamps fields and defaults kinds', () => {
  const d = parseEleosDecision('Sure:\n{"followUp":true,"summary":"x","kind":"nonsense","delayHours":"24","groundingQuote":"q"}\nDone');
  assert.equal(d.followUp, true);
  assert.equal(d.kind, 'other');
  assert.equal(d.delayHours, 24);
  assert.equal(parseEleosDecision('not json'), null);
  assert.equal(parseEleosDecision('{"followUp":true,"summary":"x"}').groundingQuote, '');
});

test('clampDelay bounds the proposed delay', () => {
  assert.equal(clampDelay(48, { minMs: 20 * 3600e3, maxMs: 28 * 3600e3 }), 28 * 3600e3);
  assert.equal(clampDelay(1, { minMs: 20 * 3600e3, maxMs: 28 * 3600e3 }), 20 * 3600e3);
});

test('buildEleosPrompt grounds the model in the words and any existing loop', () => {
  const msgs = buildEleosPrompt({ messages: convo, existing: { summary: 'eerder' } });
  assert.equal(msgs[0].role, 'system');
  assert.match(msgs[1].content, /ik voel me echt rot/);
  assert.match(msgs[1].content, /eerder/);
});
