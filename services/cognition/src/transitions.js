'use strict';

/**
 * The hypothesis lifecycle — THE one table of which status may follow which.
 *
 * Cognition owns the lifecycle (CURRENT.md §3.1 #17, decided 2026-11-20), and this is where
 * the rule lives. It sits in its own file with no dependencies (no database, no pool) so that
 * anything else in the repository can read it without starting Cognition: gaia-api cannot
 * import Cognition at runtime (separate containers), but its test suite reads THIS file and
 * fails when gaia-api's own list of automatic edges drifts from it
 * (services/gaia-api/test/transitionsContract.test.js).
 *
 * `rejected` and `confirmed` are terminal here: every automatic verb refuses them. A person
 * leaves `rejected` through `reopen`, which is a named exception rather than an edge.
 */
const VALID_TRANSITIONS = {
  proposed: ['testing', 'confirmed', 'rejected', 'expired'],
  testing: ['corroborated', 'confirmed', 'rejected', 'proposed'],
  corroborated: ['confirmed', 'rejected', 'testing'],
  confirmed: [],
  rejected: [],
  // v1.3 expiry — NOT a quarantine, unlike `rejected`. A lapse is not a
  // judgement: nothing happened, so evidence that arrives later revives the
  // statement (expired → testing), and a person may still settle this one
  // themselves. Only a `proposed` statement can lapse.
  // … and `proposed`, because a person who rewrites an expired statement puts
  // it back in the waiting room rather than editing a lapsed one in place.
  expired: ['testing', 'confirmed', 'rejected', 'proposed'],
};

module.exports = { VALID_TRANSITIONS };
