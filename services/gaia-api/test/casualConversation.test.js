'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classify } = require('../src/logos/intentIQ');
const { evaluateConversationalOpportunity, renderOpportunityGuidance } = require('../src/logos/conversationalOpportunity');
const { inferInteractionType, renderConversationalState } = require('../src/logos/conversationalState');
const { performTurn } = require('../src/turn');

const DOCUMENTS = { 'soul.md': 'SOUL', 'principles.md': 'PRINCIPLES', 'lexicon.md': 'LEXICON' };

// Helper to get advisory for a turn
function getAdvisories({ prev, text }) {
  const messages = prev ? [{ role: 'assistant', content: prev }, { role: 'user', content: text }] : [{ role: 'user', content: text }];
  const intent = classify(messages, { silent: true });
  const opp = evaluateConversationalOpportunity({ text, conversationContext: messages, intentDecision: intent });
  const oppGuidance = renderOpportunityGuidance(opp);
  const stateGuidance = renderConversationalState({ intentDecision: intent, messages, userText: text });
  return { intent, opp, oppGuidance, stateGuidance };
}

// CASE 1: Gaia: "Waar ben je nu?" User: "In Maarn."
test('CASE 1: In Maarn - natural acknowledgement, never task question', () => {
  const { intent, opp, stateGuidance } = getAdvisories({ prev: 'Waar ben je nu?', text: 'In Maarn.' });
  assert.equal(intent.intent, 'converse');
  assert.equal(intent.needsClarification, false);
  assert.equal(opp.present, true);
  assert.ok(stateGuidance.includes('ANSWERING'));
  assert.ok(stateGuidance.includes('No clarification needed'));
  assert.ok(!stateGuidance.includes('what are you looking for'));
  assert.ok(!stateGuidance.includes('could you say a bit more'));
});

// CASE 2: User: "Ik ben in Maarn, in het huis van Fons en Helen."
test('CASE 2: house context - no generic location summary', () => {
  const text = 'Ik ben in Maarn, in het huis van Fons en Helen.';
  const { intent, opp, oppGuidance, stateGuidance } = getAdvisories({ prev: 'Waar ben je nu?', text });
  assert.equal(intent.intent, 'converse');
  assert.equal(opp.present, true);
  // Should not be a generic summary
  assert.ok(oppGuidance.includes('Respond to the HUMAN MEANING'));
  assert.ok(oppGuidance.includes('Do not mechanically summarize'));
});

// CASE 3: Friends remained
test('CASE 3: friendship survived - specific observation not generic evaluation', () => {
  const text = 'Fons en Helen en ik zijn vrienden gebleven ondanks dat het uit is met Thijs.';
  const { opp, oppGuidance, stateGuidance } = getAdvisories({ prev: null, text });
  assert.equal(opp.present, true);
  assert.equal(opp.naturalResponse, 'reflection');
  assert.ok(oppGuidance.includes('Quality bar — observation over evaluation'));
  assert.ok(oppGuidance.includes('Ze kwamen via Thijs'));
  assert.ok(oppGuidance.includes('Avoid therapeutic projections'));
  assert.ok(oppGuidance.includes('Specificity test'));
  // State should be sharing
  const type = inferInteractionType({ intentDecision: classify([{role:'user',content:text}],{silent:true}), userText: text, messages: [{role:'user',content:text}] });
  assert.equal(type, 'sharing');
  assert.ok(stateGuidance.includes('SHARING'));
});

// CASE 4: haha ja - short, light
test('CASE 4: haha ja - short natural continuation, no paragraph', () => {
  const text = 'haha ja';
  const { intent, opp, stateGuidance } = getAdvisories({ prev: 'Leuk verhaal', text });
  // Should not be a request, should be casual
  const type = inferInteractionType({ intentDecision: intent, userText: text, messages: [{role:'assistant',content:'Leuk verhaal'},{role:'user',content:text}] });
  assert.equal(type, 'casual');
  assert.equal(opp.present, false);
  assert.ok(stateGuidance.includes('casual continuation'));
  assert.ok(stateGuidance.includes('1 sentence for small turns'));
  assert.ok(stateGuidance.includes('No paragraphs for "haha ja"'));
});

// CASE 5: Dickie en Bailey - no caring person inference
test('CASE 5: Dickie en Bailey - context-aware, not personality inference', () => {
  const text = 'Ik pas op Dickie en Bailey.';
  const { opp, oppGuidance } = getAdvisories({ prev: null, text });
  assert.equal(opp.present, true);
  assert.ok(oppGuidance.includes('Do not mechanically summarize'));
  // Should not contain "caring person" evaluation
  assert.ok(!oppGuidance.includes('caring person'));
  assert.ok(oppGuidance.includes('Avoid formulations such as'));
});

// CASE 6: website - natural acknowledgement, not automatic geweldig
test('CASE 6: website klaar - celebration without automatic geweldig', () => {
  const text = 'Ik ben eindelijk klaar met mijn website.';
  const { opp, oppGuidance } = getAdvisories({ prev: null, text });
  assert.equal(opp.present, true);
  assert.equal(opp.naturalResponse, 'celebration');
  assert.ok(oppGuidance.includes('celebration'));
  // Should not force "Wat geweldig!" - guidance says optional and not performative enthusiasm
  assert.ok(oppGuidance.includes('never an instruction'));
});

