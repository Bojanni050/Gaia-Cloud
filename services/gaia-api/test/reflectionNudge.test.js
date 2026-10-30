'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createReflectionNudge, DEFAULT_NUDGE_INTERVAL } = require('../src/reasoning/reflectionNudge');

test('fires on every Nth turn of the same conversation, not on every turn', () => {
  const nudge = createReflectionNudge({ everyTurns: 3 });

  assert.equal(nudge.noteTurn('c1'), false); // 1
  assert.equal(nudge.noteTurn('c1'), false); // 2
  assert.equal(nudge.noteTurn('c1'), true);  // 3 — nudge
  assert.equal(nudge.noteTurn('c1'), false); // 1 again
  assert.equal(nudge.noteTurn('c1'), false); // 2
  assert.equal(nudge.noteTurn('c1'), true);  // 3 — nudge again
});

test('counts per conversation, independently', () => {
  const nudge = createReflectionNudge({ everyTurns: 2 });

  assert.equal(nudge.noteTurn('c1'), false);
  assert.equal(nudge.noteTurn('c2'), false); // c2 has its own counter
  assert.equal(nudge.noteTurn('c1'), true);  // c1's 2nd
  assert.equal(nudge.noteTurn('c2'), true);  // c2's 2nd
});

test('defaults to the Hermes interval (10) when nothing valid is configured', () => {
  assert.equal(DEFAULT_NUDGE_INTERVAL, 10);

  const nudge = createReflectionNudge();
  let fired = 0;
  for (let i = 0; i < DEFAULT_NUDGE_INTERVAL; i += 1) {
    if (nudge.noteTurn('c1')) fired += 1;
  }
  assert.equal(fired, 1); // exactly on the 10th retained turn
});

test('ignores invalid intervals and falls back to the default', () => {
  for (const bad of [0, -1, NaN, 'nope', null]) {
    const nudge = createReflectionNudge({ everyTurns: bad });
    assert.equal(nudge.noteTurn('c1'), false); // behaves, never throws
  }
});

test('a missing or invalid conversationId is never a nudge turn', () => {
  const nudge = createReflectionNudge({ everyTurns: 1 });
  assert.equal(nudge.noteTurn(undefined), false);
  assert.equal(nudge.noteTurn(null), false);
  assert.equal(nudge.noteTurn(''), false);
  assert.equal(nudge.noteTurn(42), false);
});

// --- the channel ------------------------------------------------------------------
//
// The counter is only half of it: the reminder has to reach the store, and it has
// to reach it in a field the store keeps. A metadata key does not survive the
// memory layer this is moving to (docs/spike-cortexiq.md, 2026-11-16, section 3);
// a tag does. So this runs a real createApp() and a real turn over HTTP against a
// fake Hindsight that records what the retain carried — the rule as a fact about
// traffic rather than about the shape of a call.

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createApp } = require('../src/server');
const { NUDGE_TAG } = require('../src/memory');

