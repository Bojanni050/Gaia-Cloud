'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { HYPOTHESIS_TRANSITIONS } = require('../src/reasoning/hypothesisManager');
// Cognition owns the lifecycle (CURRENT.md §3.1 #17). This file has no dependencies on purpose,
// so a hermetic gaia-api run can read it without a database.
const { VALID_TRANSITIONS: COGNITION } = require('../../cognition/src/transitions');

// Edges the manager takes that Cognition refuses. Every entry is an open decision, not a
// feature: the manager demotes a confirmed hypothesis under contradiction (§9) but Cognition's
// `confirmed` is terminal, so the demotion never reaches the store.
const KNOWN_DEVIATIONS = [['confirmed', 'testing']];

function edges(table) {
  const out = [];
  for (const [from, tos] of Object.entries(table)) for (const to of tos) out.push(`${from}->${to}`);
  return out.sort();
}

test('the manager only takes automatic edges that Cognition also allows (bar the named deviation)', () => {
  const cognition = new Set(edges(COGNITION));
  const outside = edges(HYPOTHESIS_TRANSITIONS).filter((e) => !cognition.has(e));
  assert.deepEqual(
    outside,
    KNOWN_DEVIATIONS.map(([f, t]) => `${f}->${t}`).sort(),
    'gaia-api and Cognition disagree about a status transition. Cognition owns the lifecycle: '
      + 'change services/cognition/src/transitions.js first, then mirror it in hypothesisManager.js. '
      + 'If you FIXED the confirmed->testing deviation, remove it from KNOWN_DEVIATIONS.',
  );
});

test('both tables know exactly the same statuses', () => {
  assert.deepEqual(Object.keys(HYPOTHESIS_TRANSITIONS).sort(), Object.keys(COGNITION).sort());
});

test('what Cognition allows and the manager leaves out is a person\'s road, and stays small', () => {
  const manager = new Set(edges(HYPOTHESIS_TRANSITIONS));
  const humanOnly = edges(COGNITION).filter((e) => !manager.has(e));
  // Not a defect: these are not automatic. Pinned so a new edge in Cognition is a conscious one.
  assert.deepEqual(humanOnly, ['expired->proposed', 'proposed->confirmed', 'testing->proposed']);
});
