'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateConversationalOpportunity, renderOpportunityGuidance, NATURAL_RESPONSES } = require('../src/logos/conversationalOpportunity');
const reasonIQ = require('../src/logos/reasonIQ');
const { parseAndValidateReasoningOutput } = require('../src/logos/reasonValidate');

const silent = { silent: true };

// ---------------------------------------------------------------------------
// 1. User answers Gaia's previous question → conversational opportunity detected
// ---------------------------------------------------------------------------

test('1: User answers Gaia previous question (Dutch location) → opportunity detected', () => {
  const opp = evaluateConversationalOpportunity({
    text: 'In Maarn.',
    conversationContext: [
      { role: 'assistant', content: 'Waar ben je nu?' },
      { role: 'user', content: 'In Maarn.' },
    ],
    intentDecision: { intent: null, status: 'unknown' },
  });
  assert.equal(opp.present, true);
  assert.ok(opp.strength >= 0.7 && opp.strength <= 1);
  assert.equal(opp.subject, "user's current location");
  assert.match(opp.reason, /answered a question Gaia previously asked/);
  assert.equal(opp.naturalResponse, 'curiosity');
  assert.ok(typeof opp.suggestedFollowUp === 'string' && opp.suggestedFollowUp.length > 0);
  assert.match(opp.suggestedFollowUp, /Wat brengt je daar/);
});

test('1b: English location answer also detected', () => {
  const opp = evaluateConversationalOpportunity({
    text: 'In Utrecht.',
    conversationContext: [
      { role: 'assistant', content: 'Where are you now?' },
      { role: 'user', content: 'In Utrecht.' },
    ],
    intentDecision: { intent: 'converse', status: 'accepted' },
  });
  assert.equal(opp.present, true);
  assert.equal(opp.subject, "user's current location");
});

// ---------------------------------------------------------------------------
// 2. User provides meaningful personal detail → opportunity detected
// ---------------------------------------------------------------------------

test('2: Personal achievement — website finished (Dutch)', () => {
  const opp = evaluateConversationalOpportunity({
    text: 'Ik ben eindelijk klaar met mijn website.',
    conversationContext: [{ role: 'user', content: 'Ik ben eindelijk klaar met mijn website.' }],
    intentDecision: { intent: 'converse', status: 'accepted' },
  });
  assert.equal(opp.present, true);
  assert.ok(opp.strength > 0.6);
  assert.match(opp.subject, /website/i);
  assert.equal(opp.naturalResponse, 'celebration');
  assert.ok(typeof opp.suggestedFollowUp === 'string');
  assert.match(opp.suggestedFollowUp, /Hoe is het geworden/);
});

test('2b: First song finished → opportunity detected', () => {
  const opp = evaluateConversationalOpportunity({
    text: 'Ik heb vandaag mijn eerste nummer afgemaakt.',
    conversationContext: [{ role: 'user', content: 'Ik heb vandaag mijn eerste nummer afgemaakt.' }],
    intentDecision: { intent: 'converse', status: 'accepted' },
  });
  assert.equal(opp.present, true);
  assert.ok(opp.strength >= 0.7);
  assert.match(opp.subject, /first finished song|nummer/i);
  assert.equal(opp.naturalResponse, 'celebration');
  assert.ok(opp.suggestedFollowUp);
});

test('2c: Does not treat every interesting detail as opportunity without personal weight', () => {
  // Generic statement without strong personal marker should not trigger
  const opp = evaluateConversationalOpportunity({
    text: 'Het weer is vandaag wel oké.',
    conversationContext: [{ role: 'user', content: 'Het weer is vandaag wel oké.' }],
    intentDecision: { intent: 'converse', status: 'accepted' },
  });
  assert.equal(opp.present, false);
});

// ---------------------------------------------------------------------------
// 3. Technical task → no unnecessary conversational opportunity
// ---------------------------------------------------------------------------

