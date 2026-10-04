'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { performTurn } = require('../src/turn');

const documents = { 'soul.md': 'S', 'principles.md': 'P', 'lexicon.md': 'L' };

function foundationSpy() {
  const searches = [];
  const submits = [];
  const client = {
    limit: 6,
    searchResults: async (q) => {
      searches.push(q);
      return [{ kind: 'fact', text: 'iets dat vastligt over de planning' }];
    },
    submitObservation: async (entry) => {
      submits.push(entry);
      return true;
    },
  };
  return { client, searches, submits };
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

test('an archive-shaped ask queries Foundation and injects status-labelled context', async () => {
  const spy = foundationSpy();
  const { generator, captured } = capturingGenerator();

  const result = await performTurn({
    messages: [{ role: 'user', content: 'wat staat er in foundation over mijn planning?' }],
    documents,
    foundation: spy.client,
    generator,
  });

  assert.equal(result.status, 200);
  assert.equal(spy.searches.length, 1, 'the recordedKnowledge signal opens exactly one Foundation read');
  assert.ok(
    captured.messages.some((m) => m.role === 'system' && /\[bevestigd feit\] iets dat vastligt/.test(m.content)),
    'the labelled Foundation block reaches the assembled prompt',
  );
});

test('a plain turn never touches Foundation', async () => {
  const spy = foundationSpy();
  const { generator } = capturingGenerator();

  await performTurn({
    messages: [{ role: 'user', content: 'hoi, hoe gaat het vandaag?' }],
    documents,
    foundation: spy.client,
    generator,
  });

  assert.equal(spy.searches.length, 0, 'no archive signal, no Foundation read');
});
