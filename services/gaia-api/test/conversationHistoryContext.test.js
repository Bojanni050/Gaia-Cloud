'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { performTurn } = require('../src/turn');

const documents = { 'soul.md': 'S', 'principles.md': 'P', 'lexicon.md': 'L' };

function searchSpy() {
  const calls = [];
  const client = {
    search: async (query, options) => {
      calls.push({ query, options });
      return [{
        conversationId: 'old-1',
        title: 'VPS en Tailscale',
        updatedAt: '2026-10-01T10:00:00Z',
        role: 'user',
        snippet: 'we zetten de vps om naar tailscale',
        score: 1,
        matchedTerms: ['vps', 'tailscale'],
      }];
    },
  };
  return { client, calls };
}

function capturingGenerator() {
  const captured = { messages: null };
  const generator = {
    generate: async (messages) => {
      captured.messages = messages;
      return 'antwoord';
    },
  };
  return { generator, captured };
}

test('a past-conversation lookup searches the saved transcripts and injects the literal fragments', async () => {
  const spy = searchSpy();
  const { generator, captured } = capturingGenerator();

  const result = await performTurn({
    messages: [{ role: 'user', content: 'wat zei ik vorige week over de vps?' }],
    documents,
    conversationId: 'current-1',
    conversationSearch: spy.client,
    generator,
  });

  assert.equal(result.status, 200);
  assert.equal(spy.calls.length, 1, 'the exactHistory signal opens exactly one transcript search');
  assert.equal(spy.calls[0].options.excludeConversationId, 'current-1', 'the in-flight conversation is never searched');
  assert.ok(
    captured.messages.some((m) => m.role === 'system' && /we zetten de vps om naar tailscale/.test(m.content)),
    'the literal-fragment block reaches the assembled prompt',
  );
  assert.ok(
    captured.messages.some((m) => m.role === 'system' && /conversation_search/.test(m.content)),
    'she is aware she can search past conversations this turn',
  );
});

test('a plain turn never searches the transcripts', async () => {
  const spy = searchSpy();
  const { generator } = capturingGenerator();

  await performTurn({
    messages: [{ role: 'user', content: 'hoi, hoe gaat het vandaag?' }],
    documents,
    conversationId: 'current-1',
    conversationSearch: spy.client,
    generator,
  });

  assert.equal(spy.calls.length, 0, 'no lookup signal, no transcript search');
});

test('a past-facing lookup consults Hindsight as well, even without a lexical memory cue', async () => {
  const spy = searchSpy();
  const recalls = [];
  const hindsight = {
    recall: async (q) => { recalls.push(q); return []; },
    reflect: async () => {},
  };
  const { generator } = capturingGenerator();

  // "wat zei ik over de vps" opens the transcript read (exactHistory) but
  // carries none of memoryPolicy's own past-reference cues — so the transcript
  // and Hindsight must be tied together on the turns where "the past" is the
  // question, or a lookup would reach only one of the two.
  await performTurn({
    messages: [{ role: 'user', content: 'wat zei ik over de vps?' }],
    documents,
    conversationId: 'current-1',
    conversationSearch: spy.client,
    hindsight,
    generator,
  });

  assert.equal(spy.calls.length, 1, 'the transcript is searched');
  assert.equal(recalls.length, 1, 'and Hindsight is consulted too');
});

test('a plain turn leaves Hindsight closed', async () => {
  const recalls = [];
  const hindsight = { recall: async (q) => { recalls.push(q); return []; }, reflect: async () => {} };
  const { generator } = capturingGenerator();

  await performTurn({
    messages: [{ role: 'user', content: 'hoi, hoe gaat het vandaag?' }],
    documents,
    conversationId: 'current-1',
    hindsight,
    generator,
  });

  assert.equal(recalls.length, 0);
});
