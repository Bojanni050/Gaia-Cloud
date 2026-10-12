'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createEleosVoice, buildOpeningMessages } = require('../src/eleosVoice');

const documents = {
  'soul.md': 'SOUL-CONTENT',
  'principles.md': 'PRINCIPLES-CONTENT',
  'lexicon.md': 'LEXICON-CONTENT',
};

const loop = { summary: 'Bo had een zware week', groundingQuote: 'ik voel me rot' };

test('the opening prompt carries the constitution and the grounded moment', () => {
  const msgs = buildOpeningMessages({ documents, loop, recentMessages: [{ role: 'user', content: 'oude boodschap' }] });
  assert.equal(msgs[0].role, 'system');
  assert.match(msgs[0].content, /SOUL-CONTENT/);
  assert.match(msgs[1].content, /Bo had een zware week/);
  assert.match(msgs[1].content, /"ik voel me rot"/);
  assert.match(msgs[1].content, /oude boodschap/);
});

test('the voice returns the generated opening, trimmed', async () => {
  const voice = createEleosVoice({ documents, generate: async () => '  Hoi Bo, hoe gaat het nu?  ' });
  assert.equal(await voice.open({ loop }), 'Hoi Bo, hoe gaat het nu?');
});

test('the voice is silent without a generator, a moment, or a successful call', async () => {
  assert.equal(await createEleosVoice({ documents }).open({ loop }), '');
  assert.equal(await createEleosVoice({ documents, generate: async () => 'x' }).open({ loop: null }), '');
  assert.equal(await createEleosVoice({ documents, generate: async () => { throw new Error('boom'); } }).open({ loop }), '');
  assert.equal(await createEleosVoice({ documents, generate: async () => '' }).open({ loop }), '');
});