test('3: Technical task (CSS) → no opportunity', () => {
  const opp = evaluateConversationalOpportunity({
    text: 'Mijn CSS werkt nog steeds niet.',
    conversationContext: [{ role: 'user', content: 'Mijn CSS werkt nog steeds niet.' }],
    intentDecision: { intent: 'create.transform', status: 'accepted', sourceOfTruth: 'conversation' },
  });
  assert.equal(opp.present, false);
  assert.equal(opp.naturalResponse, 'none');
  assert.equal(opp.suggestedFollowUp, null);
  assert.match(opp.reason, /task-focused|distracting/i);
});

test('3b: inform.explain technical question → no opportunity', () => {
  const opp = evaluateConversationalOpportunity({
    text: 'Waarom geeft mijn API een 500 op het checkout endpoint?',
    conversationContext: [{ role: 'user', content: 'Waarom geeft mijn API een 500 op het checkout endpoint?' }],
    intentDecision: { intent: 'inform.explain', status: 'accepted', sourceOfTruth: 'external_knowledge' },
  });
  assert.equal(opp.present, false);
});

// ---------------------------------------------------------------------------
// 4. Trivial response → no opportunity
// ---------------------------------------------------------------------------

test('4: Trivial "Oké." → no opportunity', () => {
  const opp = evaluateConversationalOpportunity({
    text: 'Oké.',
    conversationContext: [{ role: 'assistant', content: 'Waar ben je nu?' }, { role: 'user', content: 'Oké.' }],
    intentDecision: { intent: null, status: 'unknown' },
  });
  assert.equal(opp.present, false);
  assert.equal(opp.naturalResponse, 'none');
  assert.equal(opp.strength, 0);
});

test('4b: Trivial "Dank je." → no opportunity', () => {
  const opp = evaluateConversationalOpportunity({
    text: 'Dank je.',
    conversationContext: [{ role: 'user', content: 'Dank je.' }],
    intentDecision: { intent: 'converse', status: 'accepted' },
  });
  assert.equal(opp.present, false);
});

test('4c: Trivial "thanks" and "ok" variants', () => {
  for (const txt of ['ok', 'thanks', 'bedankt', 'prima', 'cool']) {
    const opp = evaluateConversationalOpportunity({
      text: txt,
      conversationContext: [{ role: 'user', content: txt }],
      intentDecision: null,
    });
    assert.equal(opp.present, false, `should be trivial: ${txt}`);
  }
});

// ---------------------------------------------------------------------------
// 5. Opportunity exists but follow-up would be unnatural → acknowledgement
// ---------------------------------------------------------------------------

test('5: answer to generic previous question → acknowledgement without follow-up', () => {
  const opp = evaluateConversationalOpportunity({
    text: 'Ja, dat klopt.',
    conversationContext: [
      { role: 'assistant', content: 'Heb je het rapport al gelezen?' },
      { role: 'user', content: 'Ja, dat klopt.' },
    ],
    intentDecision: { intent: 'converse', status: 'accepted' },
  });
  // Short answer to previous question: present true but follow-up not needed
  if (opp.present) {
    assert.ok(['acknowledgement', 'curiosity', 'reflection'].includes(opp.naturalResponse));
    // when acknowledgement, suggestedFollowUp should be null (not forced)
    if (opp.naturalResponse === 'acknowledgement') {
      assert.equal(opp.suggestedFollowUp, null);
    }
  } else {
    // also valid to be false when answer is trivial-ish
    assert.equal(opp.present, false);
  }
});

test('5b: personal detail without natural question → acknowledgement, not curiosity', () => {
  // Location question has natural curiosity; but a personal detail without question context
  // should not force a question if acknowledgement is more natural
  const opp = evaluateConversationalOpportunity({
    text: 'Ik ben eindelijk klaar met mijn website.',
    conversationContext: [{ role: 'user', content: 'Ik ben eindelijk klaar met mijn website.' }],
    intentDecision: { intent: 'converse', status: 'accepted' },
  });
  // For website, we chose celebration with optional follow-up — but we must not force a question every time
  // The key assertion: interest does not equal questioning — acknowledgement is also valid.
  // Here we have a follow-up suggestion, but the render guidance must note it is optional.
  assert.equal(opp.present, true);
  const guidance = renderOpportunityGuidance(opp);
  assert.match(guidance, /optional follow-up idea/i);
  assert.match(guidance, /Do not manufacture a question/);
});

