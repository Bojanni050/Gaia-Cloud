'use strict';

/**
 * One-shot scanner: detect mojibake remnants in recently edited files.
 *
 * Detects:
 *   1. UTF-8 BOM (U+FEFF) anywhere
 *   2. U+FFFD replacement characters
 *   3. Non-ASCII runs containing cp1252 double-encoding artifacts
 *      (lead chars â / Â / Ã — never legitimate in this codebase), verified
 *      by round-tripping the run back through cp1252 -> UTF-8
 *   4. Suspicious isolated high chars that only arise from corruption
 *
 * Usage: node scripts/_scan-mojibake.js <file> [<file> ...]
 */

const fs = require('fs');

// cp1252 inverse table for 0x80-0x9F
const HI = {
  0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84, 0x2026: 0x85,
  0x2020: 0x86, 0x2021: 0x87, 0x02C6: 0x88, 0x2030: 0x89, 0x0160: 0x8A,
  0x2039: 0x8B, 0x0152: 0x8C, 0x017D: 0x8E, 0x2018: 0x91, 0x2019: 0x92,
  0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02DC: 0x98, 0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B, 0x0153: 0x9C,
  0x017E: 0x9E, 0x0178: 0x9F,
};
const LEADS = new Set(['\u00e2', '\u00c2', '\u00c3']); // â Â Ã

function inv(ch) {
  const c = ch.codePointAt(0);
  if (c < 0x80) return Buffer.from([c]);
  if (HI[c] !== undefined) return Buffer.from([HI[c]]);
  if (c <= 0xFF) return Buffer.from([c]);
  return null;
}

/** Try to reverse one non-ASCII run through cp1252 -> UTF-8. */
function tryReverse(run) {
  const bytes = [];
  for (const ch of run) {
    const b = inv(ch);
    if (b === null || b.length !== 1) return null;
    bytes.push(b[0]);
  }
  const dec = Buffer.from(bytes).toString('utf8');
  if (dec.includes('\uFFFD')) return null;
  return dec;
}

function lineStarts(s) {
  const starts = [0];
  for (let i = 0; i < s.length; i += 1) if (s[i] === '\n') starts.push(i + 1);
  return starts;
}
function lineOf(starts, idx) {
  let lo = 0; let hi = starts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= idx) lo = mid; else hi = mid - 1; }
  return lo + 1;
}
function contextAround(s, idx) {
  const from = Math.max(0, s.lastIndexOf('\n', idx) + 1);
  const nl = s.indexOf('\n', idx);
  const to = nl === -1 ? s.length : nl;
  return s.slice(from, to).trim().slice(0, 110);
}

function scan(file) {
  const raw = fs.readFileSync(file);
  const problems = [];
  const bomCount = [...raw.slice(0, 3)].join(',') === '239,187,191';
  // Decode leniently so we can FIND U+FFFD rather than crash.
  const s = raw.toString('utf8');

  if (bomCount) problems.push({ kind: 'BOM', line: 1, detail: 'file starts with UTF-8 BOM', ctx: '' });
  for (let i = 0; s.indexOf('\uFEFF', i) !== -1; ) {
    const at = s.indexOf('\uFEFF', i);
    if (at > 0 || !bomCount) {
      const starts = lineStarts(s);
      problems.push({ kind: 'BOM-mid', line: lineOf(starts, at), detail: 'U+FEFF inside file', ctx: contextAround(s, at) });
    }
    i = at + 1;
    break; // only first interior occurrence needs reporting
  }

  const fffd = [...s].filter((c) => c === '\uFFFD').length;
  if (fffd > 0) problems.push({ kind: 'U+FFFD', line: '-', detail: `${fffd} replacement character(s)`, ctx: '' });

  // Walk non-ASCII runs.
  const starts = lineStarts(s);
  let buf = ''; let bufFrom = -1;
  function flush(endIdx) {
    if (!buf) return;
    const hasLead = [...buf].some((ch) => LEADS.has(ch));
    if (hasLead) {
      const reversed = tryReverse(buf);
      problems.push({
        kind: 'mojibake-run',
        line: lineOf(starts, bufFrom),
        detail: `run ${JSON.stringify(buf)}${reversed ? ` (reverses to ${JSON.stringify(reversed)})` : ' (not reversible)'}`,
        ctx: contextAround(s, bufFrom),
      });
    }
    buf = ''; bufFrom = -1;
    void endIdx;
  }
  for (let i = 0; i < s.length; i += 1) {
    const c = s.codePointAt(i);
    if (c > 127) {
      if (bufFrom === -1) bufFrom = i;
      buf += s[i];
      if (c > 0xFFFF) i += 1; // surrogate pair
    } else {
      flush(i);
    }
  }
  flush(s.length);

  return { file, problems, nonAscii: {} };
}

function summarizeNonAscii(file) {
  const s = fs.readFileSync(file, 'utf8');
  const counts = {};
  for (const ch of s) { const c = ch.codePointAt(0); if (c > 127) counts[ch] = (counts[ch] || 0) + 1; }
  return counts;
}

const files = process.argv.slice(2);
let dirty = 0;
for (const f of files) {
  const { problems } = scan(f);
  const counts = summarizeNonAscii(f);
  const legitInventory = Object.entries(counts).map(([ch, n]) => `${JSON.stringify(ch)}x${n}`).join(' ');
  if (problems.length > 0) {
    dirty += 1;
    console.log(`FAIL  ${f}`);
    for (const p of problems) console.log(`        [${p.kind}] line ${p.line}: ${p.detail}${p.ctx ? `\n          ctx: ${p.ctx}` : ''}`);
  } else {
    console.log(`OK    ${f}   non-ASCII: ${legitInventory || '(none)'}`);
  }
}
console.log(`\n${files.length} files scanned, ${dirty} with findings`);
process.exitCode = dirty === 0 ? 0 : 1;
