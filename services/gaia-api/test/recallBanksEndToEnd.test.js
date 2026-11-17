'use strict';

// The bank rule, observed where it actually happens (docs/advice.md C8).
//
// Unit tests can prove which client `recallForTurn` picks and what each client
// asks its banks for, but they cannot see the wiring: `server.js` builds three
// clients and hands two of them to both turn entry points. A dropped pair there
// falls back silently to the full cross-bank client — the failure the old
// source-reading test was trying to catch, and precisely what it could not.
//
// So this file runs a real `createApp()`, a real turn over HTTP, against a fake
// Hindsight that records which bank every recall names. The rule is then a fact
// about traffic rather than about text:
//
//   - an ordinary turn reads Bo's bank and nothing else;
//   - a turn that asks about her adds her bank, next to his;
//   - the derived bank (`gaia-logos`) fills no recall line in either.
//
// One distinction the traffic makes and the source never did: the derived bank IS
// recalled during a turn — for its own records, the hypotheses and patterns it
// holds, which the adapters ask for with `tags` set
// (`reasoning/hindsightHypothesisAdapter.js`, `hindsightPatternAdapter.js`). What
// it may not do is fill the nine lines, and a line recall is the one *without*
// tags (`hindsightClient.recall`). Measuring "any recall at all" would have called
// the rule broken when it is not, which is why this file draws that line.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createApp } = require('../src/server');

/**
 * A fake Hindsight. For every `/memories/recall` it records the bank and whether
 * the request carried `tags` (a derived-record load) or not (a line recall), and
 * answers everything else permissively — the other legs (mental models, knowledge
 * base) and the generator fail soft on a shape they do not recognize, and what
 * this file measures is who was asked.
 */
async function startFakeHindsight() {
  const recalls = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fake');
    const bank = (url.pathname.match(/\/banks\/([^/]+)\//) || [])[1] || null;
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      if (bank && url.pathname.endsWith('/memories/recall')) {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch (_) { body = {}; }
        recalls.push({ bank, tagged: Array.isArray(body.tags) && body.tags.length > 0 });
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ results: [], choices: [{ message: { content: 'ok' } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    recalls,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** The real app, with Hindsight and the generator pointed at the fake. */
function startApp(fake) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-banks-'));
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
  });

  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** One real turn over HTTP. Returns the banks that filled lines, and every recall seen. */
async function runTurn(fake, app, text) {
  fake.recalls.length = 0;
  const res = await fetch(`${app.base}/conversation/turn`, {
    method: 'POST',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: text }] }),
  });
  assert.equal(res.status, 200, `the turn must answer, got ${res.status}`);
  await res.json();
  const seen = [...fake.recalls];
  return {
    // A line recall is the one without tags — see the header.
    lineBanks: [...new Set(seen.filter((recall) => !recall.tagged).map((recall) => recall.bank))].sort(),
    seen,
  };
}

test('an ordinary turn fills the nine lines from Bo\'s bank alone', async () => {
  const fake = await startFakeHindsight();
  const app = startApp(fake);
  try {
    const { lineBanks, seen } = await runTurn(fake, app, 'wat zei je vorige week over het project?');
    assert.deepEqual(lineBanks, ['bojan'], `line recalls asked ${lineBanks.join(', ')}`);

    // The derived bank may be recalled for its own records — and only that way:
    // anything it is asked for that is not a tagged derived-record load would be
    // a recall line, which is exactly what the rule forbids.
    for (const recall of seen.filter((r) => r.bank === 'gaia-logos')) {
      assert.ok(recall.tagged, 'a recall of the derived bank must be a tagged derived-record load');
    }
  } finally {
    await app.close();
    await fake.close();
  }
});

test('a turn that asks about her adds her bank — and still not the derived one for lines', async () => {
  const fake = await startFakeHindsight();
  const app = startApp(fake);
  try {
    const { lineBanks } = await runTurn(fake, app, 'wat houdt je bezig?');
    assert.deepEqual(lineBanks, ['bojan', 'gaia']);
    assert.ok(!lineBanks.includes('gaia-logos'), 'the derived bank takes no recall lines of its own');
  } finally {
    await app.close();
    await fake.close();
  }
});
