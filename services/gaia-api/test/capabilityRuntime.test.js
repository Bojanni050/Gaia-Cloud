'use strict';

/**
 * P0 runtime integration tests (Gaia-roadmap — P0 is actief in de runtime).
 *
 * These test the ACTUAL execution path (orchestrator → adapter → outcome
 * loop), not just the isolated P0 modules (covered in
 * capabilityContract.test.js):
 *
 *  1. Logos → orchestrator → Hermes → outcome `success`.
 *  2. Hermes result missing expected_outcome → evaluator runs.
 *  3. `retry` triggers a real new Hermes execution.
 *  4. `alternative` triggers a real new capability request.
 *  5. `ask_user` stops execution and returns correctly to the user.
 *  6. `max_attempts` stops the real runtime loop.
 *  7. Exhaustion yields honest `failure`.
 *  8. Existing successful capability flows keep working.
 *  9. Logos/orchestrator hold no Hermes-specific contract logic.
 * 10. The Hermes adapter is the only Hermes-translation site.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { execute } = require('../src/orchestration/orchestrator');
const { createHermesCapability } = require('../src/capabilities/hermesAdapter');
const { validateDecision } = require('../src/decision/decisionSchema');

function hermesDecision(overrides = {}) {
  return {
    action: 'capability',
    capability: 'hermes',
    task: 'respond',
    input: { userInput: 'Summarize the launch plan.' },
    expected_outcome: {
      description: 'A summary mentioning the launch.',
      mustContain: ['launch'],
      minLength: 10,
    },
    reason: 'test',
    ...overrides,
  };
}

function codeOf(relPath) {
  return fs.readFileSync(path.resolve(__dirname, relPath), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
}

// --- 1. Logos → orchestrator → Hermes → success -------------------------------

test('1: runtime Hermes execution reaching expected_outcome → success', async () => {
  const hermes = { chat: async () => 'The product will launch in June.' };
  const result = await execute(hermesDecision(), {
    capabilities: { hermes: createHermesCapability({ hermes }) },
    messages: [{ role: 'user', content: 'Summarize the launch plan.' }],
  });
  assert.equal(result.action, 'capability');
  assert.equal(result.output, 'The product will launch in June.');
  assert.equal(result.error, undefined);
  assert.equal(result.outcome.verdict, 'success');
  assert.equal(result.outcome.attempts, 1);
});

// --- 2. outcome miss → evaluator runs ------------------------------------------

test('2: Hermes result missing expected_outcome → evaluator runs, no silent success', async () => {
  const hermes = { chat: async () => 'A fluent summary of unrelated events.' };
  const result = await execute(hermesDecision({ max_attempts: 1 }), {
    capabilities: { hermes: createHermesCapability({ hermes }) },
    messages: [{ role: 'user', content: 'Summarize the launch plan.' }],
  });
  assert.equal(result.output, null);
  assert.equal(result.outcome.verdict, 'failure');
  assert.match(result.error, /missing required element/);
});

// --- 3. retry → real new Hermes execution --------------------------------------

test('3: retry triggers a real second Hermes execution', async () => {
  let calls = 0;
  const hermes = {
    chat: async () => {
      calls += 1;
      if (calls === 1) throw new Error('hermes unreachable');
      return 'The product will launch in June.';
    },
  };
  const result = await execute(hermesDecision(), {
    capabilities: { hermes: createHermesCapability({ hermes }) },
    messages: [{ role: 'user', content: 'Summarize the launch plan.' }],
  });
  assert.equal(calls, 2);
  assert.equal(result.outcome.verdict, 'success');
  assert.equal(result.outcome.attempts, 2);
  assert.equal(result.output, 'The product will launch in June.');
});

// --- 4. alternative → real new capability request -------------------------------

test('4: alternative reformulates the capability request, goal preserved', async () => {
  const seenMessages = [];
  const seenRequests = [];
  let calls = 0;
  const hermes = {
    chat: async (messages) => {
      calls += 1;
      seenMessages.push(JSON.stringify(messages));
      return calls === 1
        ? 'A fluent summary of unrelated events.'
        : 'The product will launch in June.';
    },
  };
  const inner = createHermesCapability({ hermes });
  const adapter = {
    id: 'hermes',
    invokeCapability: (request, options) => {
      seenRequests.push(request);
      return inner.invokeCapability(request, options);
    },
  };
  const result = await execute(hermesDecision(), {
    capabilities: { hermes: adapter },
    messages: [{ role: 'user', content: 'Summarize the launch plan.' }],
  });
  assert.equal(calls, 2);
  assert.equal(result.outcome.verdict, 'success');
  // The original goal is preserved; only the instruction gains an alternative note.
  assert.equal(seenRequests[0].instruction, 'Summarize the launch plan.');
  assert.ok(seenRequests[1].instruction.startsWith('Summarize the launch plan.'));
  assert.ok(seenRequests[1].instruction.includes('different approach'));
  assert.equal(seenRequests[1].objective, seenRequests[0].objective);
  assert.deepEqual(seenRequests[1].expected_outcome, seenRequests[0].expected_outcome);
  // The reformulation actually reaches Hermes as an appended note…
  assert.ok(!seenMessages[0].includes('different approach'));
  assert.ok(seenMessages[1].includes('different approach'));
  // …while the first payload is byte-for-byte the assembled turn.
  assert.ok(seenMessages[0].includes('Summarize the launch plan.'));
});

// --- 5. ask_user stops the path -------------------------------------------------

test('5: ask_user stops execution and returns to the user via clarify', async () => {
  let calls = 0;
  const hermes = {
    chat: async () => {
      calls += 1;
      return 'Could you clarify which launch date you mean?';
    },
  };
  const result = await execute(hermesDecision(), {
    capabilities: { hermes: createHermesCapability({ hermes }) },
    messages: [{ role: 'user', content: 'Summarize the launch plan.' }],
  });
  assert.equal(calls, 1); // no pointless retries once the user is needed
  assert.equal(result.action, 'clarify');
  assert.equal(result.output, null);
  assert.match(result.reason, /more information/i);
  assert.equal(result.outcome.verdict, 'ask_user');
});

// --- 6. max_attempts stops the real loop -----------------------------------------

test('6: max_attempts from the Decision caps the runtime loop', async () => {
  let calls = 0;
  const hermes = { chat: async () => { calls += 1; throw new Error('hermes unreachable'); } };
  const result = await execute(hermesDecision({ max_attempts: 3 }), {
    capabilities: { hermes: createHermesCapability({ hermes }) },
    messages: [{ role: 'user', content: 'Summarize the launch plan.' }],
  });
  assert.equal(calls, 3);
  assert.equal(result.outcome.attempts, 3);
  assert.equal(result.outcome.maxAttempts, 3);
  assert.equal(result.verdict, undefined); // ExecutionResult shape, not the loop shape
  assert.equal(result.outcome.verdict, 'failure');
});

// --- 7. exhaustion → honest failure -----------------------------------------------

test('7: exhausted runtime loop reports honest failure, never success', async () => {
  const hermes = { chat: async () => { throw new Error('hermes unreachable'); } };
  const result = await execute(hermesDecision({ max_attempts: 2 }), {
    capabilities: { hermes: createHermesCapability({ hermes }) },
    messages: [{ role: 'user', content: 'Summarize the launch plan.' }],
  });
  assert.equal(result.output, null);
  assert.match(result.error, /max_attempts=2/);
  assert.match(result.error, /not reached/i);
});

// --- 8. existing flows keep working -------------------------------------------------

test('8a: legacy invoke-only capability still succeeds through the runtime', async () => {
  const seen = [];
  const capabilities = {
    web: {
      invoke: async (messages, options) => {
        seen.push(options);
        return 'formatted web answer';
      },
    },
  };
  const result = await execute(
    { action: 'tool', capability: 'web', task: 'lookup', input: { userInput: 'news?' }, reason: 't' },
    { capabilities, messages: [{ role: 'user', content: 'news?' }] }
  );
  assert.equal(result.output, 'formatted web answer');
  assert.equal(result.outcome.verdict, 'success');
  // Legacy calling convention preserved through the bridge.
  assert.equal(seen[0].task, 'lookup');
  assert.deepEqual(seen[0].input, { userInput: 'news?' });
});

test('8b: decision without expected_outcome still succeeds (neutral default)', async () => {
  const result = await execute(
    { action: 'capability', capability: 'hermes', task: 'respond', input: {}, reason: 't' },
    {
      capabilities: { hermes: createHermesCapability({ hermes: { chat: async () => 'hello there' } }) },
      messages: [{ role: 'user', content: 'hi' }],
    }
  );
  assert.equal(result.output, 'hello there');
  assert.equal(result.outcome.verdict, 'success');
});

test('8c: plan with structured retrieval + native generation still works', async () => {
  const structured = { results: [{ text: 'passage one', relevance: 0.9 }], total: 1 };
  const capabilities = {
    conversation_search: { invoke: async () => structured },
    hermes: createHermesCapability({ hermes: { chat: async () => 'reasoned answer' } }),
  };
  const seenNative = [];
  const result = await execute(
    {
      action: 'plan',
      reason: 'test plan',
      steps: [
        { id: 'step-1', type: 'retrieval', capability: 'conversation_search', input: { query: 'juni', scope: 'current' } },
        { id: 'step-2', type: 'generation', mode: 'native', sources: ['step-1'] },
      ],
    },
    {
      capabilities,
      nativeGenerator: {
        generate: async (messages) => {
          seenNative.push(messages);
          return 'natively formulated';
        },
      },
      messages: [{ role: 'user', content: 'wat was er in juni?' }],
    }
  );
  assert.equal(result.output, 'natively formulated');
  // The structured retrieval payload survived the loop (data unwrap) and
  // reached native generation as formatted context.
  assert.ok(JSON.stringify(seenNative[0]).includes('passage one'));
});

test('8d: schema accepts expected_outcome and max_attempts on decisions and steps', () => {
  assert.equal(validateDecision(hermesDecision()), null);
  assert.match(
    validateDecision({ ...hermesDecision(), expected_outcome: 42 }),
    /expected_outcome/
  );
  assert.match(
    validateDecision({ ...hermesDecision(), max_attempts: 'many' }),
    /max_attempts/
  );
});

// --- 9. no Hermes-specific contract logic outside the adapter ------------------------

test('9: Logos contract, loop, bridge and orchestrator hold no Hermes-specific logic', () => {
  // Translation/interface logic only — the contract's generic forbidden-field
  // vocabulary (model/provider/baseUrl/…) is deliberately NOT in this
  // pattern: naming what the contract refuses is not Hermes logic.
  const hermesSpecific = /Use the Hermes skill|HERMES_BASE_URL|reasoning_content|hermes\.chat|hermes\.stream|require\(['"][^'"]*hermes/i;
  for (const file of [
    '../src/logos/capabilityContract.js',
    '../src/logos/capabilityLoop.js',
    '../src/capabilities/legacyBridge.js',
    '../src/orchestration/orchestrator.js',
    '../src/decision/decisionSchema.js',
    '../src/decision/decisionEngine.js',
  ]) {
    assert.ok(!hermesSpecific.test(codeOf(file)), `${file} must not contain Hermes-specific logic`);
  }
  // And the old direct route is gone from the orchestrator: capability
  // results can no longer bypass outcome evaluation.
  const orchestrator = codeOf('../src/orchestration/orchestrator.js');
  assert.ok(!/capability\.invoke\s*\(|entry\.invoke\s*\(|cap\.invoke\s*\(/.test(orchestrator),
    'orchestrator must not call capability.invoke directly');
  assert.ok(/runCapabilityLoop/.test(orchestrator), 'orchestrator must run the P0 loop');
});

// --- 10. the adapter is the single translation site ------------------------------------

test('10: Hermes translation lives only in the Hermes adapter', () => {
  const adapter = codeOf('../src/capabilities/hermesAdapter.js');
  assert.ok(/\.chat\s*\(/.test(adapter), 'adapter translates to the Hermes chat interface');
  assert.ok(/\.stream\s*\(/.test(adapter), 'adapter translates to the Hermes stream interface');
  assert.ok(/Use the Hermes skill/.test(adapter), 'adapter owns the skill instruction');

  // turn.js wires the adapter but translates nothing itself anymore.
  const turn = codeOf('../src/turn.js');
  assert.ok(/createHermesCapability/.test(turn), 'turn.js runs Hermes behind its adapter');
  assert.ok(!/Use the Hermes skill/.test(turn), 'turn.js must not duplicate the skill instruction');
  assert.ok(!/hermes\.chat|hermes\.stream/.test(turn), 'turn.js must not call the Hermes interface directly');
});
