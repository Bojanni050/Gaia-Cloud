#!/usr/bin/env node
'use strict';

/**
 * why-recall — explain, for a given user turn, exactly which memory paths the
 * live turn would have opened and why.
 *
 * The live turn (src/turn.js) opens Hindsight recall, transcript search,
 * Foundation reads and pattern recall behind purely LEXICAL gates. When Gaia
 * answers "I cannot look that up", the honest question is which gate stayed
 * shut. This prints that decision, from the SAME modules the turn uses — no
 * server, no Hindsight, no network.
 *
 * Usage:
 *   node scripts/why-recall.js "wat zei je vorige week over het project?"
 *   node scripts/why-recall.js               # reads one message per line from stdin
 *
 * It is a read-only explanation; it never touches a store.
 */

const { shouldRecall, isTrivial, MEMORY_POLICY, PAST_REFERENCE_SIGNALS, DURABLE_CONTEXT_SIGNALS } = require('../src/memoryPolicy');
const { detectSignals } = require('../src/logos/intentSignals');
const { shouldAttemptPatternRetrieval } = require('../src/reasoning/patternAwareness');

/** @returns {string[]} the source text of each signal pattern that matched */
function matchedPatterns(text, patterns) {
  return patterns.filter((p) => p.test(text)).map((p) => p.source);
}

function explain(text) {
  const signals = detectSignals(text);
  const trivial = isTrivial(text, MEMORY_POLICY.minRecallLength);
  const gated = shouldRecall(text, { intentDecision: null });
  const past = matchedPatterns(text, PAST_REFERENCE_SIGNALS);
  const durable = matchedPatterns(text, DURABLE_CONTEXT_SIGNALS);

  const wantConversationHistory = Boolean(
    signals.exactHistory || signals.pastLookup || signals.rememberedKnowledge
  );
  const wantFoundation = signals.recordedKnowledge;
  const wantPatterns = shouldAttemptPatternRetrieval(text, null);

  const lines = [];
  lines.push(`message : ${JSON.stringify(text)}`);
  lines.push(`length  : ${(text || '').trim().length} (pattern floor: ${MEMORY_POLICY.minRecallLength})`);
  lines.push(`trivial : ${trivial ? 'YES — at the pattern floor (the recall gate has no length floor since 18-10-2026)' : 'no'}`);
  lines.push('');
  lines.push('gates the live turn would open:');
  lines.push(`  Hindsight recall          : ${gated ? 'OPEN' : 'closed'}`);
  lines.push(`  transcript search         : ${wantConversationHistory ? 'OPEN' : 'closed'}`);
  lines.push(`  Foundation read           : ${wantFoundation ? 'OPEN' : 'closed'}`);
  lines.push(`  pattern recall            : ${wantPatterns ? 'OPEN' : 'closed'}`);
  lines.push('');
  lines.push('why (lexical signals):');
  lines.push(`  past-reference cue        : ${past.length ? past.join(', ') : 'none'}`);
  lines.push(`  durable-context cue       : ${durable.length ? durable.join(', ') : 'none'}`);
  lines.push(`  exactHistory / pastLookup / rememberedKnowledge : ${signals.exactHistory} / ${signals.pastLookup} / ${signals.rememberedKnowledge}`);
  lines.push(`  recordedKnowledge         : ${signals.recordedKnowledge}`);
  lines.push(`  skill task shapes         : ${signals.skillTasks.length ? signals.skillTasks.join(', ') : 'none'}`);
  lines.push('');

  const anyMemoryPath = gated || wantConversationHistory || wantFoundation;
  if (anyMemoryPath) {
    lines.push('verdict: at least one memory path opens — the passive path can reach memory.');
  } else if (wantPatterns) {
    lines.push('verdict: NO memory path opens — Hindsight, transcript and Foundation are all');
    lines.push('         shut. Only pattern awareness opens. If this turn still shows her');
    lines.push('         stored memory, it came from an on-demand search_memory call, not the gate.');
  } else {
    lines.push('verdict: NO memory path opens. Gaia sees only the conversation in');
    lines.push('         the prompt, and "I cannot look that up" is the honest answer');
    lines.push('         to this phrasing. (IntentIQ semantic escape is offline live,');
    lines.push('         so it cannot rescue a paraphrase that misses the cues above.)');
  }
  return lines.join('\n');
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length > 0) {
    process.stdout.write(`${argv.map(explain).join('\n\n')}\n`);
    return;
  }
  let input = '';
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    const messages = input.split('\n').map((l) => l.trim()).filter(Boolean);
    process.stdout.write(`${messages.map(explain).join('\n\n')}\n`);
  });
}

main();
