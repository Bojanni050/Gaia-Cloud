'use strict';

/**
 * Memoryworthiness evaluation (spec §18).
 *
 * Usage:
 *   node eval/run-memoryworthiness.js          (or: npm run eval:memory)
 *     Deterministic gate only — model-free, zero LLM calls.
 *
 *   node eval/run-memoryworthiness.js --llm    (or: npm run eval:memory -- --llm)
 *     ALSO runs the optional LLM judge (memoryWorthinessLlm.js, mode `llm`) over
 *     the same cases and prints both side by side, plus every disagreement. Needs
 *     MEMORY_WORTHINESS_MODEL_BASE_URL/NAME (or REASONIQ_MODEL_*) in the env; the
 *     judge is scored binary (retain-ish vs discard) because that is all it
 *     answers. Cases with a `reply` are judged on the completed turn.
 *
 * Reports retain accuracy, discard accuracy, false-retain, false-discard and
 * low-priority rate. The heuristic's semantic-call rate is structurally 0.
 */

const { evaluateMemoryWorthiness } = require('../src/memoryWorthiness');
const { createMemoryWorthinessJudge } = require('../src/memoryWorthinessLlm');
const { createLogosModelClient } = require('../src/logos/logosModelClient');
const { resolveRoleConfig } = require('../src/providerConfigResolver');
const { CASES } = require('./memoryworthiness-cases');

const pct = (n, d) => (d === 0 ? 'n/a' : (n / d).toFixed(3));

function runHeuristic() {
  let correct = 0;
  let retainExpected = 0; let retainCorrect = 0;
  let discardExpected = 0; let discardCorrect = 0;
  let lowPriorityExpected = 0; let lowPriorityCorrect = 0;
  let falseRetain = []; let falseDiscard = [];
  const latencies = [];
  const decisions = new Map();

  for (const c of CASES) {
    const start = process.hrtime.bigint();
    const d = evaluateMemoryWorthiness({
      userInput: c.input,
      assistantReply: c.reply,
      intent: c.intent || null,
      existingMemorySignals: c.existing || null,
    });
    latencies.push(Number(process.hrtime.bigint() - start) / 1e6);
    decisions.set(c.id, d);

    const ok = d.action === c.expected;
    if (ok) correct += 1;
    if (c.expected === 'retain') { retainExpected += 1; if (ok) retainCorrect += 1; }
    else if (c.expected === 'discard') { discardExpected += 1; if (ok) discardCorrect += 1; }
    else { lowPriorityExpected += 1; if (ok) lowPriorityCorrect += 1; }

    // False-retain: worthless turn kept as important memory.
    if (c.expected === 'discard' && d.action !== 'discard') {
      falseRetain.push({ id: c.id, category: c.category, input: c.input, got: `${d.action}(${d.score})` });
    }
    // False-discard: meaningful personal information lost entirely.
    if ((c.expected === 'retain' || c.expected === 'retain_low_priority') && d.action === 'discard') {
      falseDiscard.push({ id: c.id, category: c.category, input: c.input, expected: c.expected });
    }
  }

  console.log('Memoryworthiness evaluation — deterministic gate (no model involved)\n');
  console.log(`cases:                 ${CASES.length} (${CASES.filter((c) => c.reply).length} with a reply)`);
  console.log(`accuracy:              ${pct(correct, CASES.length)}`);
  console.log(`retain accuracy:       ${pct(retainCorrect, retainExpected)} (${retainCorrect}/${retainExpected})`);
  console.log(`discard accuracy:      ${pct(discardCorrect, discardExpected)} (${discardCorrect}/${discardExpected})`);
  console.log(`low-priority accuracy: ${pct(lowPriorityCorrect, lowPriorityExpected)} (${lowPriorityCorrect}/${lowPriorityExpected})`);
  console.log(`false-retain:          ${falseRetain.length}`);
  console.log(`false-discard:         ${falseDiscard.length}`);
  console.log('semantic-call rate:    0.000 (structurally zero — deterministic module)');
  console.log(`avg latency per check: ${(latencies.reduce((s, l) => s + l, 0) / latencies.length).toFixed(4)}ms`);

  if (falseRetain.length) {
    console.log('\nfalse-retains:');
    for (const f of falseRetain) console.log(`  [${f.id}] ${f.category}: "${f.input}" -> ${f.got}`);
  }
  if (falseDiscard.length) {
    console.log('\nfalse-discards:');
    for (const f of falseDiscard) console.log(`  [${f.id}] ${f.category}: "${f.input}" (expected ${f.expected})`);
  }

  const pass = correct === CASES.length;
  console.log(`\n${pass ? 'ALL CASES PASS' : `accuracy ${(correct / CASES.length).toFixed(3)} — see misses above`}`);
  return { pass, decisions };
}

