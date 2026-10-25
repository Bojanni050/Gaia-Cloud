#!/usr/bin/env node
'use strict';

/**
 * Summarize `logos.gate` decisions from the Logos decision log — the cost
 * monitor for the depth gate.
 *
 * Since 2026-10-25 the social filter IS the default gate
 * (src/logos/logos.js): every non-social turn is `deep` and costs one
 * background reasoning call after the reply; every social turn (greeting,
 * thanks, ack, farewell — src/logos/socialFilter.js) is `shallow` and
 * costs nothing. This reports how often each happened, per UTC hour and
 * per reason, so "what does the default gate cost per hour" is a number
 * instead of a guess. With the legacy gate (GAIA_LOGOS_SOCIAL_GATE=off)
 * the reasons are no_evidence / context_only_intent / ambiguous_intent /
 * unknown_intent instead of social_turn.
 *
 * Usage:
 *   node scripts/summarize-logos-gate.js [file|dir] [--last N]
 *   node scripts/summarize-logos-gate.js            # the decision-log dir
 *   <some log source> | node scripts/summarize-logos-gate.js -
 *
 * With no argument the decision-log directory is read
 * (LOGOS_DECISIONS_PATH, default ./data/logos-decisions in dev,
 * /app/data/logos-decisions in a container — same resolution as
 * src/logos/decisionStore.js): every YYYY-MM-DD.jsonl file, in day order.
 * A file argument reads one JSONL file (lines may carry a prefix; the
 * first `{` onwards is parsed and anything that is not a logos.gate
 * record is ignored). `-` reads stdin.
 *
 * Output: per-hour turns, deep/shallow counts and the deep rate (deep
 * turns are the model calls), the reasons behind each, and a total with
 * a per-reason breakdown.
 */

const fs = require('node:fs');
const path = require('node:path');
const { resolveDecisionsDir } = require('../src/logos/decisionStore');

function parseGateRecords(text) {
  const records = [];
  for (const line of text.split(/\r?\n/)) {
    const start = line.indexOf('{');
    if (start === -1 || !line.includes('logos.gate')) continue;
    try {
      const e = JSON.parse(line.slice(start));
      if (e && e.kind === 'logos.gate' && e.depth && e.timestamp) records.push(e);
    } catch (_) { /* not a JSON line */ }
  }
  return records;
}

function hourKey(timestamp) {
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return 'unknown';
  return `${d.toISOString().slice(0, 13)}:00Z`; // YYYY-MM-DDTHH:00Z (UTC)
}

function summarize(records) {
  const byHour = new Map();
  const byReason = new Map();
  let deep = 0;
  let shallow = 0;

  for (const r of records) {
    const hour = hourKey(r.timestamp);
    if (!byHour.has(hour)) {
      byHour.set(hour, { hour, turns: 0, deep: 0, shallow: 0, byReason: new Map() });
    }
    const h = byHour.get(hour);
    h.turns += 1;
    if (r.depth === 'deep') { h.deep += 1; deep += 1; } else { h.shallow += 1; shallow += 1; }

    const reason = typeof r.reason === 'string' && r.reason ? r.reason : 'unknown';
    h.byReason.set(reason, (h.byReason.get(reason) || 0) + 1);
    byReason.set(reason, (byReason.get(reason) || 0) + 1);
  }

  const hours = [...byHour.values()].sort((a, b) => (a.hour < b.hour ? -1 : a.hour > b.hour ? 1 : 0));
  return { turns: records.length, deep, shallow, hours, byReason };
}

const pct = (part, whole) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : '-');

function render(summary) {
  const out = [];
  const first = summary.hours[0];
  const last = summary.hours[summary.hours.length - 1];
  out.push(`Logos gate decisions: ${summary.turns} turns${first ? `, ${first.hour} .. ${last.hour}` : ''}`);
  out.push('');

  if (summary.hours.length > 0) {
    // Reasons seen anywhere, most frequent first — unknown reasons still show.
    const reasons = [...summary.byReason.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .map(([r]) => r);

    const header = ['hour', 'turns', 'deep', 'shallow', 'deep%', ...reasons];
    const table = [header];
    for (const h of summary.hours) {
      table.push([
        h.hour,
        String(h.turns),
        String(h.deep),
        String(h.shallow),
        pct(h.deep, h.turns),
        ...reasons.map((r) => String(h.byReason.get(r) || 0)),
      ]);
    }
    table.push([
      'TOTAL',
      String(summary.turns),
      String(summary.deep),
      String(summary.shallow),
      pct(summary.deep, summary.turns),
      ...reasons.map((r) => String(summary.byReason.get(r) || 0)),
    ]);

    const widths = header.map((_, i) => Math.max(...table.map((r) => String(r[i]).length)));
    for (const [ri, row] of table.entries()) {
      out.push(row.map((cell, i) => (i === 0 ? String(cell).padEnd(widths[i]) : String(cell).padStart(widths[i]))).join('  '));
      if (ri === 0) out.push(widths.map((w) => '-'.repeat(w)).join('  '));
    }
    out.push('(deep% = share of turns that cost one background reasoning call; reason columns count turns per gate reason)');
  }

  out.push('');
  out.push(`Total: ${summary.turns} turns — deep ${summary.deep} (${pct(summary.deep, summary.turns)}), shallow ${summary.shallow} (${pct(summary.shallow, summary.turns)})`);
  if (summary.byReason.size > 0) {
    out.push('By reason:');
    const reasons = [...summary.byReason.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    for (const [reason, count] of reasons) {
      out.push(`  ${reason.padEnd(20)} ${String(count).padStart(6)}  ${pct(count, summary.turns)}`);
    }
  }
  return out.join('\n');
}

function readInput(file) {
  if (file === '-') return fs.readFileSync(0, 'utf8');
  const stat = fs.statSync(file);
  if (stat.isDirectory()) {
    const files = fs
      .readdirSync(file)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .sort(); // day order = chronological
    return files.map((f) => fs.readFileSync(path.join(file, f), 'utf-8')).join('\n');
  }
  return fs.readFileSync(file, 'utf8');
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
    text = readInput(file || resolveDecisionsDir());
  } catch (err) {
    console.error(`Could not read ${file || 'the decision-log directory'}: ${err.message}`);
    process.exit(2);
  }

  let records = parseGateRecords(text);
  if (last) records = records.slice(-last);
  if (records.length === 0) {
    console.error('No logos.gate records found.');
    process.exit(1);
  }
  console.log(render(summarize(records)));
}

if (require.main === module) main(process.argv);

module.exports = { parseGateRecords, summarize, render };
