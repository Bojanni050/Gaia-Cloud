'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { flag, TRUTHY, FALSY } = require('../src/flags');

const quiet = { warn: null };

test('an unset or empty flag takes its documented default', () => {
  assert.equal(flag({}, 'GAIA_X', { default: true, ...quiet }), true);
  assert.equal(flag({}, 'GAIA_X', { default: false, ...quiet }), false);
  assert.equal(flag({ GAIA_X: '' }, 'GAIA_X', { default: true, ...quiet }), true);
  assert.equal(flag({ GAIA_X: '   ' }, 'GAIA_X', { default: false, ...quiet }), false);
  assert.equal(flag(undefined, 'GAIA_X', { default: true, ...quiet }), true);
});

test('the default is off when the caller names none — never guessed silently', () => {
  assert.equal(flag({}, 'GAIA_X', quiet), false);
  assert.equal(flag({ GAIA_X: 'on' }, 'GAIA_X', quiet), true);
});

test('every documented spelling works, in either direction, for either default', () => {
  for (const token of ['true', 'on', '1', 'yes']) {
    assert.equal(flag({ GAIA_X: token }, 'GAIA_X', { default: false, ...quiet }), true, token);
    assert.equal(flag({ GAIA_X: token }, 'GAIA_X', { default: true, ...quiet }), true, token);
  }
  for (const token of ['false', 'off', '0', 'no']) {
    assert.equal(flag({ GAIA_X: token }, 'GAIA_X', { default: true, ...quiet }), false, token);
    assert.equal(flag({ GAIA_X: token }, 'GAIA_X', { default: false, ...quiet }), false, token);
  }
  assert.deepEqual([...TRUTHY], ['true', 'on', '1', 'yes']);
  assert.deepEqual([...FALSY], ['false', 'off', '0', 'no']);
});

test('case and surrounding whitespace do not change the answer', () => {
  assert.equal(flag({ GAIA_X: 'ON' }, 'GAIA_X', { default: false, ...quiet }), true);
  assert.equal(flag({ GAIA_X: ' True ' }, 'GAIA_X', { default: false, ...quiet }), true);
  assert.equal(flag({ GAIA_X: 'Off' }, 'GAIA_X', { default: true, ...quiet }), false);
});

// The three historical bugs this module exists for: these values used to
// *disable* a pass that was on by default.
test('on and 1 no longer switch a default-on pass off', () => {
  for (const token of ['on', '1', 'yes']) {
    assert.equal(flag({ GAIA_HYPOTHESIS_EXPIRY: token }, 'GAIA_HYPOTHESIS_EXPIRY', { default: true, ...quiet }), true);
  }
});

test('true no longer switches a default-off capability off', () => {
  assert.equal(flag({ GAIA_RESEARCH_REACH: 'true' }, 'GAIA_RESEARCH_REACH', { default: false, ...quiet }), true);
  assert.equal(flag({ GAIA_OPEN_QUESTION_REACH: '1' }, 'GAIA_OPEN_QUESTION_REACH', { default: false, ...quiet }), true);
});

test('false and off now switch off what only accepted one of the two before', () => {
  assert.equal(flag({ GAIA_LOGOS_SOCIAL_GATE: 'false' }, 'GAIA_LOGOS_SOCIAL_GATE', { default: true, ...quiet }), false);
  assert.equal(flag({ GAIA_AION: 'off' }, 'GAIA_AION', { default: true, ...quiet }), false);
});

test('an unreadable value takes the default and says so, instead of a third state', () => {
  const warnings = [];
  const warn = (message) => warnings.push(message);
  assert.equal(flag({ GAIA_X: 'maybe' }, 'GAIA_X', { default: true, warn }), true);
  assert.equal(flag({ GAIA_X: 'maybe' }, 'GAIA_X', { default: false, warn }), false);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /GAIA_X="maybe" is not a boolean/);
  assert.match(warnings[0], /default \(on\)/);
  assert.match(warnings[1], /default \(off\)/);
});

test('a non-string value is judged the same way and never throws', () => {
  const warnings = [];
  const warn = (message) => warnings.push(message);
  assert.equal(flag({ GAIA_X: 1 }, 'GAIA_X', { default: false, warn }), true);      // 1 is a truthy token
  assert.equal(flag({ GAIA_X: {} }, 'GAIA_X', { default: true, warn }), true);      // unreadable → default
  assert.equal(flag({ GAIA_X: {} }, 'GAIA_X', { default: false, warn }), false);
  assert.equal(warnings.length, 2);
});
