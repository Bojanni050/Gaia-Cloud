'use strict';

/**
 * Memoryworthiness LLM judge — mode handling, deterministic pre-checks,
 * binary verdicts, fallback invariant, non-blocking sampled shadow.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseMode,
  parseVerdict,
  createMemoryWorthinessJudge,
  judgeMemoryWorthiness,
} = require('../src/memoryWorthinessLlm');
const { evaluateMemoryWorthiness, metadataForMemoryDecision, applyCapabilityOutcomeOverride } = require('../src/memoryWorthiness');

const modelReturning = (text) => ({ calls: 0, async chat() { this.calls += 1; return text; } });
const verdict = (action, reason = 'reden') => JSON.stringify({ action, reason });

function turn(userText, replyText = 'Prima, genoteerd.') {
  const heuristicDecision = evaluateMemoryWorthiness({ userInput: userText, assistantReply: replyText });
  return { heuristicDecision, userText, replyText, recalledReflections: [] };
}

// A turn the heuristic has no lexical hook for, but which carries substance.
const MIDBAND = 'De klant belde terug en het contract tekent pas na de zomer, dus de oplevering schuift op.';

test('parseMode: unknown/empty ⇒ heuristic (the safe default)', () => {
  assert.equal(parseMode(undefined), 'heuristic');
  assert.equal(parseMode('nonsense'), 'heuristic');
  assert.equal(parseMode(' LLM '), 'llm');
  assert.equal(parseMode('shadow'), 'shadow');
});

test('heuristic mode builds no judge at all', () => {
  assert.equal(createMemoryWorthinessJudge({ mode: 'heuristic', getModel: () => modelReturning(verdict('retain')) }), null);
  assert.equal(createMemoryWorthinessJudge({}), null);
});

test('parseVerdict: binary only, strict JSON', () => {
  assert.deepEqual(parseVerdict(verdict('retain', 'duurzaam feit')), { action: 'retain', reason: 'duurzaam feit' });
  assert.equal(parseVerdict(verdict('DISCARD')).action, 'discard');
  assert.throws(() => parseVerdict('geen json'), (e) => e.code === 'parse');
  assert.throws(() => parseVerdict(verdict('retain_low_priority')), (e) => e.code === 'invalid_action');
  assert.throws(() => parseVerdict('{"reason":"x"}'), (e) => e.code === 'invalid_action');
});

test('llm mode: model verdict maps to MemoryDecision shape (score, empty dimensions, decider)', async () => {
  const judge = createMemoryWorthinessJudge({ mode: 'llm', getModel: () => modelReturning(verdict('retain', 'planning verschuift')) });
  const d = await judge.decide(turn(MIDBAND));
  assert.equal(d.action, 'retain');
  assert.equal(d.score, 1);
  assert.deepEqual(d.dimensions, {});
  assert.equal(d.decider, 'llm');
  assert.match(d.reasons[0], /^llm:planning verschuift/);
  assert.equal(metadataForMemoryDecision(d).gaia_memory_decider, 'llm');
  assert.equal(metadataForMemoryDecision(d).gaia_memory_priority, 'normal');
});

test('llm mode: a deliberate model discard is the one route to no reflection', async () => {
  const judge = createMemoryWorthinessJudge({ mode: 'llm', getModel: () => modelReturning(verdict('discard', 'niets blijvends')) });
  const d = await judge.decide(turn(MIDBAND));
  assert.equal(d.action, 'discard');
  assert.equal(d.score, 0);
});

test('llm mode: explicit memory requests never reach the model', async () => {
  const model = modelReturning(verdict('discard'));
  const judge = createMemoryWorthinessJudge({ mode: 'llm', getModel: () => model });
  const d = await judge.decide(turn('Onthoud dat ik maandag altijd laat werk.'));
  assert.equal(model.calls, 0);
  assert.equal(d.action, 'retain');
  assert.equal(d.decider, 'heuristic');
});

test('llm mode: corrections never reach the model', async () => {
  const model = modelReturning(verdict('discard'));
  const judge = createMemoryWorthinessJudge({ mode: 'llm', getModel: () => model });
  const d = await judge.decide(turn('Nee, dat klopt niet meer.'));
  assert.equal(model.calls, 0);
  assert.equal(d.action, 'retain');
});

test('llm mode: duplicates and pure acknowledgements stay with the heuristic, no model call', async () => {
  const model = modelReturning(verdict('retain'));
  const judge = createMemoryWorthinessJudge({ mode: 'llm', getModel: () => model });
  const ack = await judge.decide(turn('Ja precies.'));
  assert.equal(ack.action, 'discard');
  const dupInput = turn('Ik heb liever korte antwoorden.');
  dupInput.recalledReflections = [{ text: 'Bo heeft liever korte antwoorden' }];
  dupInput.heuristicDecision = evaluateMemoryWorthiness({
    userInput: dupInput.userText,
    assistantReply: dupInput.replyText,
    existingMemorySignals: { recalledReflections: dupInput.recalledReflections },
  });
  assert.ok(dupInput.heuristicDecision.reasons.some((r) => r === 'duplicate_downgrade'));
  await judge.decide(dupInput);
  assert.equal(model.calls, 0);
});

for (const [label, model] of [
  ['model error', { async chat() { throw new Error('logos model responded with an error'); } }],
  ['timeout', { async chat() { throw new Error('timeout'); } }],
  ['unparsable answer', modelReturning('hallo')],
  ['invalid action', modelReturning(verdict('maybe'))],
]) {
  test(`llm mode: ${label} falls back to the heuristic (never null) and logs llm_failed`, async () => {
    const lines = [];
    const judge = createMemoryWorthinessJudge({ mode: 'llm', getModel: () => model });
    const input = { ...turn(MIDBAND), logger: (l) => lines.push(JSON.parse(l)) };
    const d = await judge.decide(input);
    assert.ok(d, 'must not degrade to null');
    assert.equal(d.action, input.heuristicDecision.action);
    assert.equal(d.decider, 'heuristic');
    const failed = lines.find((l) => l.kind === 'memory.worthiness.llm_failed');
    assert.ok(failed);
    assert.ok(failed.reason);
  });
}

test('llm mode: no model configured at all falls back to the heuristic and logs', async () => {
  const lines = [];
  const judge = createMemoryWorthinessJudge({ mode: 'llm', getModel: () => null });
  const d = await judge.decide({ ...turn(MIDBAND), logger: (l) => lines.push(JSON.parse(l)) });
  assert.ok(d);
  assert.equal(d.decider, 'heuristic');
  assert.equal(lines[0].kind, 'memory.worthiness.llm_failed');
  assert.equal(lines[0].reason, 'not_configured');
});

test('capability-outcome override keeps the decider', () => {
  const d = applyCapabilityOutcomeOverride(
    { action: 'discard', score: 0, reasons: ['llm:x'], dimensions: {}, decider: 'llm' },
    { outcome: { verdict: 'failure' } },
  );
  assert.equal(d.action, 'retain');
  assert.equal(d.decider, 'llm');
});

test('shadow mode: heuristic decides, the model never delays the chain, 1-in-N sampled', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const model = { calls: 0, async chat() { this.calls += 1; await gate; return verdict('retain', 'verschil'); } };
  const lines = [];
  const judge = createMemoryWorthinessJudge({ mode: 'shadow', getModel: () => model, shadowEvery: 2 });
  const input = { ...turn(MIDBAND), logger: (l) => lines.push(JSON.parse(l)) };

  const d1 = await judge.decide(input); // turn 1 — not sampled
  assert.equal(model.calls, 0);
  assert.equal(d1.action, input.heuristicDecision.action);

  const d2 = await judge.decide(input); // turn 2 — sampled; resolves while the model is still pending
  assert.equal(model.calls, 1);
  assert.equal(d2.action, input.heuristicDecision.action);
  assert.equal(d2.decider, 'heuristic');
  assert.equal(lines.filter((l) => l.kind === 'memory.worthiness.shadow').length, 0);

  release();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  const shadow = lines.find((l) => l.kind === 'memory.worthiness.shadow');
  assert.ok(shadow);
  assert.equal(shadow.llm, 'retain');
  assert.equal(typeof shadow.agree, 'boolean');
  assert.equal(JSON.stringify(shadow).includes('contract'), false, 'shadow logs carry no user content');
});

test('shadow mode: a failing model is logged and never throws into the turn', async () => {
  const lines = [];
  const judge = createMemoryWorthinessJudge({
    mode: 'shadow',
    shadowEvery: 1,
    getModel: () => ({ async chat() { throw new Error('boom'); } }),
  });
  const input = { ...turn(MIDBAND), logger: (l) => lines.push(JSON.parse(l)) };
  const d = await judge.decide(input);
  assert.equal(d.action, input.heuristicDecision.action);
  await new Promise((r) => setImmediate(r));
  assert.ok(lines.some((l) => l.kind === 'memory.worthiness.llm_failed'));
});

test('judgeMemoryWorthiness: prompt carries the turn, recalled memories and treats the turn as data', async () => {
  let seen;
  const model = { async chat(messages) { seen = messages; return verdict('discard'); } };
  await judgeMemoryWorthiness({
    model,
    userText: 'Hoi',
    replyText: 'Dag Bo',
    recalledReflections: [{ text: 'Bo woont in Groningen' }],
  });
  assert.equal(seen[0].role, 'system');
  assert.match(seen[0].content, /NORMALE antwoord/);
  assert.match(seen[1].content, /Bo woont in Groningen/);
  assert.match(seen[1].content, /<beurt>[\s\S]*Bo: Hoi[\s\S]*Gaia: Dag Bo[\s\S]*<\/beurt>/);
});
