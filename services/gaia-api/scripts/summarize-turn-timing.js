#!/usr/bin/env node
'use strict';

/**
 * Summarize `turn.done` latency events from a gaia-api log.
 *
 * Usage:
 *   node scripts/summarize-turn-timing.js <logfile> [--last N]
 *   <some log source> | node scripts/summarize-turn-timing.js [--last N]
 *
 * Reads the JSON lines emitted by src/timing.js (kind "gaia.timing"). Lines
 * may carry a prefix (timestamps, container names); the first `{` onwards is
 * parsed and anything that is not a turn.done event is ignored.
 *
 * A `reasoning_background` event (deferred deep reasoning, logged after the
 * reply) is summarized on a separate line, since it is outside turn.done.
 *
 * Output: per-stage count / mean / p50 / p95 / max plus each stage's share of
 * the mean total, so it is clear whether the time sits in Logos (intent,
 * retrieval, reasoning, decision) or in the final generator (capability).
 */

const fs = require('node:fs');

const STAGES = [
  ['intentMs', 'intent'],
  ['retrievalMs', 'retrieval'],
  ['reasoningMs', 'reasoning'],
  ['decisionMs', 'decision'],
  ['capabilityMs', 'capability'],
];

function parseTurnDone(text) {
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    const start = line.indexOf('{');
    if (start === -1 || !line.includes('turn.done')) continue;
    try {
      const e = JSON.parse(line.slice(start));
      if (e && e.kind === 'gaia.timing' && e.stage === 'turn.done') events.push(e);
    } catch (_) { /* not a JSON line */ }
  }
  return events;
}

// Deferred deep reasoning runs AFTER the reply (turn.js), so it is not part of
// any turn.done total; it is reported on its own line.
function parseBackgroundReasoning(text) {
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    const start = line.indexOf('{');
    if (start === -1 || !line.includes('reasoning_background')) continue;
    try {
      const e = JSON.parse(line.slice(start));
      if (e && e.kind === 'gaia.timing' && e.stage === 'reasoning_background') events.push(e);
    } catch (_) { /* not a JSON line */ }
  }
  return events;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function stats(values) {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const sum = nums.reduce((a, b) => a + b, 0);
  return {
    count: nums.length,
    mean: sum / nums.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1],
  };
}

function summarize(events) {
  const total = stats(events.map((e) => e.totalDurationMs));
  const rows = STAGES.map(([field, label]) => {
    const s = stats(events.map((e) => e[field]));
    // Share of all wall-clock time across the sampled turns (a stage skipped
    // in some turns counts as 0 there, unlike its per-run mean).
    const stageSum = s ? s.mean * s.count : 0;
    return { label, stats: s, share: s && total ? stageSum / (total.mean * total.count) : null };
  });

  // Per-capability breakdown (capability.X events summarized by turn.js).
  const byCapability = new Map();
  for (const e of events) {
    for (const c of Array.isArray(e.capabilities) ? e.capabilities : []) {
      if (!c || !c.name) continue;
      if (!byCapability.has(c.name)) byCapability.set(c.name, []);
      byCapability.get(c.name).push(c.durationMs);
    }
  }
  const capabilities = [...byCapability.entries()]
    .map(([name, values]) => ({ name, stats: stats(values) }))
    .filter((c) => c.stats)
    .sort((a, b) => b.stats.mean - a.stats.mean);

  return { turns: events.length, total, rows, capabilities };
}

const fmt = (n) => (n === null || n === undefined ? '-' : Math.round(n).toString());
const pct = (n) => (n === null || n === undefined ? '-' : `${Math.round(n * 100)}%`);

function render(summary, background = null) {
  const out = [];
  out.push(`Turns: ${summary.turns}`);
  const header = ['stage', 'n', 'mean', 'p50', 'p95', 'max', 'share'];
  const table = [header];
  const add = (label, s, share) => table.push([
    label, s ? s.count : 0, fmt(s && s.mean), fmt(s && s.p50), fmt(s && s.p95), fmt(s && s.max), pct(share),
  ]);
  for (const r of summary.rows) add(r.label, r.stats, r.share);
  add('TOTAL', summary.total, summary.total ? 1 : null);

  const widths = header.map((_, i) => Math.max(...table.map((r) => String(r[i]).length)));
  for (const [ri, row] of table.entries()) {
    out.push(row.map((cell, i) => (i === 0 ? String(cell).padEnd(widths[i]) : String(cell).padStart(widths[i]))).join('  '));
    if (ri === 0) out.push(widths.map((w) => '-'.repeat(w)).join('  '));
  }
  out.push('(ms; share = stage time / total time over all turns; mean/p50/p95 only cover turns where the stage ran)');

  if (background) {
    out.push('', `Deep reasoning in background, after the reply (not in TOTAL): n=${background.count} mean=${fmt(background.mean)} p95=${fmt(background.p95)} max=${fmt(background.max)} ms`);
  }

  if (summary.capabilities.length > 0) {
    out.push('', 'Capabilities (ms):');
    for (const c of summary.capabilities) {
      out.push(`  ${c.name}: n=${c.stats.count} mean=${fmt(c.stats.mean)} p95=${fmt(c.stats.p95)} max=${fmt(c.stats.max)}`);
    }
  }
  return out.join('\n');
}

function main(argv) {
  const args = argv.slice(2);
  let last = null;
  let file = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--last') last = Number(args[++i]);
    else file = args[i];
  }
  if (last !== null && !(last > 0)) {
    console.error('--last expects a positive number');
    process.exit(2);
  }

  let text;
  try {
    text = fs.readFileSync(file || 0, 'utf8');
  } catch (err) {
    console.error(`Could not read ${file || 'stdin'}: ${err.message}`);
    process.exit(2);
  }

  let events = parseTurnDone(text);
  if (last) events = events.slice(-last);
  if (events.length === 0) {
    console.error('No turn.done events found.');
    process.exit(1);
  }
  const background = stats(parseBackgroundReasoning(text).map((e) => e.durationMs));
  console.log(render(summarize(events), background));
}

if (require.main === module) main(process.argv);

module.exports = { parseTurnDone, parseBackgroundReasoning, summarize, render };
