'use strict';

/**
 * conversation_search — live-path validation (spec §21, §22, §24).
 *
 * Runs the two contextual scenarios through the REAL performTurn pipeline
 * with a real createConversationStore over a temp directory, and reports
 * query latency, result count and scope per search (spec §24). The real
 * deployment is unreachable from this machine; the store seam is the exact
 * production one.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { createConversationStore } = require('../src/conversationStore');
const { createConversationSearchTool } = require('../src/tools/conversationSearch');
const { performTurn } = require('../src/turn');

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-validate-'));
  const historyStore = createConversationStore({ historyDir: dir });

  // §22: something that exists ONLY in an old saved conversation.
  historyStore.saveConversation('mei-gesprek', [
    { role: 'user', content: 'Ik zei vorige maand dat ik de communicatie met klanten kort wil houden.' },
    { role: 'assistant', content: 'Genoteerd: korte klantcommunicatie als voorkeur.' },
  ]);

  const tools = { conversation_search: createConversationSearchTool({ historyStore }) };
  const DOCUMENTS = { 'soul.md': 'SOUL', 'principles.md': 'PRINCIPLES', 'lexicon.md': 'LEXICON' };

  const ANCHORED = () => ({
    schemaVersion: 'intentiq.v1',
    intent: null,
    status: 'unknown',
    sourceOfTruth: 'memory',
    needsClarification: false,
    entities: [],
    referents: [{ expression: 'juni', resolvedTo: 'previous_assistant_turn:juni', confidence: 0.6, source: 'previous_assistant_turn' }],
    meta: { reason: 'assistant_anchored_follow_up_unresolved_intent' },
  });

  console.log('conversation_search — live-path validation\n');

  // --- §21: the juni follow-up ---------------------------------------------
  const t1Start = Date.now();
  const r1 = await performTurn({
    messages: [
      { role: 'user', content: 'Vertel eens hoe het afgelopen jaar ging.' },
      { role: 'assistant', content: 'Ik zie vooral veel sessies rond juni — zeker gezien de context rond juni destijds.' },
      { role: 'user', content: 'wat was er in juni ook alweer?' },
    ],
    documents: DOCUMENTS,
    hermes: { chat: async () => 'antwoord' },
    hindsight: { recall: async () => [], reflect: async () => {} },
    conversationId: 'juni-live',
    intentIQ: ANCHORED,
    reasonIQ: async () => ({}),
    tools,
  });
  const t1Ms = Date.now() - t1Start;
  console.log('§21 Turn: "wat was er in juni ook alweer?" (na Gaia\'s juni-verwijzing)');
  console.log(`  status=${r1.status} latency=${t1Ms}ms`);
  console.log('  reply:');
  console.log(r1.body.reply.split('\n').map((l) => `    ${l}`).join('\n'));
  const foundGaiaJuni = /context rond juni/.test(r1.body.reply);
  console.log(`\n  Gaia's eigen juni-turn gevonden: ${foundGaiaJuni ? 'JA ✓' : 'NEE ✗'}`);
  console.log('  geen clarification nodig: ' + (r1.status === 200 ? 'JA ✓' : 'NEE ✗'));

  // --- §22: saved-only content ----------------------------------------------
  const t2Start = Date.now();
  const r2 = await performTurn({
    messages: [{ role: 'user', content: 'Wat zei ik vorige maand over klantcommunicatie?' }],
    documents: DOCUMENTS,
    hermes: { chat: async () => 'antwoord' },
    hindsight: { recall: async () => [], reflect: async () => {} },
    conversationId: 'nieuw-vandag',
    intentIQ: ANCHORED,
    reasonIQ: async () => ({}),
    tools,
    decisionEngine: (input) => {
      // Gaia's explicit scope choice for a saved-history question (spec §23):
      // the DECISION pins it, never the capability.
      const { decide } = require('../src/decision/decisionEngine');
      const decision = decide(input);
      if (decision.capability === 'conversation_search') {
        decision.input.scope = 'saved';
      }
      return decision;
    },
  });
  const t2Ms = Date.now() - t2Start;
  console.log('\n§22 Vraag over opgeslagen conversation (scope=saved door Decision gekozen)');
  console.log(`  status=${r2.status} latency=${t2Ms}ms`);
  console.log('  reply:');
  console.log(r2.body.reply.split('\n').map((l) => `    ${l}`).join('\n'));
  const foundSaved = /klantcommunicatie/.test(r2.body.reply);
  console.log(`\n  oude opgeslagen conversatie gevonden: ${foundSaved ? 'JA ✓' : 'NEE ✗'}`);

  console.log(`\nlatency: turn1=${t1Ms}ms turn2=${t2Ms}ms (capability zelf: geen LLM-, geen Hindsight-call)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