async function runLlm(heuristicDecisions) {
  const cfg = resolveRoleConfig('memory', null, process.env) || resolveRoleConfig('reasoning', null, process.env);
  if (!cfg || !cfg.baseUrl || !cfg.model) {
    console.log('\n--llm: no model configured (set MEMORY_WORTHINESS_MODEL_BASE_URL/NAME or REASONIQ_MODEL_*). Skipping.');
    return;
  }
  const timeoutMs = Number(process.env.MEMORY_WORTHINESS_TIMEOUT_MS) || 5000;
  const model = createLogosModelClient({ ...cfg, timeoutMs, logSystem: 'memory', logPurpose: 'worthiness' });
  const judge = createMemoryWorthinessJudge({ mode: 'llm', getModel: () => model });

  let heuristicOk = 0; let llmOk = 0; let llmCalls = 0; let fellBack = 0;
  const llmFalseDiscard = []; const llmFalseRetain = []; const disagreements = [];
  const lines = [];

  for (const c of CASES) {
    const h = heuristicDecisions.get(c.id);
    const d = await judge.decide({
      heuristicDecision: h,
      userText: c.input,
      replyText: c.reply || '',
      recalledReflections: (c.existing && c.existing.recalledReflections) || [],
      logger: (l) => lines.push(l),
    });
    const want = c.expected === 'discard' ? 'discard' : 'keep';
    const gotH = h.action === 'discard' ? 'discard' : 'keep';
    const gotL = d.action === 'discard' ? 'discard' : 'keep';
    if (gotH === want) heuristicOk += 1;
    if (gotL === want) llmOk += 1;
    if (d.decider === 'llm') llmCalls += 1;
    else if (lines.some((l) => l.includes('llm_failed'))) fellBack += 1;
    if (want === 'keep' && gotL === 'discard') llmFalseDiscard.push(c);
    if (want === 'discard' && gotL === 'keep') llmFalseRetain.push(c);
    if (gotH !== gotL) disagreements.push({ c, heuristic: h.action, llm: d.action, reason: d.reasons[0] });
    lines.length = 0;
  }

  console.log(`\n--- LLM judge (${cfg.model}) vs heuristic, binary keep/discard ---`);
  console.log(`heuristic accuracy:    ${pct(heuristicOk, CASES.length)}`);
  console.log(`llm-mode accuracy:     ${pct(llmOk, CASES.length)}   (model asked on ${llmCalls}/${CASES.length}; the rest settled by the deterministic pre-checks)`);
  console.log(`llm false-discard:     ${llmFalseDiscard.length}`);
  console.log(`llm false-retain:      ${llmFalseRetain.length}`);
  console.log(`llm fell back:         ${fellBack}`);
  if (disagreements.length) {
    console.log('\ndisagreements (heuristic vs llm):');
    for (const x of disagreements) {
      console.log(`  [${x.c.id}] expected ${x.c.expected}: heuristic=${x.heuristic} llm=${x.llm} — ${x.reason}`);
    }
  }
}

async function main() {
  const { pass, decisions } = runHeuristic();
  if (process.argv.includes('--llm')) await runLlm(decisions);
  process.exitCode = pass ? 0 : 1;
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
