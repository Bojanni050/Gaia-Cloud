'use strict';

// scripts/ sits outside both services, so the normal suites would never touch
// the drift guard. This test is what keeps scripts/verify-architecture.js
// honest: it runs the guard against the REAL document, and it proves its
// failure path on a synthetic tree — a check that cannot fail is not a check.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { verify } = require('../../../scripts/verify-architecture');

const ROOT = path.join(__dirname, '..', '..', '..');

/** A throwaway repo: the document plus the few code files an anchor needs. */
function fixture({ doc, code = {} }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-arch-'));
  const files = {
    'docs/architecture.md': doc,
    'services/gaia-api/src/verbs.js': "const on = env.GAIA_TEST_FLAG !== 'false';\ntool('remember'); capability('memory'); router.post('/retract'); router.get('/jobs');\n",
    'services/cognition/src/store.js': "const VALID = ['proposed', 'testing', 'corroborated', 'confirmed', 'rejected', 'expired'];\nconst COLUMN = 'expired_at';\n",
    ...code,
  };
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return root;
}

const DOC = [
  '# Test document',
  '',
  '> **Verified against code: commit `abc1234` (2026-01-01).**',
  '',
  '## Tool, capability, skill',
  '',
  'A tool is `remember` and a capability is `memory`.',
  '',
  '## Derived lifecycle',
  '',
  'The statuses are `proposed`, `testing`, `corroborated`, `confirmed`,',
  '`rejected` and `expired`.',
  '',
  '## Switches',
  '',
  '`GAIA_TEST_FLAG` turns the test pass on.',
  '',
  '## HTTP surface',
  '',
  '| Mount | Routes |',
  '| --- | --- |',
  '| inline | `POST /retract` |',
  '| `/jobs` | `GET /jobs` |',
  '',
  '## Clients, and what this repo does not contain',
  '',
  'Not in this repository: the VPS reset path `/root/gaia` — nothing here can',
  'check it.',
  '',
].join('\n');

const withCode = (extra) => fixture({
  doc: DOC,
  code: { 'services/gaia-api/src/extra.js': extra },
});

test('the real document passes against the real tree', () => {
  const result = verify({ root: ROOT });
  assert.deepEqual(result.failures, [], 'docs/architecture.md has drifted — fix the document or the anchor');
  assert.ok(result.checked.paths > 0, 'nothing was checked at all');
  assert.ok(result.checked.flags > 0, 'no flags were checked');
  assert.ok(result.checked.routes > 0, 'no routes were checked');
  assert.match(result.docCommit, /^[0-9a-f]{7,40}$/, 'the document must record the commit it was verified against');
});

test('an anchor that is gone from the code is reported with its line number', () => {
  const root = fixture({
    doc: DOC.replace('`GAIA_TEST_FLAG`', '`GAIA_TEST_FLAG_RENAMED`'),
    code: { 'services/gaia-api/src/flags.js': "const on = env.GAIA_TEST_FLAG !== 'false';\n" },
  });
  const result = verify({ root });
  assert.equal(result.ok, false);
  const failure = result.failures.find((f) => f.kind === 'flag');
  assert.ok(failure, 'the renamed flag was not reported');
  assert.equal(failure.token, 'GAIA_TEST_FLAG_RENAMED');
  assert.ok(failure.line > 0, 'the failure must point at a line in the document');
});

test('a lifecycle status that no longer exists is reported', () => {
  const root = fixture({ doc: DOC.replace('`corroborated`', '`gecorroboreerd`') });
  const result = verify({ root });
  assert.equal(result.ok, false);
  assert.equal(result.failures[0].kind, 'status');
  assert.equal(result.failures[0].token, 'gecorroboreerd');
});

test('a route that no handler declares is reported', () => {
  const root = fixture({ doc: DOC.replace('| `/jobs` | `GET /jobs` |', '| `/jobs` | `GET /jobs/queued` |') });
  const result = verify({ root });
  assert.equal(result.ok, false);
  assert.equal(result.failures[0].kind, 'route');
  assert.equal(result.failures[0].token, '/jobs/queued');
});

test('a path that is not in the tree is reported', () => {
  const root = fixture({
    doc: DOC.replace('## Clients, and what this repo does not contain', '`docs/vermist.md` is the index.\n\n## Clients, and what this repo does not contain'),
  });
  const result = verify({ root });
  assert.equal(result.ok, false);
  assert.equal(result.failures[0].kind, 'path');
  assert.equal(result.failures[0].token, 'docs/vermist.md');
});

test('a line marked *(deployment)* is not checked, since this repo cannot', () => {
  const root = fixture({
    doc: DOC.replace(
      '`GAIA_TEST_FLAG` turns the test pass on.',
      '`GAIA_TEST_FLAG_RENAMED` turns the test pass on. *(deployment)*',
    ),
  });
  const result = verify({ root });
  assert.deepEqual(result.failures, [], 'the documented escape hatch was not honoured');
});

test('the guard reports the document it read and finds nothing hidden', () => {
  const root = withCode("const x = env.GAIA_TEST_FLAG;\n");
  const result = verify({ root });
  assert.equal(result.ok, true);
  assert.equal(result.docCommit, 'abc1234');
  assert.ok(result.checked.identifiers >= 2, `expected tool and capability anchors, got ${result.checked.identifiers}`);
  assert.ok(result.checked.statuses >= 6, `expected six statuses, got ${result.checked.statuses}`);
});
