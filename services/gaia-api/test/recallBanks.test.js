'use strict';

// Bo's rule, 18-10-2026: "van de 9 moeten er 9 uit de bojan bank komen". The nine
// recall lines a turn may read come from his own bank. Her own bank (`gaia`) joins
// only on a turn that asks about her, and the derived bank (`gaia-logos`) takes no
// lines of its own — that is what `search_memory` spans when she looks something
// up herself (docs/advice.md C8).
//
// This file used to guard that rule with regular expressions over the *source* of
// server.js and turn.js: it broke on any reformatting, and it stayed green through
// a real change of behaviour, because it read the text instead of the decision.
// The rule is now tested where it is decided — which client gets the recall, and
// which banks that client asks. What the wiring does with those clients is
// `recallBanksEndToEnd.test.js`.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTurnRecallClients } = require('../src/hindsightClient');
const { recallForTurn } = require('../src/turn');

/** A bank client that records the calls it receives. */
function recordingBank(name, calls) {
  return {
    recall: async () => {
      calls.push(`${name}.recall`);
      return [{ unitId: `${name}-1` }];
    },
  };
}

/**
 * A full client: every method answers an empty array and every call is recorded.
 * The legs next to recall (mental models, knowledge pages) ask this client for
 * things the rule says nothing about, so the test must not care what those are
 * called — it cares which client gets `recall`.
 */
function anyClient(name, calls) {
  return new Proxy({}, {
    get: (_target, property) => {
      if (property === 'then') return undefined;
      return () => {
        calls.push(`${name}.${String(property)}`);
        return Promise.resolve([]);
      };
    },
  });
}

// --- the two clients --------------------------------------------------------

test('the passive client reads Bo\'s bank and nothing else', async () => {
  const calls = [];
  const { passive } = createTurnRecallClients({
    app: recordingBank('bojan', calls),
    own: recordingBank('gaia', calls),
  });

  await passive.recall('wat zei je over het project?');
  assert.deepEqual(calls, ['bojan.recall'], 'her bank must not fill a passive turn\'s lines');
});

test('her bank joins the self client, next to his', async () => {
  const calls = [];
  const { self } = createTurnRecallClients({
    app: recordingBank('bojan', calls),
    own: recordingBank('gaia', calls),
  });

  await self.recall('wat houdt je bezig?');
  assert.deepEqual(calls.sort(), ['bojan.recall', 'gaia.recall']);
});

test('without a second bank the self client IS the passive one', async () => {
  const calls = [];
  const { passive, self } = createTurnRecallClients({ app: recordingBank('bojan', calls) });

  assert.equal(self, passive, 'one bank means one client, not a broken second one');
  await self.recall('wat houdt je bezig?');
  assert.deepEqual(calls, ['bojan.recall']);
});

// --- which client the turn hands the query to -------------------------------

/**
 * Run the real `recallForTurn` with three distinguishable clients and report
 * which of them was asked to recall.
 *
 * The archive door is open in every case so the recall gate lets the query
 * through: the gate drops a query *before* a client is chosen, and a test that
 * measures nothing is worse than no test.
 */
async function recalledBy({ asksAboutHer = false, narrow = true } = {}) {
  const calls = [];
  const passive = anyClient('passive', calls);
  const self = anyClient('self', calls);
  const full = anyClient('full', calls);

  await recallForTurn({
    userText: 'wat zei je vorige week over het project?',
    shape: { asksAboutHer, looksInArchive: true, looksInRecords: false },
    intentDecision: null,
    conversationId: 'conversation-1',
    traceId: 'trace-1',
    timing: { start: () => {}, end: () => 0 },
    decisionLogger: null,
    hindsight: full,
    recallHindsight: narrow ? passive : undefined,
    recallHindsightSelf: narrow ? self : undefined,
    foundation: null,
    conversationSearch: { search: () => [] },
    hypothesisRuntime: null,
    researchJobs: null,
  });

  return calls.filter((call) => call.endsWith('.recall'));
}

test('an ordinary turn fills its lines from the passive client', async () => {
  assert.deepEqual(await recalledBy({ asksAboutHer: false }), ['passive.recall']);
});

test('a turn that asks about her fills them from the self client', async () => {
  assert.deepEqual(await recalledBy({ asksAboutHer: true }), ['self.recall']);
});

test('the full client fills the lines only when no narrow client was handed over', async () => {
  // The documented fallback: older wiring and hand-built turns pass one client.
  // It fills the lines then — and this is the only case in which it may.
  assert.deepEqual(await recalledBy({ narrow: false }), ['full.recall']);
  assert.deepEqual(await recalledBy({ narrow: false, asksAboutHer: true }), ['full.recall']);
});
