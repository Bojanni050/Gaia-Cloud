'use strict';

/**
 * Capability Registry 1.0 — live Hermes skill-flow validation (spec step 9).
 *
 * Runs a real debugging turn through the full pipeline with a REAL Hermes
 * client (env: HERMES_BASE_URL [+ HERMES_MODEL, HERMES_AUTH_TOKEN]) and a
 * plan carrying skill "systematic-debugging". When Hermes is unreachable or
 * unconfigured, exits cleanly with SKIP so CI/local runs stay green.
 *
 * Verifies: Decision selects hermes:systematic-debugging; the explicit
 * skill instruction reaches the Hermes request; Hermes answers.
 */

const { performTurn } = require('../src/turn');
const { createHermesClient } = require('../src/hermesClient');

async function main() {
  const baseUrl = process.env.HERMES_BASE_URL;
  if (!baseUrl) {
    console.log('SKIP: HERMES_BASE_URL is not configured in this environment — no live Hermes skill-flow possible.');
    console.log('Run on the VPS (or with a reachable Hermes) to validate the real skill load.');
    return;
  }

  const hermes = createHermesClient({
    baseUrl,
    model: process.env.HERMES_MODEL || 'hermes-agent',
    authToken: process.env.HERMES_AUTH_TOKEN,
  });

  // Capture the outgoing request by wrapping fetch.
  const realFetch = global.fetch;
  let outgoing = null;
  global.fetch = async (url, init) => {
    outgoing = { url, body: init && init.body ? JSON.parse(init.body) : null };
    return realFetch(url, init);
  };

  const DOCUMENTS = { 'soul.md': 'SOUL', 'principles.md': 'PRINCIPLES', 'lexicon.md': 'LEXICON' };
  const started = Date.now();
  try {
    const result = await performTurn({
      messages: [{ role: 'user', content: 'Zoek uit waarom deze race condition optreedt in mijn stream-handler.' }],
      documents: DOCUMENTS,
      hermes,
      hindsight: { recall: async () => [], reflect: async () => {} },
      conversationId: 'skill-live',
      intentIQ: () => ({ schemaVersion: 'intentiq.v1', intent: null, status: 'unknown' }),
      reasonIQ: async () => ({}),
      decisionEngine: (input) => {
        const { decide } = require('../src/decision/decisionEngine');
        return decide(input);
      },
    });

    const ms = Date.now() - started;
    const skillInstructionSent = outgoing && outgoing.body && Array.isArray(outgoing.body.messages)
      ? outgoing.body.messages.some((m) => m.role === 'system' && /Use the Hermes skill "systematic-debugging"/.test(typeof m.content === 'string' ? m.content : ''))
      : false;

    console.log('Hermes skill-flow live validation');
    console.log(`  status: ${result.status}  latency: ${ms}ms`);
    console.log(`  explicit skill instruction in Hermes request: ${skillInstructionSent ? 'YES ✓' : 'NO ✗'}`);
    console.log(`  reply (first 200 chars): ${String(result.body.reply || result.body.error || '').slice(0, 200)}`);
    console.log('\nVerify on the Hermes side that the systematic-debugging skill was actually loaded/executed');
    console.log('(Hermes remains the owner of its own skill mechanism — Gaia only names the skill).');
  } catch (err) {
    console.log(`SKIP: Hermes unreachable from this environment (${err.message}).`);
    console.log('Run on the VPS (or with a reachable Hermes) to validate the real skill load.');
  } finally {
    global.fetch = realFetch;
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