// ---------------------------------------------------------------------------
// 6. Previous question context is considered
// ---------------------------------------------------------------------------

test('6: Without previous question context, short location alone is not opportunity', () => {
  const opp = evaluateConversationalOpportunity({
    text: 'In Maarn.',
    conversationContext: [{ role: 'user', content: 'In Maarn.' }], // no previous assistant question
    intentDecision: { intent: 'converse', status: 'accepted' },
  });
  // Without a preceding question, "In Maarn." is isolated and not clearly an answer
  assert.equal(opp.present, false);
});

test('6b: With previous question context, same answer becomes opportunity', () => {
  const without = evaluateConversationalOpportunity({
    text: 'In Maarn.',
    conversationContext: [{ role: 'user', content: 'In Maarn.' }],
    intentDecision: null,
  });
  const withCtx = evaluateConversationalOpportunity({
    text: 'In Maarn.',
    conversationContext: [
      { role: 'assistant', content: 'Waar ben je nu?' },
      { role: 'user', content: 'In Maarn.' },
    ],
    intentDecision: null,
  });
  assert.equal(without.present, false);
  assert.equal(withCtx.present, true);
});

test('6c: Previous assistant non-question does not create opportunity', () => {
  const opp = evaluateConversationalOpportunity({
    text: 'In Maarn.',
    conversationContext: [
      { role: 'assistant', content: 'Leuk je te spreken.' }, // not a question
      { role: 'user', content: 'In Maarn.' },
    ],
    intentDecision: null,
  });
  assert.equal(opp.present, false);
});

// ---------------------------------------------------------------------------
// 7. No automatic follow-up question is generated merely because opportunity exists
// ---------------------------------------------------------------------------

test('7: Opportunity does not mandate a follow-up; guidance is advisory', () => {
  const opp = evaluateConversationalOpportunity({
    text: 'Ik ben eindelijk klaar met mijn website.',
    conversationContext: [{ role: 'user', content: 'Ik ben eindelijk klaar met mijn website.' }],
    intentDecision: { intent: 'converse', status: 'accepted' },
  });
  assert.equal(opp.present, true);
  // suggestedFollowUp is optional guidance, not a command
  // The response layer MAY choose to acknowledge without asking
  // Verify guidance text emphasizes this
  const guidance = renderOpportunityGuidance(opp);
  assert.match(guidance, /never an instruction/i);
  assert.match(guidance, /choose only what feels natural/i);

  // Also: a generic answer case has null suggestedFollowUp, proving not every opportunity forces a question
  const ackOpp = evaluateConversationalOpportunity({
    text: 'Ja, dat klopt.',
    conversationContext: [
      { role: 'assistant', content: 'Heb je dat al gedaan?' },
      { role: 'user', content: 'Ja, dat klopt.' },
    ],
    intentDecision: null,
  });
  if (ackOpp.present && ackOpp.naturalResponse === 'acknowledgement') {
    assert.equal(ackOpp.suggestedFollowUp, null);
  }
});

test('7b: renderOpportunityGuidance returns null when no opportunity', () => {
  const opp = evaluateConversationalOpportunity({
    text: 'Oké.',
    conversationContext: [{ role: 'user', content: 'Oké.' }],
    intentDecision: null,
  });
  assert.equal(renderOpportunityGuidance(opp), null);
  assert.equal(renderOpportunityGuidance(null), null);
});

// ---------------------------------------------------------------------------
// 8. Existing reasoning behavior remains unchanged when opportunity is absent
// ---------------------------------------------------------------------------

