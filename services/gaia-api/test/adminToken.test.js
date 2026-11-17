'use strict';

// C3: `/admin` has its own token. The proof that matters is end-to-end through
// createApp, because the split lives in the wiring rather than in the
// middleware: a client token must get 401 on every operator route, the operator
// token must get 200 there, and a container without GAIA_ADMIN_TOKEN must say
// so instead of quietly treating the token every client holds as operator
// access.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createApp } = require('../src/server');

const CLIENT_TOKEN = 'client-token';
const OPERATOR_TOKEN = 'operator-token';
const bearer = (token) => ({ Authorization: `Bearer ${token}` });

function startServer(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-token-'));
  const artifactPath = path.join(dir, 'foundation-artifact.json');
  fs.writeFileSync(artifactPath, JSON.stringify({
    documents: { 'soul.md': 'SOUL', 'principles.md': 'PRINCIPLES', 'lexicon.md': 'LEXICON' },
  }));

  const app = createApp({
    HERMES_BASE_URL: 'http://fake-hermes.internal/v1',
    HERMES_MODEL: 'hermes-agent',
    FOUNDATION_ARTIFACT_PATH: artifactPath,
    LOGOS_DECISIONS_PATH: path.join(dir, 'logos-decisions'),
    ...env,
  });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  return { url: (p) => `${base}${p}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('a client token does not open /admin, and the operator token does not open the client surface', async () => {
  const ctx = startServer({ GAIA_API_TOKEN: CLIENT_TOKEN, GAIA_ADMIN_TOKEN: OPERATOR_TOKEN });
  try {
    const withClient = await fetch(ctx.url('/admin/api/scans'), { headers: bearer(CLIENT_TOKEN) });
    assert.equal(withClient.status, 401, 'the token every client holds must not open the operator surface');

    const withOperator = await fetch(ctx.url('/admin/api/scans'), { headers: bearer(OPERATOR_TOKEN) });
    assert.equal(withOperator.status, 200);
    const { passes } = await withOperator.json();
    assert.ok(Array.isArray(passes) && passes.length > 0, 'the operator surface answers with data');

    // ...and the reverse holds too: the operator token is not a client token.
    const clientRoute = await fetch(ctx.url('/cognition/hypotheses'), { headers: bearer(OPERATOR_TOKEN) });
    assert.equal(clientRoute.status, 401);
  } finally {
    await ctx.close();
  }
});

test('without GAIA_ADMIN_TOKEN the operator routes say so instead of falling back', async () => {
  const ctx = startServer({ GAIA_API_TOKEN: CLIENT_TOKEN });
  try {
    const res = await fetch(ctx.url('/admin/api/scans'), { headers: bearer(CLIENT_TOKEN) });
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /no admin token configured/);

    // The shell itself stays reachable — it carries no data, and every call it
    // makes carries the operator token the person pastes into it.
    const shell = await fetch(ctx.url('/admin'));
    assert.equal(shell.status, 200);
  } finally {
    await ctx.close();
  }
});
