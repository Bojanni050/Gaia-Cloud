'use strict';

/**
 * Memoryworthiness 0.1 — live-path validation (spec §19).
 *
 * Runs the seven specified turns through the REAL performStreamingTurn with
 * a capturing fake Hindsight, and reports per turn: memory action, score,
 * reasons, Hindsight retain yes/no, and evaluation latency. The real
 * Hindsight deployment is unreachable from this machine, so the retain
 * transport is asserted against the captured reflect() calls — the exact
 * seam hindsightClient.reflect uses in production.
 */

const { performStreamingTurn } = require('../src/turn');

function makeHarness() {
  const reflects = [];
  const logs = [];
  return {
    logs,
    reflects,
    hindsight: { recall: async () => [], reflect: async (item) => { reflects.push(item); } },
  };
}

async function turn(harness, text) {
  const origLog = console.log;
  const logs = [];
  console.log = (l) => {
    try {
      const p = JSON.parse(l);
      if (p.kind === 'memory.worthiness') logs.push(p);
    } catch (_) {}
  };
  const before = harness.reflects.length;
  try {
    await performStreamingTurn({
      messages: [{ role: 'user', content: text }],
      documents: {},
      hermes: { stream: async (m, { onDelta }) => { onDelta('...antwoord...', false); return '...antwoord...'; } },
      hindsight: harness.hindsight,
      res: { writeHead() {}, write() {}, end() {}, status() { return this; }, json() {} },
      intentIQ: () => ({ schemaVersion: 'intentiq.v1', intent: 'converse', status: 'accepted', entities: [] }),
      reasonIQ: async () => ({}),
    });
  } finally {
    console.log = origLog;
  }
  harness.logs.push(...logs);
  const decision = logs[0] || null;
  const retained = harness.reflects.length > before;
  return { decision, retained };
}

async function main() {
  const harness = makeHarness();
  const turns = [
    'Hoi Gaia',
    'Ja precies.',
    'Ik wil voortaan dat je minder uitweidt.',
    'Ik ben volgende maand drie weken vrij.',
    'Onthoud dat ik liever korte meetings heb.',
    'Dat klopt trouwens niet meer.',
    "Oké, ik ga koffie halen.",
  ];

  console.log('Memoryworthiness 0.1 — live-path validation (real turn pipeline)\n');
  for (const t of turns) {
    const { decision, retained } = await turn(harness, t);
    if (!decision) {
      console.log(`"${t}"\n   action=none (gate/evaluation skipped)  retained=${retained}\n`);
      continue;
    }
    console.log(`"${t}"`);
    console.log(`   action=${decision.action}  score=${decision.score}  latency=${decision.latencyMs}ms  retained=${retained}`);
    console.log(`   reasons=${JSON.stringify(decision.reasons)}\n`);
  }
  // Invariant check: what actually landed in Hindsight.
  console.log(`Hindsight reflections received: ${harness.reflects.length} of ${turns.length} turns`);
  for (const r of harness.reflects) {
    const meta = r.metadata || {};
    console.log(`   - decision=${meta.gaia_memory_decision} priority=${meta.gaia_memory_priority}`);
  }
  const allTagged = harness.reflects.every((r) => r.metadata && r.metadata.gaia_memory_decision);
  console.log(allTagged ? '\nAll retains carry gaia_memory_* metadata ✓' : '\nMISSING METADATA ✗');
}

main().catch((e) => { console.error(e); process.exit(1); });