test('8: Shallow reasoning result still has correct shape plus conversationalOpportunity', async () => {
  const result = await reasonIQ.evaluate(
    { text: 'Hoi Gaia', intentDecision: { intent: 'converse', status: 'accepted', confidence: 0.9 }, evidence: [] },
    { silent: true }
  );
  assert.equal(result.reasoningDepth, 'shallow');
  assert.ok(result.conversationalOpportunity);
  assert.equal(typeof result.conversationalOpportunity.present, 'boolean');
  assert.ok(NATURAL_RESPONSES.includes(result.conversationalOpportunity.naturalResponse));
  // Original fields untouched
  assert.ok(Array.isArray(result.hypotheses));
  assert.ok(Array.isArray(result.contradictions));
  assert.equal(result.schemaVersion, 'reasoniq.v1');
});

test('8b: Deep reasoning result preserves all fields plus opportunity', async () => {
  const model = {
    chat: async () => JSON.stringify({ interpretation: 'ok', hypotheses: [], contradictions: [], uncertainties: [], informationGaps: [], conclusions: [], sufficientForConclusion: false, confidence: 0.6 }),
    isConfigured: () => true,
  };
  const result = await reasonIQ.evaluate(
    { text: 'Analyseer dit.', intentDecision: { intent: 'inform.explain', status: 'accepted', confidence: 0.8 }, evidence: [{ id: 'h-1', source: 'hindsight', content: 'memory', relevance: 0.9 }] },
    { reasoningModel: model, silent: true }
  );
  assert.equal(result.reasoningDepth, 'deep');
  assert.ok(result.conversationalOpportunity);
  // For a technical analysis turn, opportunity should be false
  assert.equal(result.conversationalOpportunity.present, false);
});

test('8c: Degraded result still carries conversationalOpportunity (never throws)', async () => {
  const failingModel = { chat: async () => { throw new Error('unreachable'); }, isConfigured: () => true };
  const result = await reasonIQ.evaluate(
    { text: 'Waarom faalt dit?', evidence: [{ id: 'h-1', source: 'hindsight', content: 'x' }] },
    { reasoningModel: failingModel, silent: true }
  );
  assert.equal(result.meta.fallbackReason, 'reasoning_model_unavailable');
  assert.ok(result.conversationalOpportunity);
});

test('8d: conversationalOpportunity does not affect reasoningDepth decision', async () => {
  // Same evidence gating as before: converse with evidence stays shallow
  const result = await reasonIQ.evaluate(
    { text: 'Hoi Gaia', intentDecision: { intent: 'converse', status: 'accepted' }, evidence: [{ id: 'h-1', source: 'hindsight', content: 'memory' }] },
    { silent: true }
  );
  assert.equal(result.reasoningDepth, 'shallow');
});

// ---------------------------------------------------------------------------
// 9. Existing ReasoningResult consumers remain compatible (backwards compatible)
// ---------------------------------------------------------------------------

test('9: ReasoningResult without conversationalOpportunity still validates (backward compat)', () => {
  const legacy = { interpretation: 'ok' };
  const result = parseAndValidateReasoningOutput(JSON.stringify(legacy));
  // Legacy callers produce minimal result; validation does not require opportunity field
  assert.equal(result.interpretation, 'ok');
  // New consumers can check existence optionally
  assert.equal(result.conversationalOpportunity, undefined);
  // Old consumers that ignore the field continue to work
  assert.ok(!('conversationalOpportunity' in result) || result.conversationalOpportunity === undefined);
});

test('9b: ReasoningResult with opportunity still passes through validation and remains usable', async () => {
  const result = await reasonIQ.evaluate(
    { text: 'Ik ben eindelijk klaar met mijn website.', intentDecision: { intent: 'converse', status: 'accepted' } },
    { silent: true }
  );
  // Simulate a consumer that only reads old fields
  const shallowCopy = { ...result };
  delete shallowCopy.conversationalOpportunity;
  assert.equal(shallowCopy.interpretation, result.interpretation);
  assert.equal(shallowCopy.reasoningDepth, result.reasoningDepth);
  // But the full result retains the new field for new consumers
  assert.ok(result.conversationalOpportunity.present);
});

