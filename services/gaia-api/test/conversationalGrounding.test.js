'use strict';

/**
 * Regression tests for the architectural fix documented in
 * docs/architecture-conversational-guidance.md and
 * CONVERSATIONAL_GROUNDING_FIX_SUMMARY.md.
 *
 * The incident: a hardcoded "good example" narrative (Thijs, his parents,
 * a parrot, Ireland) baked into logos/conversationalOpportunity.js's
 * "quality bar" leaked into the live system prompt on every turn, and the
 * model echoed it as if it were a fact about the current user when someone
 * merely mentioned an unfamiliar name ("Anton heeft van zich laten horen.").
 *
 * The fix does not add a narrower rule to avoid that one name — it removes
 * the whole per-turn conversational classification + example-injection
 * system (logos/conversationalOpportunity.js, logos/conversationalState.js).
 * Conversational tone, empathy, and follow-up judgment are left to the LLM,
 * guided only by SOUL's existing "Factual Grounding & Relational Context"
 * section (identity/soul.md) — which already says, in the model's own
 * voice, not to expand an ambiguous statement into an assumed narrative.
 *
 * These tests guard the fix at the architecture level (no hardcoded
 * narrative fragments ever reach the prompt) and confirm memory retrieval —
 * the part of the pipeline that legitimately supplies context — still works.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { performTurn } = require('../src/turn');

const DOCUMENTS = { 'soul.md': 'SOUL', 'principles.md': 'PRINCIPLES', 'lexicon.md': 'LEXICON' };
const SILENT_HINDSIGHT = { recall: async () => [], reflect: async () => {} };

// Fragments from the original leaked example narrative. None of these are
// generic Dutch words — they are the specific names/places from the
// incident, so any hit here means a hardcoded example leaked again.
const FORBIDDEN_NARRATIVE_FRAGMENTS = [
  'Thijs', 'ouders van Thijs', 'eigen band opgebouwd', 'papegaai', 'Ierland', 'Dickie', 'Bailey', 'Maarn',
];

test('Anton case: an unfamiliar name never triggers a fabricated relational narrative', async () => {
  let capturedMessages = null;
  const hermes = {
    async chat(messages) {
      capturedMessages = messages;
      return 'Wat heeft hij laten weten?';
    },
  };

  const result = await performTurn({
    messages: [{ role: 'user', content: 'Anton heeft van zich laten horen.' }],
    documents: DOCUMENTS,
    hermes,
    hindsight: SILENT_HINDSIGHT,
  });

  assert.equal(result.status, 200);
  assert.ok(capturedMessages, 'hermes must have received assembled messages');
  const fullPrompt = capturedMessages.map((m) => m.content).join('\n');
  for (const fragment of FORBIDDEN_NARRATIVE_FRAGMENTS) {
    assert.ok(!fullPrompt.includes(fragment), `system prompt must never contain "${fragment}"`);
  }
});

test('memory still works: established context about Anton reaches the prompt as memory, not as a hardcoded rule', async () => {
  let capturedMessages = null;
  const hermes = {
    async chat(messages) {
      capturedMessages = messages;
      return 'Fijn om te horen. Wat vertelde hij?';
    },
  };
  const hindsight = {
    // A lexical past-reference cue ("weet je nog") is what makes this turn
    // actually pass the recall gate (memoryPolicy.shouldRecall) — a bare
    // mention of a name is not enough on its own, by design.
    recall: async () => [{ text: 'Anton is a close friend of the user from university.', scores: { final: 0.9 } }],
    reflect: async () => {},
  };

  const result = await performTurn({
    messages: [{ role: 'user', content: 'Weet je nog wie Anton is? Hij heeft van zich laten horen.' }],
    documents: DOCUMENTS,
    hermes,
    hindsight,
  });

  assert.equal(result.status, 200);
  assert.ok(capturedMessages, 'hermes must have received assembled messages');
  const memoryBlock = capturedMessages.find((m) => m.role === 'system' && /long-term memory/.test(m.content));
  assert.ok(memoryBlock, 'established memory about Anton must still reach the prompt as memory context');
  assert.match(memoryBlock.content, /Anton is a close friend/);
});

test('reasonIQ no longer computes or attaches a conversational-opportunity classification', async () => {
  const { evaluate } = require('../src/logos/reasonIQ');
  const result = await evaluate({ text: 'Ik ben eindelijk klaar met mijn website.', conversationContext: [] }, { silent: true });
  assert.equal(result.conversationalOpportunity, undefined);
});

test('the per-turn conversational-classification modules were removed, not merely disabled', () => {
  assert.throws(() => require('../src/logos/conversationalOpportunity'), /Cannot find module/);
  assert.throws(() => require('../src/logos/conversationalState'), /Cannot find module/);
});
