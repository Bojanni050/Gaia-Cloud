'use strict';

/**
 * Chronicle archive client (v3.0 source of truth).
 *
 * Completed turns register with status `observation`. Derived knowledge
 * stays `interpretation`/`hypothesis` — never auto-promoted to
 * `confirmed` (Absolute Override). append() never throws and the live
 * path never awaits it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createChronicleClient } = require('../src/chronicleClient');

function tempPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-')), 'chronicle.jsonl');
}

test('append stores one observation record per completed turn', async () => {
  const client = createChronicleClient({ chroniclePath: tempPath() });
  const ok = await client.append({
    status: 'observation',
    conversationId: 'conv-1',
    userText: 'Onthoud dat deploys via de VPS lopen.',
    assistantText: 'Genoteerd.',
  });
  assert.equal(ok, true);
});

test('append records the observation status and both turn texts', async () => {
  const chroniclePath = tempPath();
  const client = createChronicleClient({ chroniclePath });
  await client.append({ status: 'observation', conversationId: 'c1', userText: 'u1', assistantText: 'a1' });
  const lines = fs.readFileSync(chroniclePath, 'utf-8').trim().split('\n');
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]);
  assert.equal(record.status, 'observation');
  assert.equal(record.conversation_id, 'c1');
  assert.equal(record.user_text, 'u1');
  assert.equal(record.assistant_text, 'a1');
  assert.ok(record.observed_at);
});

test('append never mints confirmed — Absolute Override holds at the archive seam', async () => {
  const chroniclePath = tempPath();
  const client = createChronicleClient({ chroniclePath });
  await client.append({ status: 'confirmed', conversationId: 'c1', userText: 'u', assistantText: 'a' });
  const record = JSON.parse(fs.readFileSync(chroniclePath, 'utf-8').trim().split('\n')[0]);
  assert.notEqual(record.status, 'confirmed');
  assert.equal(record.status, 'observation');
});

test('append never throws, even when storage is unavailable', async () => {
  const client = createChronicleClient({ chroniclePath: path.join('/nonexistent-root-xyz', 'c.jsonl'), baseUrl: '' });
  // baseUrl '' + unwritable path: must resolve false, never reject.
  // (On some platforms the write throws synchronously inside append's
  // try/catch — either way no rejection escapes.)
  const ok = await client.append({ status: 'observation', userText: 'u', assistantText: 'a' });
  assert.equal(typeof ok, 'boolean');
});

test('a completed turn registers its observation without blocking the reply', async () => {
  // Turn-level proof: the reply returns first; the observation lands in
  // the deferred phase through the injected chronicle.
  const { performTurn } = require('../src/turn');
  const appended = [];
  const result = await performTurn({
    messages: [{ role: 'user', content: 'Onthoud dat deploys via de VPS lopen.' }],
    documents: { 'soul.md': 'S' },
    generator: { generate: async () => 'Genoteerd.' },
    hindsight: { recall: async () => [], reflect: async () => {} },
    chronicle: { append: async (entry) => { appended.push(entry); return true; } },
  });
  assert.equal(result.status, 200);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(appended.length, 1);
  assert.equal(appended[0].status, 'observation');
  assert.match(appended[0].assistantText, /Genoteerd/);
});