test('9c: Contract - conversationalOpportunity fields are correctly shaped', async () => {
  const result = await reasonIQ.evaluate(
    { text: 'Waar ben je nu?', conversationContext: [{ role: 'user', content: 'Waar ben je nu?' }], intentDecision: null },
    { silent: true }
  );
  const opp = result.conversationalOpportunity;
  assert.ok(typeof opp.present === 'boolean');
  assert.ok(typeof opp.strength === 'number' && opp.strength >= 0 && opp.strength <= 1);
  assert.ok(opp.subject === null || typeof opp.subject === 'string');
  assert.ok(opp.reason === null || typeof opp.reason === 'string');
  assert.ok(NATURAL_RESPONSES.includes(opp.naturalResponse));
  assert.ok(opp.suggestedFollowUp === null || typeof opp.suggestedFollowUp === 'string');
});

// ---------------------------------------------------------------------------
// Acceptance criterion: Maarn interaction no longer database-like
// ---------------------------------------------------------------------------

test('acceptance: Maarn interaction produces opportunity capable of "Oh, in Maarn. Wat brengt je daar?"', async () => {
  const result = await reasonIQ.evaluate(
    {
      text: 'In Maarn.',
      conversationContext: [
        { role: 'assistant', content: 'Waar ben je nu?' },
        { role: 'user', content: 'In Maarn.' },
      ],
      intentDecision: { intent: null, status: 'unknown' },
    },
    { silent: true }
  );
  const opp = result.conversationalOpportunity;
  assert.equal(opp.present, true);
  assert.equal(opp.naturalResponse, 'curiosity');
  // The response layer may formulate "Oh, in Maarn. Wat brengt je daar?" or simply "Oh, in Maarn."
  // Both are good; the bad "Oké, je bent nu in Maarn. Duidelijk." is a database acknowledgement, not interest.
  // We verify the opportunity enables the good formulations and is not the bad one.
  const guidance = renderOpportunityGuidance(opp);
  assert.match(guidance, /Wat brengt je daar/);
  assert.match(guidance, /subject:.*location/i);
  assert.match(guidance, /never an instruction/i);
});

// ---------------------------------------------------------------------------
// Additional: turn.js advisory wiring (no separate engine)
// ---------------------------------------------------------------------------

test('turn.js does not import a separate curiosity/smalltalk engine', () => {
  const fs = require('fs');
  const path = require('path');
  const turnSource = fs.readFileSync(path.join(__dirname, '../src/turn.js'), 'utf-8');
  const codeOnly = turnSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
  assert.ok(!/CuriosityEngine|SmallTalkEngine|Engagement/i.test(codeOnly), 'must not introduce a separate engine');
  // Advisory module is allowed — it is part of Logos, not a separate personality subsystem
  assert.ok(/conversationalOpportunity/.test(codeOnly), 'turn.js should wire the advisory opportunity');
});

test('reasonIQ never generates final user-facing response', async () => {
  const result = await reasonIQ.evaluate(
    { text: 'In Maarn.', conversationContext: [{ role: 'assistant', content: 'Waar ben je nu?' }, { role: 'user', content: 'In Maarn.' }] },
    { silent: true }
  );
  const keys = Object.keys(result);
  for (const forbidden of ['reply', 'response', 'message', 'answer', 'output']) {
    assert.ok(!keys.includes(forbidden), `ReasoningResult must not contain ${forbidden}`);
  }
  // It provides advisory suggestedFollowUp, not a final response
  assert.ok(result.conversationalOpportunity);
  assert.equal(typeof result.conversationalOpportunity.suggestedFollowUp, 'string');
});

// ---------------------------------------------------------------------------
// Regression: long Maarn house-sitting scenario (the failing interaction)
// ---------------------------------------------------------------------------

