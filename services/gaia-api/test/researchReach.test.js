'use strict';

/**
 * Research reach — which turns qualify, and the exact wording Gaia hands to
 * Hermes. The run itself is covered in researchJob.test.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveReachSkill,
  buildReachPrompt,
  renderResearchContext,
  renderResearchPending,
  HERMES_OUTBOX_DIR,
} = require('../src/researchReach');

// --- which turns qualify -------------------------------------------------------

test('resolveReachSkill: research-with-sources wording selects grounded-citations', () => {
  assert.equal(resolveReachSkill('Doe research naar de beste EuroVPS-alternatieven.'), 'grounded-citations');
  assert.equal(resolveReachSkill('Zoek dit voor me uit met bronnen.'), 'grounded-citations');
  assert.equal(resolveReachSkill('Verdiep je in de markt voor AI-assistenten.'), 'grounded-citations');
});

test('resolveReachSkill: an ordinary turn is not a reach', () => {
  assert.equal(resolveReachSkill('Wat is de stand van zaken?'), null);
  assert.equal(resolveReachSkill(''), null);
  assert.equal(resolveReachSkill(null), null);
});

test('resolveReachSkill: naming the skill never selects it (spec §13)', () => {
  assert.equal(resolveReachSkill('Wat houdt grounded-citations in?'), null);
});

test('resolveReachSkill: a debugging shape keeps its own skill', () => {
  assert.equal(resolveReachSkill('Zoek uit waarom de login crasht.'), 'systematic-debugging');
});

// --- the wording handed to Hermes ---------------------------------------------

test('buildReachPrompt names the skill, the deliverable dir, and the question', () => {
  const prompt = buildReachPrompt({ skillId: 'grounded-citations', question: 'Wat kost Tailscale?' });

  assert.match(prompt, /`grounded-citations`/);
  assert.match(prompt, new RegExp(HERMES_OUTBOX_DIR.replace('/', '\\/')));
  assert.match(prompt, /Wat kost Tailscale\?/);
  assert.ok(prompt.trim().endsWith('Wat kost Tailscale?'));
});

// --- rendering -----------------------------------------------------------------

test('renderResearchContext states the boundary: material, not the answer', () => {
  const block = renderResearchContext({ skillId: 'grounded-citations', text: 'Bron: example.com' });
  assert.match(block, /Hermes-skill grounded-citations/);
  assert.match(block, /materiaal, niet je antwoord/);
  assert.match(block, /Bron: example\.com/);
  assert.equal(renderResearchContext(null), null);
  assert.equal(renderResearchContext({ skillId: 'x', text: '' }), null);
});

test('renderResearchPending tells Gaia to say it is still working', () => {
  const block = renderResearchPending({ skillId: 'grounded-citations' });
  assert.match(block, /loopt nu een onderzoeksopdracht/);
  assert.match(block, /grounded-citations/);
  assert.match(block, /Beloof geen resultaat dat je nog niet/);
  assert.equal(renderResearchPending(null), null);
});
