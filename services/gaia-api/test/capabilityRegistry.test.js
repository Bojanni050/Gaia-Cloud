'use strict';

/**
 * Capability Registry 1.0 — skill-aware capabilities tests.
 *
 * Covers: registry contents (official Hermes catalog names, routing flags,
 * no duplicates), skill/capability validation, registry-driven awareness
 * rendering, and the registry's own purity boundary.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  CAPABILITY_REGISTRY,
  getCapabilityProfile,
  listCapabilityIds,
  hasSkill,
  getSkill,
  validateCapabilitySkill,
  routingSkills,
} = require('../src/capabilityRegistry');
const { renderCapabilityAwareness } = require('../src/capabilityAwareness');

// --- §18 Registry --------------------------------------------------------------

test('hermes is ONE capability with a skill inventory — not one capability per skill', () => {
  const hermes = getCapabilityProfile('hermes');
  assert.ok(hermes);
  assert.equal(hermes.type, 'generation');
  assert.ok(hermes.skills.length >= 3);
  // The audit-verified baseline is recorded as metadata.
  assert.equal(hermes.baseline.id, 'identity_grounded_conversation');
  assert.equal(hermes.baseline.routing, false);
});

test('skill ids are the OFFICIAL Hermes Bundled Skills Catalog names', () => {
  const hermes = getCapabilityProfile('hermes');
  const officialCatalogNames = new Set([
    'systematic-debugging', 'test-driven-development', 'requesting-code-review',
    'grounded-citations', 'plan',
  ]);
  for (const s of hermes.skills) {
    assert.ok(officialCatalogNames.has(s.id), `non-catalog skill id: ${s.id}`);
  }
  // The spec's two named examples are present with routing:true.
  assert.equal(getSkill('hermes', 'systematic-debugging').routing, true);
  assert.equal(getSkill('hermes', 'test-driven-development').routing, true);
  assert.equal(getSkill('hermes', 'systematic-debugging').category, 'development');
});

test('routing flags: only selection-relevant skills are routing targets', () => {
  const routing = routingSkills('hermes').map((s) => s.id).sort();
  assert.deepEqual(routing, ['requesting-code-review', 'systematic-debugging', 'test-driven-development']);
  // Non-routing metadata exists but is flagged honestly.
  assert.equal(getSkill('hermes', 'plan').routing, false);
  assert.equal(getSkill('hermes', 'grounded-citations').routing, false);
});

test('no duplicate skill ids within any capability; every skill has category + description', () => {
  for (const id of listCapabilityIds()) {
    const profile = getCapabilityProfile(id);
    const ids = profile.skills.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length, `duplicate skill in ${id}`);
    for (const s of profile.skills) {
      assert.ok(s.category && s.description && typeof s.routing === 'boolean', `${id}/${s.id} incomplete`);
    }
  }
});

test('other Gaia capabilities carry their function modes as non-routing skills', () => {
  assert.ok(hasSkill('conversation_search', 'current-conversation-search'));
  assert.ok(hasSkill('conversation_search', 'saved-conversation-search'));
  assert.ok(hasSkill('hindsight', 'memory-retrieval'));
  assert.ok(hasSkill('hindsight', 'pattern-retrieval'));
  assert.ok(hasSkill('web', 'web-search'));
  // None of these are routing targets — scope/source selection is Decision input.
  for (const s of routingSkills('conversation_search').concat(routingSkills('hindsight')).concat(routingSkills('web'))) {
    assert.fail(`no retrieval capability skill should be routing:true: ${s.id}`);
  }
});

test('foundation is registered as the archive counterpart of hindsight (retrieval, non-routing skill)', () => {
  const foundation = getCapabilityProfile('foundation');
  assert.ok(foundation, 'foundation must be in the registry — awareness renders from it');
  assert.equal(foundation.type, 'retrieval');
  assert.ok(hasSkill('foundation', 'foundation-memory-search'));
  assert.equal(routingSkills('foundation').length, 0, 'archive selection is Decision input, never a skill target');
});

test('memory is registered as a capability and renders in awareness with hindsight', () => {
  const memory = getCapabilityProfile('memory');
  assert.ok(memory, 'memory must be in the registry — awareness renders from it');
  assert.equal(memory.type, 'capability');
  const own = getCapabilityProfile('own_memory');
  assert.ok(own, 'own_memory must be in the registry — Aion renders from it');
  const block = renderCapabilityAwareness([{ id: 'hindsight' }, { id: 'memory' }, { id: 'own_memory' }]);
  assert.match(block, /- hindsight: your long-term memory/);
  assert.match(block, /- memory: keeping something in memory/);
  assert.match(block, /- own_memory: your own memory/);
});

test('a turn with Hindsight recall, a memory tool and Aion tells Gaia she genuinely has all three', async () => {
  const { performTurn } = require('../src/turn');
  let captured = null;
  const generator = {
    toolNames: ['remember'],
    generate: async (messages) => { captured = messages; return 'ok'; },
  };
  await performTurn({
    messages: [{ role: 'user', content: 'hallo' }],
    documents: { 'soul.md': 'S', 'principles.md': 'P', 'lexicon.md': 'L' },
    generator,
    hindsight: { recall: async () => [] },
    aion: { noteTurn: async () => ({}) },
  });
  const block = (captured || []).find((m) => m.role === 'system' && /Capabilities you genuinely have THIS turn/.test(m.content));
  assert.ok(block, 'capability awareness block must be present');
  assert.match(block.content, /- hindsight:/);
  assert.match(block.content, /- memory:/);
  assert.match(block.content, /- own_memory:/);
});

// --- §10/§18: skill + capability validation -------------------------------------

test('validateCapabilitySkill: known combo valid; unknown skill / unknown capability invalid', () => {
  assert.equal(validateCapabilitySkill('hermes', 'systematic-debugging'), null);
  assert.match(validateCapabilitySkill('hermes', 'made-up-skill'), /does not expose skill/);
  assert.match(validateCapabilitySkill('nonexistent', 'systematic-debugging'), /not registered/);
  assert.equal(validateCapabilitySkill('hermes', null), null); // no skill claimed
});

// --- §18: Awareness is registry-driven (no hardcoding) ----------------------------

test('awareness renders skills dynamically from the registry, compactly', () => {
  const block = renderCapabilityAwareness([{ id: 'hermes' }, { id: 'conversation_search' }]);
  assert.match(block, /Capabilities you genuinely have THIS turn/);
  assert.match(block, /- hermes: deeper reasoning/);
  // Skill line is derived from the registry, verbatim ids, comma-joined.
  const expectedSkillLine = `  skills: ${getCapabilityProfile('hermes').skills.map((s) => s.id).join(', ')}`;
  assert.ok(block.includes(expectedSkillLine), 'skill line must come from the registry');
  assert.match(block, /skills: current-conversation-search, saved-conversation-search, all-sources-search/);
  // Compact: no skill descriptions in the prompt block.
  assert.ok(!block.includes('4-phase root cause debugging'));
});

test('awareness: unregistered capability ids are never claimed', () => {
  const block = renderCapabilityAwareness([{ id: 'hermes' }, { id: 'mystery_capability' }]);
  assert.ok(!block.includes('mystery_capability'));
});

test('v3.0 Hermes isolation: a configured generator never calls Hermes on the live path', async () => {
  // Hermes is an explicit HADES instrument, never an inference fallback:
  // even when a hermes client is passed alongside a generator, the live
  // turn speaks only through the configured generation route.
  const { performTurn, performStreamingTurn } = require('../src/turn');
  let hermesCalls = 0;
  const hermes = {
    chat: async () => { hermesCalls += 1; return 'hermes reply'; },
    stream: async () => { hermesCalls += 1; return 'hermes reply'; },
  };
  const generator = { generate: async () => 'generation reply' };
  const documents = { 'soul.md': 'S', 'principles.md': 'P', 'lexicon.md': 'L' };

  const nonStream = await performTurn({
    messages: [{ role: 'user', content: 'hallo' }],
    documents,
    hermes,
    generator,
  });
  assert.equal(nonStream.body.reply, 'generation reply');

  const res = { writeHead() {}, write() {}, end() {}, status() { return this; }, json() {} };
  await performStreamingTurn({
    messages: [{ role: 'user', content: 'hallo' }],
    documents,
    hermes,
    generator: { generate: async () => 'generation reply', stream: async (m, { onDelta }) => { onDelta('generation reply', false); return 'generation reply'; } },
    res,
  });
  assert.equal(hermesCalls, 0, 'Hermes must never be called when generation is configured');
});

// --- Boundary ------------------------------------------------------------------

test('boundary: the registry is pure frozen data — zero requires, zero I/O', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/capabilityRegistry.js'), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
  const required = [...source.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((m) => m[2]);
  assert.deepEqual(required, []);
  // No I/O patterns. (Capability/skill NAMES like "hindsight" are registry
  // DATA here, not module references.)
  assert.ok(!/fetch\(|https?:\/\/|require\(/i.test(source));
  // Frozen at every level: profiles and skills cannot be mutated.
  const hermes = getCapabilityProfile('hermes');
  assert.equal(Object.isFrozen(hermes), true);
  assert.equal(Object.isFrozen(hermes.skills), true);
});

test('boundary: awareness renders only from the registry', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/capabilityAwareness.js'), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
  const required = [...source.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((m) => m[2]);
  assert.deepEqual(required, ['./capabilityRegistry']);
  assert.ok(!/hindsight|web|brave|mcp|decisionEngine/i.test(source));
});