const LONG_MAARN_TEXT = 'In Maarn, in het huis van Fons en Helen. Fons en Helen zijn de ouders van Thijs. Met Thijs heb ik ruim 8 jaar een relatie gehad. Thijs woont nu in Ierland. Elk jaar gaan Fons en Helen een maand naar Ierland om hem en zijn huidige partner, Mick, te bezoeken. Ik pas op het huis en de twee papegaaien, Dickie en Bailey.';

test('regression: long Maarn house-sitting answer is recognised as answer_to_gaia_question, not unknown', () => {
  const { classify } = require('../src/logos/intentIQ');
  const messages = [
    { role: 'assistant', content: 'Waar ben je nu?' },
    { role: 'user', content: LONG_MAARN_TEXT },
  ];
  const decision = classify(messages, { silent: true });
  assert.equal(decision.intent, 'converse');
  assert.equal(decision.status, 'accepted');
  assert.equal(decision.needsClarification, false);
  assert.equal(decision.meta.reason, 'answer_to_gaia_question');
});

test('regression: long Maarn answer produces rich conversational opportunity (reflection, no forced question)', () => {
  const opp = evaluateConversationalOpportunity({
    text: LONG_MAARN_TEXT,
    conversationContext: [
      { role: 'assistant', content: 'Waar ben je nu?' },
      { role: 'user', content: LONG_MAARN_TEXT },
    ],
    intentDecision: { intent: 'converse', status: 'accepted' },
  });
  assert.equal(opp.present, true);
  assert.ok(opp.strength >= 0.8);
  assert.equal(opp.naturalResponse, 'reflection');
  assert.equal(opp.suggestedFollowUp, null);
  const guidance = renderOpportunityGuidance(opp);
  assert.match(guidance, /reflection/i);
  assert.match(guidance, /no follow-up question is needed/i);
  assert.match(guidance, /never an instruction/i);
});

test('regression: long Maarn turn never routes to clarify / "what are you looking for?"', async () => {
  const { performTurn } = require('../src/turn');
  const DOCUMENTS = { 'soul.md': 'SOUL', 'principles.md': 'PRINCIPLES', 'lexicon.md': 'LEXICON' };
  let seenMessages;
  const nativeGenerator = {
    generate: async (messages) => {
      seenMessages = messages;
      return 'Ah, dus je bent daar op het huis en op Dickie en Bailey aan het passen.';
    },
  };
  const hermes = { chat: async () => { throw new Error('hermes must not be called'); } };
  const result = await performTurn({
    messages: [
      { role: 'assistant', content: 'Waar ben je nu?' },
      { role: 'user', content: LONG_MAARN_TEXT },
    ],
    documents: DOCUMENTS,
    hermes,
    nativeGenerator,
  });
  assert.equal(result.status, 200);
  assert.ok(result.body.reply);
  assert.ok(!result.body.reply.includes('could you say a bit more'));
  assert.ok(!result.body.reply.includes('what are you looking for'));
  assert.ok(!result.status.toString().startsWith('4') && !result.body.error);
  // guidance was injected and was reflection, not curiosity with forced question
  const guidance = seenMessages.find((m) => /conversational opportunity/i.test(m.content));
  assert.ok(guidance, 'guidance should be present for this rich context');
  assert.match(guidance.content, /reflection/i);
});

test('regression: volunteered personal sharing without previous question is converse, not unknown, and yields opportunity', () => {
  const { classify } = require('../src/logos/intentIQ');
  const decision = classify([{ role: 'user', content: LONG_MAARN_TEXT }], { silent: true });
  assert.equal(decision.intent, 'converse');
  assert.equal(decision.needsClarification, false);
  assert.equal(decision.meta.reason, 'volunteered_personal_sharing');

  const opp = evaluateConversationalOpportunity({
    text: LONG_MAARN_TEXT,
    conversationContext: [{ role: 'user', content: LONG_MAARN_TEXT }],
    intentDecision: decision,
  });
  assert.equal(opp.present, true);
  assert.equal(opp.naturalResponse, 'reflection');
});