/** A fake Hindsight that keeps every retain item it is sent. */
async function startFakeHindsight() {
  const retains = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://fake');
      if (req.method === 'POST' && url.pathname.endsWith('/memories')) {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch (_) { body = {}; }
        for (const item of Array.isArray(body.items) ? body.items : []) retains.push(item);
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ results: [], choices: [{ message: { content: 'ok' } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    retains,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** The real app, with Hindsight and the generator pointed at the fake. */
function startApp(fake, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nudge-'));
  const artifactPath = path.join(dir, 'foundation-artifact.json');
  fs.writeFileSync(artifactPath, JSON.stringify({
    documents: { 'soul.md': 'SOUL', 'principles.md': 'PRINCIPLES', 'lexicon.md': 'LEXICON' },
  }));

  const app = createApp({
    GAIA_API_TOKEN: 'test-token',
    GAIA_ADMIN_TOKEN: 'test-token',
    HERMES_BASE_URL: 'http://fake-hermes.internal/v1',
    HERMES_MODEL: 'hermes-agent',
    FOUNDATION_ARTIFACT_PATH: artifactPath,
    LOGOS_DECISIONS_PATH: path.join(dir, 'logos-decisions'),
    HINDSIGHT_URL: fake.url,
    HINDSIGHT_BANK_ID: 'bojan',
    HINDSIGHT_OWN_BANK_ID: 'gaia',
    HINDSIGHT_LOGOS_BANK_ID: 'gaia-logos',
    GAIA_NATIVE_BASE_URL: fake.url,
    GAIA_NATIVE_MODEL: 'fake-native',
    ...env,
  });

  const server = app.listen(0);
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** One real turn over HTTP, then a moment for the async retain to arrive. */
async function runTurn(app, text = 'I always work better after midnight, remember that') {
  const res = await fetch(`${app.base}/conversation/turn`, {
    method: 'POST',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    // A conversation id is required: the counters are per conversation, and a turn
    // that names none has nowhere to be counted (reflectionNudge.noteTurn).
    body: JSON.stringify({ conversationId: 'nudge-c1', messages: [{ role: 'user', content: text }] }),
  });
  assert.equal(res.status, 200, `the turn must answer, got ${res.status}`);
  await res.json();
  // The retain is async by design (the client sends `async: true` and does not
  // block a turn on it), so give the deferred phase a moment to reach the store.
  await new Promise((resolve) => setTimeout(resolve, 300));
}

/** The nudge tags among the retains the fake saw. */
const nudgeTags = (fake) => fake.retains.flatMap((item) => item.tags || []).filter((tag) => tag === NUDGE_TAG);

test('a nudged turn reaches the store tagged, and an ordinary turn does not', async () => {
  const fake = await startFakeHindsight();
  const app = startApp(fake, { GAIA_MEMORY_NUDGE_EVERY_TURNS: '1' });
  try {
    await runTurn(app);
    assert.ok(fake.retains.length > 0, 'the turn was never reflected at all');
    assert.equal(nudgeTags(fake).length, 1, `expected one nudge tag, got ${JSON.stringify(fake.retains[0].tags)}`);
  } finally {
    await app.close();
    await fake.close();
  }

  const quiet = await startFakeHindsight();
  const quietApp = startApp(quiet, { GAIA_MEMORY_NUDGE_EVERY_TURNS: '3' });
  try {
    await runTurn(quietApp);
    assert.ok(quiet.retains.length > 0, 'the turn was never reflected at all');
    assert.deepEqual(nudgeTags(quiet), [], 'the first of three retained turns is not a nudged one');
  } finally {
    await quietApp.close();
    await quiet.close();
  }
});

test('GAIA_MEMORY_NUDGE reads like every other flag: \'on\' is on, only \'false\' is off', async () => {
  // The bug this pins: a bare `env.GAIA_MEMORY_NUDGE === 'false'` reads the
  // documented 'on' as... on — but `=== 'true'` would read it as off, which is
  // what advice C4 removed across the service. flag() is the only reader.
  const on = await startFakeHindsight();
  const onApp = startApp(on, { GAIA_MEMORY_NUDGE: 'on', GAIA_MEMORY_NUDGE_EVERY_TURNS: '1' });
  try {
    await runTurn(onApp);
    assert.equal(nudgeTags(on).length, 1, "'on' must mean on");
  } finally {
    await onApp.close();
    await on.close();
  }

  const off = await startFakeHindsight();
  const offApp = startApp(off, { GAIA_MEMORY_NUDGE: 'false', GAIA_MEMORY_NUDGE_EVERY_TURNS: '1' });
  try {
    await runTurn(offApp);
    assert.ok(off.retains.length > 0, 'the reflection itself still happens — only the nudge is off');
    assert.deepEqual(nudgeTags(off), [], "'false' must mean off");
  } finally {
    await offApp.close();
    await off.close();
  }
});
