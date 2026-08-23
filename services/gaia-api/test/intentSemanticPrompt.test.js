'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSemanticPrompt, SYSTEM_PROMPT, SPEECH_ACTS } = require('../src/logos/intentSemanticPrompt');
const { INTENT_IDS } = require('../src/logos/intentTaxonomy');

test('SYSTEM_PROMPT lists every taxonomy intent id — never a duplicate/parallel taxonomy', () => {
  for (const id of INTENT_IDS) {
    assert.ok(SYSTEM_PROMPT.includes(id), `system prompt is missing taxonomy intent: ${id}`);
  }
});

test('SYSTEM_PROMPT tells the model it never selects capabilities or generates the answer', () => {
  assert.match(SYSTEM_PROMPT, /never select a capability/i);
  assert.match(SYSTEM_PROMPT, /never generate an answer/i);
});

test('buildSemanticPrompt returns a system + user message pair', () => {
  const messages = buildSemanticPrompt({ text: 'hi', recentTurns: [], heuristicResult: null });
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[1].role, 'user');
});

test('buildSemanticPrompt embeds the current turn text', () => {
  const messages = buildSemanticPrompt({ text: 'Analyseer deze architectuur.', recentTurns: [], heuristicResult: null });
  assert.match(messages[1].content, /Analyseer deze architectuur\./);
});

test('buildSemanticPrompt embeds recent turns (both roles), capped to the last 6', () => {
  const recentTurns = Array.from({ length: 10 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `turn-${i}`,
  }));
  const messages = buildSemanticPrompt({ text: 'En deze dan?', recentTurns, heuristicResult: null });
  const payload = JSON.parse(messages[1].content.match(/```json\n([\s\S]*)\n```/)[1]);
  assert.equal(payload.recent_turns.length, 6);
  assert.equal(payload.recent_turns[0].content, 'turn-4'); // last 6 of 10 -> indices 4..9
  assert.equal(payload.recent_turns.at(-1).content, 'turn-9');
  // Both roles survive — not just user turns (needed to resolve referents
  // pointing at what the assistant said).
  assert.ok(payload.recent_turns.some((t) => t.role === 'assistant'));
});

test('buildSemanticPrompt embeds the heuristic result as context, not an instruction', () => {
  const messages = buildSemanticPrompt({
    text: 'x',
    recentTurns: [],
    heuristicResult: { intent: 'inform.explain', status: 'accepted', confidence: 0.8, sourceOfTruth: 'external_knowledge' },
  });
  const payload = JSON.parse(messages[1].content.match(/```json\n([\s\S]*)\n```/)[1]);
  assert.equal(payload.heuristic.intent, 'inform.explain');
  assert.equal(payload.heuristic.confidence, 0.8);
});

test('buildSemanticPrompt handles a null heuristic result (e.g. no heuristic signal at all)', () => {
  const messages = buildSemanticPrompt({ text: 'x', recentTurns: [], heuristicResult: null });
  const payload = JSON.parse(messages[1].content.match(/```json\n([\s\S]*)\n```/)[1]);
  assert.equal(payload.heuristic, null);
});

test('SPEECH_ACTS is a small, fixed vocabulary', () => {
  assert.ok(SPEECH_ACTS.includes('question'));
  assert.ok(SPEECH_ACTS.includes('advice_request'));
  assert.ok(SPEECH_ACTS.includes('follow_up'));
});