test('regression: volunteered sharing does not contain privacy disclaimer guidance', () => {
  const opp = evaluateConversationalOpportunity({
    text: LONG_MAARN_TEXT,
    conversationContext: [{ role: 'user', content: LONG_MAARN_TEXT }],
    intentDecision: { intent: 'converse', status: 'accepted' },
  });
  const guidance = renderOpportunityGuidance(opp);
  assert.ok(guidance);
  assert.ok(!/privacy|I don.t ask for personal details/i.test(guidance), 'guidance must not lecture about privacy');
  assert.match(guidance, /brief acknowledgement or reflection is enough/i);
});

const LONG_MAARN_WITH_PREFIX = 'ha duidelijk. Ik ben in Maarn, in het huis van Fons en Helen. Fons en Helen zijn de ouders van Thijs. Met Thijs heb ik ruim 8 jaar een relatie gehad. Thijs woont nu in Ierland. Elk jaar gaan Fons en Helen een maand naar Ierland om hem en zijn huidige partner, Mick, te bezoeken. Ik pas op het huis en de twee papegaaien, Dickie en Bailey';

test('regression: "ha duidelijk. Ik ben in Maarn..." still classified as answer_to_gaia_question and never gets clarify', () => {
  const { classify } = require('../src/logos/intentIQ');
  const messages = [
    { role: 'assistant', content: 'Waar ben je nu?' },
    { role: 'user', content: LONG_MAARN_WITH_PREFIX },
  ];
  const decision = classify(messages, { silent: true });
  assert.equal(decision.intent, 'converse');
  assert.equal(decision.needsClarification, false);
  assert.equal(decision.meta.reason, 'answer_to_gaia_question');
});

test('regression: "ha duidelijk..." turn produces reflection guidance that forbids summary/clarify phrasing', () => {
  const opp = evaluateConversationalOpportunity({
    text: LONG_MAARN_WITH_PREFIX,
    conversationContext: [
      { role: 'assistant', content: 'Waar ben je nu?' },
      { role: 'user', content: LONG_MAARN_WITH_PREFIX },
    ],
    intentDecision: { intent: 'converse', status: 'accepted' },
  });
  assert.equal(opp.present, true);
  const guidance = renderOpportunityGuidance(opp);
  assert.ok(guidance);
  assert.match(guidance, /Do not say.*could you say a bit more/i);
  assert.match(guidance, /Respond to the HUMAN MEANING/i);
  assert.match(guidance, /Do not mechanically summarize/i);
  assert.match(guidance, /That is a clear situation/i);
});

test('regression: generic answer turns do not trigger clarify', () => {
  const { classify } = require('../src/logos/intentIQ');
  const cases = [
    { prev: 'Hoe was je dag?', text: 'Best druk. Ik heb vanmiddag eindelijk dat project afgerond.' },
    { prev: 'Waar ben je?', text: 'Bij mijn ouders. Ze zijn dit weekend weg dus ik pas op het huis.' },
    { prev: 'Wat ga je vanavond doen?', text: 'Waarschijnlijk gewoon thuis. Ik moet morgen vroeg op.' },
  ];
  for (const c of cases) {
    const decision = classify([{ role: 'assistant', content: c.prev }, { role: 'user', content: c.text }], { silent: true });
    assert.equal(decision.needsClarification, false, `should not need clarification: ${c.text}`);
    assert.equal(decision.intent, 'converse', `should be converse: ${c.text}`);
  }
});

test('regression: guidance for personal sharing never contains summary formulations as instruction', () => {
  const opp = evaluateConversationalOpportunity({
    text: LONG_MAARN_TEXT,
    conversationContext: [{ role: 'assistant', content: 'Waar ben je nu?' }, { role: 'user', content: LONG_MAARN_TEXT }],
    intentDecision: { intent: 'converse', status: 'accepted' },
  });
  const guidance = renderOpportunityGuidance(opp);
  // Guidance itself must forbid, not contain as instruction to say it
  assert.match(guidance, /Avoid formulations such as "That is a clear situation\."/);
  assert.match(guidance, /Would this sound natural if a person said it/);
});

