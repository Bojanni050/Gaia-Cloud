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

// The visual map has a standalone twin, and both carry the same diagrams. Check
// 6 compares them. Its failure path is proven here: a diagram that differs, a
// count that differs, and a pair with one half missing.
const MAP_MD = '# map\n\n```mermaid\nflowchart TB\n  a["x"] --> b["y"]\n```\n';
const MAP_HTML = '<pre class="mermaid">\nflowchart TB\n  a["x"] --> b["y"]\n</pre>\n';

test('two agreeing halves of the map are fine, and the guard counts the diagrams', () => {
  const root = fixture({
    doc: DOC,
    code: { 'docs/architecture-graph.md': MAP_MD, 'docs/architecture-graph.html': MAP_HTML },
  });
  const result = verify({ root });
  assert.equal(result.ok, true, JSON.stringify(result.failures));
  assert.equal(result.checked.diagrams, 1);
});

test('a diagram that differs between the map and its twin is reported', () => {
  const root = fixture({
    doc: DOC,
    code: {
      'docs/architecture-graph.md': MAP_MD,
      'docs/architecture-graph.html': '<pre class="mermaid">\nflowchart TB\n  a["x"] --> c["z"]\n</pre>\n',
    },
  });
  const result = verify({ root });
  assert.equal(result.ok, false);
  const graph = result.failures.filter((f) => f.kind === 'graph');
  assert.equal(graph.length, 1, `expected one graph finding, got ${JSON.stringify(result.failures)}`);
  assert.match(graph[0].detail, /diagram 1 differs/);
});

test('a missing half of the pair, or a different number of diagrams, is reported', () => {
  const lonely = fixture({ doc: DOC, code: { 'docs/architecture-graph.html': MAP_HTML } });
  const loneResult = verify({ root: lonely });
  assert.equal(loneResult.ok, false);
  assert.match(loneResult.failures.find((f) => f.kind === 'graph').detail, /is missing while its twin/);

  const uneven = fixture({
    doc: DOC,
    code: {
      'docs/architecture-graph.md': `${MAP_MD}\n\`\`\`mermaid\nflowchart LR\n  p["1"] --> q["2"]\n\`\`\`\n`,
      'docs/architecture-graph.html': MAP_HTML,
    },
  });
  const unevenResult = verify({ root: uneven });
  assert.equal(unevenResult.ok, false);
  assert.match(unevenResult.failures.find((f) => f.kind === 'graph').detail, /carries 2 diagrams, .* carries 1/);
});

// Check 7: the documents that are runtime content — bundled by
// scripts/build-foundation-artifact.js into the artifact the container bakes in.
// The bundle list and the sentence in the document that lists it must agree in both
// directions, and every name in it must exist: on 2026-11-11 docs/ was emptied while
// the list kept naming a file that was gone, and what found out was
// `publish-foundation`, after the merge, as a failed release. All three are proven
// here — and so is the boundary: that section cites `docs/advice.md` in a later
// paragraph, which is not a listing, so the check must not read it as one.
const BUNDLE_SECTION = [
  '## These documents are runtime content',
  '',
  'The build script `scripts/build-foundation-artifact.js` bundles',
  '`services/gaia-api/identity/soul.md` with `docs/principles.md` and',
  '`docs/lexicon.md` into the artifact.',
  '',
  'Later in this section, and not a listing: `docs/advice.md` §1.',
  '',
];

function bundledFixture({ documents = "['soul.md', 'principles.md', 'lexicon.md']", files } = {}) {
  const code = {
    'scripts/build-foundation-artifact.js': `const DOCUMENTS = ${documents};\n\nmodule.exports = { DOCUMENTS };\n`,
    'docs/advice.md': 'cited above, never bundled\n',
  };
  for (const file of files ?? ['docs/principles.md', 'docs/lexicon.md', 'services/gaia-api/identity/soul.md']) {
    code[file] = 'runtime text\n';
  }
  return fixture({ doc: [...DOC, ...BUNDLE_SECTION].join('\n'), code });
}

test('a bundle list the document agrees with is fine, and the guard counts it', () => {
  const result = verify({ root: bundledFixture() });
  assert.deepEqual(result.failures, [], 'a cited document must not be read as a bundled one');
  assert.equal(result.checked.bundled, 3);
});

test('a document bundled but not named in the sentence that lists the bundle is reported', () => {
  const root = bundledFixture({
    documents: "['soul.md', 'principles.md', 'lexicon.md', 'identity.md']",
    files: ['docs/principles.md', 'docs/lexicon.md', 'docs/identity.md', 'services/gaia-api/identity/soul.md'],
  });
  const result = verify({ root });
  assert.equal(result.ok, false);
  const bundled = result.failures.filter((f) => f.kind === 'bundled');
  assert.equal(bundled.length, 1, `expected one finding, got ${JSON.stringify(result.failures)}`);
  assert.match(bundled[0].detail, /identity\.md is in DOCUMENTS but the sentence describing the bundle does not name it/);
});

test('a document the sentence lists but DOCUMENTS does not carry is reported', () => {
  const root = bundledFixture({ documents: "['soul.md', 'principles.md']" });
  fs.writeFileSync(path.join(root, 'docs/lexicon.md'), 'runtime text\n');
  const result = verify({ root });
  assert.equal(result.ok, false);
  assert.match(
    result.failures.find((f) => f.kind === 'bundled').detail,
    /lexicon\.md is named in the sentence describing the bundle but DOCUMENTS does not carry it/,
  );
});

test('a bundled document missing from the tree is reported before the merge, not after it', () => {
  // The list still names principles.md — the file is simply gone, which is what
  // 2026-11-11 looked like: the list was right, the tree was not.
  const root = bundledFixture({ files: ['docs/lexicon.md', 'services/gaia-api/identity/soul.md'] });
  const result = verify({ root });
  assert.equal(result.ok, false);
  assert.match(
    result.failures.find((f) => f.kind === 'bundled').detail,
    /principles\.md is in DOCUMENTS but not in the tree/,
  );
});
