'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTokens, createAuthMiddleware, createOperatorAuth } = require('../src/auth');

function fakeReq(token) {
  return { headers: token ? { authorization: `Bearer ${token}` } : {} };
}

test('parseTokens splits, trims and drops empties', () => {
  const tokens = parseTokens(' a , b , ,  ');
  assert.deepEqual([...tokens], ['a', 'b']);
  assert.equal(parseTokens(undefined).size, 0);
});

test('auth fails closed when no tokens are configured', () => {
  const auth = createAuthMiddleware(parseTokens(''));
  const res = { statusCode: 0, body: null, status(code) { this.statusCode = code; return this; }, json(b) { this.body = b; } };
  auth(fakeReq('anything'), res, () => assert.fail('must not pass'));
  assert.equal(res.statusCode, 503);
});

test('auth rejects missing, malformed and wrong tokens with 401', () => {
  const auth = createAuthMiddleware(parseTokens('right'));
  for (const req of [fakeReq(null), fakeReq('wrong'), { headers: { authorization: 'Basic x' } }]) {
    const res = { statusCode: 0, status(code) { this.statusCode = code; return this; }, json() {} };
    auth(req, res, () => assert.fail('must not pass'));
    assert.equal(res.statusCode, 401);
  }
});

test('auth accepts a configured token', () => {
  const auth = createAuthMiddleware(parseTokens('a, b'));
  let passed = false;
  auth(fakeReq('b'), { status() { return this; }, json() { assert.fail('must not respond'); } }, () => {
    passed = true;
  });
  assert.ok(passed);
});

test('auth rejects a prefix, an extension and a different-case version of a valid token', () => {
  const auth = createAuthMiddleware(parseTokens('Secret-Token-123'));
  for (const wrong of ['Secret-Token-12', 'Secret-Token-1234', 'secret-token-123', 'S']) {
    const res = { statusCode: 0, status(code) { this.statusCode = code; return this; }, json() {} };
    auth(fakeReq(wrong), res, () => assert.fail(`must not pass: ${wrong}`));
    assert.equal(res.statusCode, 401, wrong);
  }
});

test('auth accepts the first, a middle and the last of several tokens, and a token with unusual characters', () => {
  const auth = createAuthMiddleware(parseTokens('one, två, drie-ñ-€'));
  for (const token of ['one', 'två', 'drie-ñ-€']) {
    let passed = false;
    auth(fakeReq(token), { status() { return this; }, json() { assert.fail('must not respond'); } }, () => { passed = true; });
    assert.ok(passed, token);
  }
});

// --- the operator surface's own token (docs/advice.md C3) --------------------

function fakeRes() {
  return { statusCode: 0, body: null, status(code) { this.statusCode = code; return this; }, json(b) { this.body = b; } };
}

test('the operator token is its own list, and a client token does not pass it', () => {
  const operator = createOperatorAuth('operator-secret', { logger: { warn() {} } });

  const denied = fakeRes();
  operator(fakeReq('client-token'), denied, () => assert.fail('a client token must not pass'));
  assert.equal(denied.statusCode, 401);

  let passed = false;
  operator(fakeReq('operator-secret'), fakeRes(), () => { passed = true; });
  assert.ok(passed);
});

test('the operator token is comma-separated like the client one', () => {
  const operator = createOperatorAuth('one, two', { logger: { warn() {} } });
  for (const token of ['one', 'two']) {
    let passed = false;
    operator(fakeReq(token), fakeRes(), () => { passed = true; });
    assert.ok(passed, token);
  }
});

test('an unset operator token answers 503 and names the variable, once on the log', () => {
  const warnings = [];
  const operator = createOperatorAuth('', { logger: { warn: (line) => warnings.push(line) } });

  const res = fakeRes();
  operator(fakeReq('anything'), res, () => assert.fail('must not pass'));
  assert.equal(res.statusCode, 503);
  assert.match(res.body.error, /no admin token configured/);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /GAIA_ADMIN_TOKEN is unset/);

  // The line is a "somebody actually needs admin" signal, not a per-request one.
  operator(fakeReq('anything'), fakeRes(), () => {});
  assert.equal(warnings.length, 1, 'the warning fires once, not on every request');
});
