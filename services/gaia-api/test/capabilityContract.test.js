'use strict';

/**
 * P0 — Logos ↔ Capability-contract tests (Gaia-roadmap).
 *
 * Covers the nine required cases:
 *  1. expected_outcome reached → success
 *  2. Hermes fails → retry → second attempt succeeds
 *  3. First approach fails → alternative → next attempt succeeds
 *  4. Missing information → ask_user
 *  5. All attempts fail → failure
 *  6. max_attempts prevents an infinite loop
 *  7. Technically successful response that misses expected_outcome → NOT success
 *  8. Logos uses only the generic contract (no capability-specific logic)
 *  9. The Hermes adapter translates correctly both ways
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  validateCapabilityRequest,
  createCapabilityRequest,
  evaluateOutcome,
  clampMaxAttempts,
  HARD_MAX_ATTEMPTS,
} = require('../src/logos/capabilityContract');
const { runCapabilityLoop } = require('../src/logos/capabilityLoop');
const { createHermesCapability } = require('../src/capabilities/hermesAdapter');

function successRequest(overrides = {}) {
  return createCapabilityRequest({
    objective: 'Summarize the document in two sentences.',
    instruction: 'Summarize the attached document in exactly two sentences.',
    expected_outcome: {
      description: 'A two-sentence summary mentioning the launch date.',
      mustContain: ['launch'],
      minLength: 20,
    },
    ...overrides,
  });
}

function stubAdapter(sequence) {
  // sequence: array of results (raw values) or functions (request, callIndex) => raw
  let calls = 0;
  const seen = [];
  return {
    seen,
    calls: () => calls,
    adapter: {
      id: 'stub',
      invokeCapability: async (request) => {
        calls += 1;
        seen.push(request);
        const entry = sequence[Math.min(calls - 1, sequence.length - 1)];
        const raw = typeof entry === 'function' ? await entry(request, calls) : entry;
        if (raw instanceof Error) throw raw;
        return raw;
      },
    },
  };
}

// --- 1. expected_outcome reached → success ------------------------------------

test('1: capability reaching expected_outcome → success', async () => {
  const { adapter } = stubAdapter(['The product will launch in June after a long beta.']);
  const result = await runCapabilityLoop({
    request: successRequest(),
    adapter,
    max_attempts: 3,
  });
  assert.equal(result.verdict, 'success');
  assert.equal(result.attempts, 1);
  assert.equal(result.lastEvaluation.verdict, 'success');
});

// --- 2. Hermes fails → retry → second attempt succeeds ------------------------

test('2: Hermes failure → retry → second attempt succeeds', async () => {
  const hermes = {
    calls: 0,
    chat: async () => {
      hermes.calls += 1;
      if (hermes.calls === 1) throw new Error('hermes unreachable');
      return 'The product will launch in June after a long beta.';
    },
  };
  const adapter = createHermesCapability({ hermes });
  const result = await runCapabilityLoop({
    request: successRequest({ capabilityId: 'hermes' }),
    adapter,
    max_attempts: 3,
  });
  assert.equal(result.verdict, 'success');
  assert.equal(result.attempts, 2);
  assert.equal(hermes.calls, 2);
  assert.deepEqual(result.history.map((h) => h.verdict), ['retry', 'success']);
});

// --- 3. first approach fails → alternative → next attempt succeeds ------------

test('3: first approach fails → alternative → next attempt succeeds', async () => {
  const { adapter, seen } = stubAdapter([
    'A short summary without the key fact.', // misses mustContain → alternative
    'The product will launch in June after a long beta.',
  ]);
  const originalInstruction = 'Summarize the attached document in exactly two sentences.';
  const result = await runCapabilityLoop({
    request: successRequest(),
    adapter,
    max_attempts: 3,
  });
  assert.equal(result.verdict, 'success');
  assert.equal(result.attempts, 2);
  assert.deepEqual(result.history.map((h) => h.verdict), ['alternative', 'success']);
  // The original goal is preserved; only the instruction gains an alternative note.
  assert.equal(seen[0].instruction, originalInstruction);
  assert.ok(seen[1].instruction.startsWith(originalInstruction));
  assert.equal(seen[1].objective, seen[0].objective);
  assert.deepEqual(seen[1].expected_outcome, seen[0].expected_outcome);
});

// --- 4. missing information → ask_user ----------------------------------------

test('4: missing required information → ask_user', async () => {
  const { adapter } = stubAdapter([
    { ok: false, technicalSuccess: false, output: null, error: 'missing required date: which launch date do you mean?', requiresUserInput: true },
  ]);
  const result = await runCapabilityLoop({
    request: successRequest(),
    adapter,
    max_attempts: 3,
  });
  assert.equal(result.verdict, 'ask_user');
  assert.equal(result.attempts, 1);
  // No pointless retries once the user is needed.
  assert.equal(result.history.length, 1);
});

// --- 5. all attempts fail → failure -------------------------------------------

test('5: all attempts fail → failure with honest report', async () => {
  const { adapter } = stubAdapter([new Error('hermes unreachable')]);
  const result = await runCapabilityLoop({
    request: successRequest(),
    adapter,
    max_attempts: 3,
  });
  assert.equal(result.verdict, 'failure');
  assert.equal(result.attempts, 3);
  assert.match(result.lastEvaluation.reason, /max_attempts=3/);
  assert.match(result.lastEvaluation.reason, /not reached|goal not reached/i);
});

// --- 6. max_attempts prevents an infinite loop --------------------------------

test('6: max_attempts caps the loop — never infinite, counter covers the whole loop', async () => {
  // An adapter that always fails transiently would loop forever without a cap.
  const { adapter, calls } = stubAdapter([new Error('boom')]);
  const result = await runCapabilityLoop({
    request: successRequest(),
    adapter,
    max_attempts: 5,
  });
  assert.equal(result.verdict, 'failure');
  assert.equal(result.attempts, 5);
  assert.equal(calls(), 5);

  // Absurd configuration is clamped to the hard ceiling.
  assert.ok(clampMaxAttempts(999999) <= HARD_MAX_ATTEMPTS);
  const { adapter: a2, calls: c2 } = stubAdapter([new Error('boom')]);
  const r2 = await runCapabilityLoop({ request: successRequest(), adapter: a2, max_attempts: 999999 });
  assert.equal(r2.attempts, HARD_MAX_ATTEMPTS);
  assert.equal(c2(), HARD_MAX_ATTEMPTS);

  // Mixed retry+alternative paths share ONE counter.
  const { adapter: a3 } = stubAdapter(['nope', new Error('x'), 'still missing it']);
  const r3 = await runCapabilityLoop({ request: successRequest(), adapter: a3, max_attempts: 2 });
  assert.equal(r3.attempts, 2);
  assert.equal(r3.verdict, 'failure');
});

// --- 7. technical success without outcome ≠ success ----------------------------

test('7: technically successful response missing expected_outcome → no success', async () => {
  const request = successRequest();
  const evaluation = evaluateOutcome(request, 'A fluent, well-written summary of unrelated events.');
  assert.notEqual(evaluation.verdict, 'success');
  assert.equal(evaluation.verdict, 'alternative');

  const { adapter } = stubAdapter(['A fluent, well-written summary of unrelated events.']);
  const result = await runCapabilityLoop({ request, adapter, max_attempts: 1 });
  assert.equal(result.verdict, 'failure'); // single attempt: alternative has no room → honest failure
  assert.notEqual(result.lastEvaluation.verdict, 'success');
});

// --- 8. Logos knows only the generic contract ----------------------------------

test('8: Logos contract + loop contain no capability-specific logic', () => {
  for (const file of ['../src/logos/capabilityContract.js', '../src/logos/capabilityLoop.js']) {
    const source = fs.readFileSync(path.resolve(__dirname, file), 'utf-8');
    const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
    assert.ok(!/hermes/i.test(codeOnly), `${file} must not reference any concrete capability`);
  }
  // The contract rejects capability-specific fields instead of understanding them.
  assert.match(
    validateCapabilityRequest({ objective: 'o', instruction: 'i', expected_outcome: 'e', model: 'x' }),
    /must not carry capability-specific field/
  );
  assert.equal(
    validateCapabilityRequest({ objective: 'o', instruction: 'i', expected_outcome: 'e' }),
    null
  );
});

// --- 9. Hermes adapter translates both ways ------------------------------------

test('9: Hermes adapter translates generic request → Hermes interface → generic result', async () => {
  const seenMessages = [];
  const hermes = {
    chat: async (messages) => {
      seenMessages.push(messages);
      return 'The product will launch in June.';
    },
  };
  const adapter = createHermesCapability({ hermes });
  assert.equal(adapter.id, 'hermes');

  const request = successRequest({ capabilityId: 'hermes' });
  const result = await adapter.invokeCapability(request);
  assert.equal(result.ok, true);
  assert.equal(result.technicalSuccess, true);
  assert.equal(result.output, 'The product will launch in June.');

  // The Hermes payload carries objective + instruction + expected outcome —
  // translated, never capability-shaped input leaking back into the contract.
  const flat = JSON.stringify(seenMessages[0]);
  assert.ok(flat.includes(request.instruction));
  assert.ok(flat.includes(request.objective));
  assert.ok(!/expected_outcome/.test(flat) || flat.includes('Expected outcome'));

  // Hermes throw → generic failure result (never a throw across the seam).
  const failing = createHermesCapability({ hermes: { chat: async () => { throw new Error('hermes unreachable'); } } });
  const failed = await failing.invokeCapability(request);
  assert.equal(failed.ok, false);
  assert.match(failed.error, /hermes unreachable/);

  // Hermes empty string → generic failure, not a silent success.
  const empty = createHermesCapability({ hermes: { chat: async () => '   ' } });
  assert.equal((await empty.invokeCapability(request)).ok, false);

  // Invalid contract request → generic failure without calling Hermes.
  let called = 0;
  const counting = createHermesCapability({ hermes: { chat: async () => { called += 1; return 'x'; } } });
  const bad = await counting.invokeCapability({ objective: '', instruction: 'i', expected_outcome: 'e' });
  assert.equal(bad.ok, false);
  assert.equal(called, 0);
});
