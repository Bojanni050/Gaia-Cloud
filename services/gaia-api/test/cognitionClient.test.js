'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { readCognitionConfig, createCognitionClient, createFromEnv } = require('../src/cognitionClient');

function fakeFetch() {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  return { calls, fetchImpl };
}

test('defaults: bank gaia, Tailscale cognition URL', () => {
  const config = readCognitionConfig({});
  assert.equal(config.bankId, 'gaia');
  assert.match(config.baseUrl, /:8890$/);
});

test('listHypotheses scopes to the bank and forwards status/kind filters', async () => {
  const { calls, fetchImpl } = fakeFetch();
  const client = createCognitionClient({ baseUrl: 'http://c:8890', bankId: 'gaia', fetchImpl });

  await client.listHypotheses({ status: 'testing', kind: 'mental_model' });

  assert.equal(calls[0].init.method, 'GET');
  assert.match(calls[0].url, /\/v1\/banks\/gaia\/hypotheses\?/);
  assert.ok(calls[0].url.includes('status=testing'));
  assert.ok(calls[0].url.includes('kind=mental_model'));
});

test('proposeHypothesis POSTs the record', async () => {
  const { calls, fetchImpl } = fakeFetch();
  const client = createCognitionClient({ baseUrl: 'http://c:8890', fetchImpl });

  await client.proposeHypothesis({ statement: 'x', kind: 'hypothesis', sources: ['chronicle:1'] });

  assert.equal(calls[0].init.method, 'POST');
  assert.match(calls[0].url, /\/hypotheses$/);
  assert.deepEqual(calls[0].body.sources, ['chronicle:1']);
});

test('lifecycle verbs hit their routes (corroborate, confirm, reject, supersede)', async () => {
  const { calls, fetchImpl } = fakeFetch();
  const client = createCognitionClient({ baseUrl: 'http://c:8890', fetchImpl });

  await client.markCorroborated('h1');
  await client.confirmHypothesis('h1');
  await client.rejectHypothesis('h1', { reason: 'no', verwerpBron: 'mens' });
  await client.supersedeHypothesis('h1', { supersededById: 'h2', reason: 'newer' });

  assert.match(calls[0].url, /\/hypotheses\/h1\/corroborate$/);
  assert.match(calls[1].url, /\/hypotheses\/h1\/confirm$/);
  assert.match(calls[2].url, /\/hypotheses\/h1\/reject$/);
  assert.equal(calls[2].body.verwerp_bron, 'mens');
  assert.match(calls[3].url, /\/hypotheses\/h1\/supersede$/);
  assert.equal(calls[3].body.superseded_by_id, 'h2');
});

test('an unreachable Cognition throws a calm error without host leakage', async () => {
  const client = createCognitionClient({
    baseUrl: 'http://c:8890',
    fetchImpl: async () => { throw new Error('ECONNREFUSED http://c:8890'); },
  });
  await assert.rejects(
    () => client.listHypotheses(),
    (err) => /cognition .* unreachable/.test(err.message) && !/c:8890/.test(err.message),
  );
});

test('createFromEnv always returns a client (Tailscale default)', () => {
  const client = createFromEnv({});
  assert.equal(typeof client.listHypotheses, 'function');
});
