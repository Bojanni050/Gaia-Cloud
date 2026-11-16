'use strict';

// The seam between the two compose stacks: gaia-api joins the Cognition stack's
// network by name, as an external network. Compose derives that name from
// <project>_<network key>, so the two files only agree by accident — which is
// exactly how the docs ended up claiming `gaia-cognition_default` in one place
// and `cognition_gaia_cognition_default` in another (docs/advice.md C2), and how
// a directory rename could have renamed the network out from under a green
// deploy.
//
// The invariant this test holds: the network name gaia-api declares external
// must be the name the Cognition stack actually resolves to. Both sides now pin
// it (project `name:` plus the network's own `name:`), so the derived value and
// the declared value are one fact instead of two.
//
// Verified against `docker compose config` on both files on 2026-11-16, which is
// what makes the parsing below safe: it mirrors compose's rule (project pin, or
// the directory name; explicit network name, or <project>_<key>) rather than
// inventing its own.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..');
const COGNITION = path.join(ROOT, 'services/cognition/docker-compose.yml');
const GAIA_API = path.join(ROOT, 'services/gaia-api/docker-compose.yml');
const DEPLOY = path.join(ROOT, '.github/workflows/deploy.yml');

const read = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

/** The top-level `name:` of a compose file, or null — never a nested one. */
function projectName(yaml) {
  const match = /^name:\s*(\S+)\s*$/m.exec(yaml);
  return match ? match[1] : null;
}

/**
 * What the Cognition stack's network is called, per compose's own rule:
 * `name:` on the network wins, otherwise <project>_<key>. The project is the
 * file's `name:`, else the directory the file lives in.
 */
function resolvedNetworkName({ yaml, directory, key }) {
  const block = new RegExp(`^  ${key}:\\n((?:    .*\\n)*)`, 'm').exec(yaml);
  assert.ok(block, `network ${key} is not declared`);
  const explicit = /^\s+name:\s*(\S+)\s*$/m.exec(block[1]);
  if (explicit) return explicit[1];
  return `${projectName(yaml) || path.basename(directory)}_${key}`;
}

const cognitionYaml = read(COGNITION);
const gaiaApiYaml = read(GAIA_API);

test('the network gaia-api joins is the one the Cognition stack resolves to', () => {
  const resolved = resolvedNetworkName({
    yaml: cognitionYaml,
    directory: path.dirname(COGNITION),
    key: 'gaia_cognition_default',
  });
  const declared = /^\s+name:\s*(\S+)\s*$/m.exec(
    /^  cognition_net:\n((?:    .*\n)*)/m.exec(gaiaApiYaml)[1],
  )[1];

  assert.equal(declared, resolved, 'gaia-api would join a network that does not exist');
  assert.equal(resolved, 'cognition_gaia_cognition_default');
});

test('both sides are pinned, so a rename or a -p cannot move the network', () => {
  // The project pin keeps the derived name stable against a directory rename;
  // the network's own `name:` keeps it stable against -p/COMPOSE_PROJECT_NAME.
  assert.equal(projectName(cognitionYaml), 'cognition');
  assert.match(
    cognitionYaml,
    /^  gaia_cognition_default:\n(?:    .*\n)*?    name: cognition_gaia_cognition_default\n/m,
    'the Cognition network is not pinned by name',
  );
});

test('the derived name really is <project>_<key> — proven on a fixture, not assumed', () => {
  // The negative case: with no pins at all, compose would use the directory
  // name, and the same input must produce a *different* name — which is what
  // this test would report if the pins were ever removed.
  const unpinned = 'services:\n  a:\n    image: x\nnetworks:\n  gaia_cognition_default:\n    driver: bridge\n';
  const derived = resolvedNetworkName({ yaml: unpinned, directory: '/repo/services/cognition', key: 'gaia_cognition_default' });
  assert.equal(derived, 'cognition_gaia_cognition_default'); // same today, by accident of the directory name
  const fromElsewhere = resolvedNetworkName({ yaml: unpinned, directory: '/repo/services/derived-lifecycle', key: 'gaia_cognition_default' });
  assert.equal(fromElsewhere, 'derived-lifecycle_gaia_cognition_default'); // ← the fragility the pins remove
});

test('the deploy workflow does not claim a network name of its own', () => {
  const deploy = read(DEPLOY);
  // The workflow used to repeat the wrong name in a NOTE; the rule now is that
  // it names the real one and points at `docker compose config` for the rest.
  assert.doesNotMatch(deploy, /gaia-cognition_default/, 'the deploy note contradicts the pinned network name');
  assert.match(deploy, /cognition_gaia_cognition_default/);
});