// CASE 7: server 502 - task-focused, no emotional interpretation
test('CASE 7: server 502 - task-focused, no social curiosity', () => {
  const text = 'Mijn server geeft weer een 502.';
  const { intent, opp, stateGuidance } = getAdvisories({ prev: null, text });
  assert.equal(opp.present, false);
  assert.equal(stateGuidance, null); // request should have no casual advisory
  // Intent should be request-like (technical) or at least not casual sharing
  const type = inferInteractionType({ intentDecision: intent, userText: text, messages: [{role:'user',content:text}] });
  assert.equal(type, 'request');
});

// CASE 8: Ja - do not invent topic
test('CASE 8: Ja - minimal, no invented topic', () => {
  const text = 'Ja.';
  const { intent, opp, stateGuidance } = getAdvisories({ prev: 'Wil je dat doen?', text });
  // "Ja." as answer to a question is an answer, not just casual, but still minimal
  const type = inferInteractionType({ intentDecision: intent, userText: text, messages: [{role:'assistant',content:'Wil je dat doen?'},{role:'user',content:text}] });
  assert.ok(['answer','casual'].includes(type));
  assert.ok(stateGuidance === null || stateGuidance.includes('ANSWERING') || stateGuidance.includes('casual') || stateGuidance.includes('natural contribution'));
  // Should not have opportunity (trivial)
  assert.equal(opp.present, false);
});

// CASE 9: correction
test('CASE 9: correction - recognize and adjust', () => {
  const text = 'Nee, zo bedoelde ik het niet.';
  const prev = 'Je bent in Amsterdam toch?';
  const { intent } = getAdvisories({ prev, text });
  const type = inferInteractionType({ intentDecision: intent, userText: text, messages: [{role:'assistant',content:prev},{role:'user',content:text}] });
  assert.equal(type, 'correction');
  const state = renderConversationalState({ intentDecision: intent, messages: [{role:'assistant',content:prev},{role:'user',content:text}], userText: text });
  assert.ok(state.includes('CORRECTING'));
  assert.ok(state.includes('acknowledge the correction'));
});

// CASE 10: abrupt topic change
test('CASE 10: abrupt topic change - follow new direction', () => {
  const text = 'Trouwens, ik moet morgen iets heel anders regelen.';
  const prev = 'We hadden het over vakantie';
  const { intent } = getAdvisories({ prev, text });
  // Should be sharing/casual, not request, and should not be stuck on previous topic
  const type = inferInteractionType({ intentDecision: intent, userText: text, messages: [{role:'assistant',content:prev},{role:'user',content:text}] });
  assert.ok(['sharing','casual','question'].includes(type));
  assert.notEqual(type, 'request');
});

// Overall: casual conversation is not a fallback - integrated
test('casual conversation is normal state, not fallback to task', async () => {
  // Simulate a full turn for a casual sharing that previously went to clarify
  let seenMessages;
  const native = { generate: async (msgs) => { seenMessages = msgs; return 'Ze kwamen via Thijs, maar zijn hun eigen plek blijven houden.'; } };
  const hermes = { chat: async () => { throw new Error('should not be called'); } };
  const result = await performTurn({
    messages: [{ role: 'assistant', content: 'Waar ben je nu?' }, { role: 'user', content: 'Fons en Helen en ik zijn vrienden gebleven ondanks dat het uit is met Thijs.' }],
    documents: DOCUMENTS,
    hermes,
    nativeGenerator: native,
  });
  assert.equal(result.status, 200);
  assert.ok(!result.body.reply.includes('could you say a bit more'));
  assert.ok(!result.body.reply.includes('What are you looking for'));
  // Check that prompt contained both opportunity and conversational state
  const hasOpp = seenMessages.some(m => /conversational opportunity/i.test(m.content));
  const hasState = seenMessages.some(m => /Conversational state/i.test(m.content));
  assert.ok(hasOpp, 'should have opportunity guidance');
  assert.ok(hasState, 'should have conversational state');
  // Check quality bar present
  const oppMsg = seenMessages.find(m => /conversational opportunity/i.test(m.content));
  assert.ok(oppMsg.content.includes('observation over evaluation'));
  assert.ok(oppMsg.content.includes('Specificity test'));
});

// Check that Hindsight identity still correct (regression)
test('Hindsight identity still Gaia↔Bojan after casual refinement', async () => {
  const { reflectOnTurn } = require('../src/memory');
  let captured = null;
  const fake = { reflect: async (opts) => { captured = opts; } };
  reflectOnTurn(fake, {
    conversationId: 'c1',
    userText: 'Fons en Helen en ik zijn vrienden gebleven',
    assistantText: 'Ze kwamen via Thijs...',
    metadata: {},
  });
  await new Promise(r => setImmediate(r));
  assert.equal(captured.context, 'conversation between Gaia and Bojan');
  assert.equal(captured.metadata.agent_identity, 'Gaia');
});
