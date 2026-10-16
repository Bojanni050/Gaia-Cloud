'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { identityHeadersFor, isOpenCodeHost, USER_AGENT } = require('../src/providerHeaders');
const { createGaiaGenerator } = require('../src/generation/gaiaGenerator');
const { generateWithFailover, streamWithFailover } = require('../src/generation/generationFailover');
const { performTurn } = require('../src/turn');

const okChat = { ok: true, json: async () => ({ choices: [{ message: { content: 'hoi' } }] }) };

test('only opencode.ai hosts get an own User-Agent and the conversation as session', () => {
  assert.equal(isOpenCodeHost('https://opencode.ai/zen/go/v1'), true);
  assert.equal(isOpenCodeHost('https://api.opencode.ai/v1'), true);
  assert.equal(isOpenCodeHost('https://evil-opencode.ai.example.com/v1'), false);
  assert.equal(isOpenCodeHost('https://openrouter.ai/api/v1'), false);
  assert.equal(isOpenCodeHost('not a url'), false);

  assert.deepEqual(identityHeadersFor('https://opencode.ai/zen/go/v1', { sessionId: 'conv-1' }), {
    'User-Agent': USER_AGENT,
    'x-opencode-session': 'conv-1',
  });
  assert.deepEqual(identityHeadersFor('https://opencode.ai/zen/go/v1'), { 'User-Agent': USER_AGENT });
  assert.match(USER_AGENT, /^gaia-api\/\d/);
  // Never leaked to a provider that did not ask for it.
  assert.deepEqual(identityHeadersFor('https://openrouter.ai/api/v1', { sessionId: 'conv-1' }), {});
});

test('the generator sends the session header to OpenCode only, on generate and stream', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push({ url, headers: init.headers }); return okChat; };

  const openCode = createGaiaGenerator({ baseUrl: 'https://opencode.ai/zen/go/v1', model: 'glm-5.3-flash', authToken: 'k', fetchImpl });
  await openCode.generate([{ role: 'user', content: 'x' }], { sessionId: 'conv-42' });
  assert.equal(seen[0].headers['x-opencode-session'], 'conv-42');
  assert.equal(seen[0].headers['User-Agent'], USER_AGENT);
  assert.equal(seen[0].headers.Authorization, 'Bearer k');

  const other = createGaiaGenerator({ baseUrl: 'https://openrouter.ai/api/v1', model: 'm', authToken: 'k', fetchImpl });
  await other.generate([{ role: 'user', content: 'x' }], { sessionId: 'conv-42' });
  assert.equal('x-opencode-session' in seen[1].headers, false);
  assert.equal('User-Agent' in seen[1].headers, false);

  await openCode.generate([{ role: 'user', content: 'x' }]);
  assert.equal('x-opencode-session' in seen[2].headers, false); // no conversation, no header
});

test('the failover helpers hand the session id to the generators', async () => {
  const calls = [];
  const generator = {
    async generate(_m, opts) { calls.push(['generate', opts]); return 'a'; },
    async stream(_m, opts) { calls.push(['stream', opts.sessionId]); return 'b'; },
  };
  await generateWithFailover([], { primary: generator, sessionId: 's1' });
  await streamWithFailover([], { primary: generator, sessionId: 's1' });
  assert.deepEqual(calls[0], ['generate', { sessionId: 's1' }]);
  assert.deepEqual(calls[1], ['stream', 's1']);
});

test('a turn uses its conversation id as the stable session id', async () => {
  const seen = [];
  const generator = { async generate(_m, opts) { seen.push(opts); return 'Hallo.'; } };
  await performTurn({
    messages: [{ role: 'user', content: 'Hoi' }],
    documents: { 'soul.md': 'SOUL' },
    generator,
    conversationId: 'conv-stable-1',
  });
  assert.deepEqual(seen[0], { sessionId: 'conv-stable-1' });
});
