'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getAssistantIdentity, getUserIdentity, getConversationContext } = require('../src/identity');
const { reflectOnTurn } = require('../src/memory');
const { createHindsightClient } = require('../src/hindsightClient');

// Helper to capture reflect payload
function mockHindsight(capture) {
  return {
    reflect: async (payload) => {
      capture.payload = payload;
    },
    recall: async () => [],
  };
}

test('identity: assistant is always Gaia', () => {
  const a = getAssistantIdentity();
  assert.equal(a.displayName, 'Gaia');
  assert.equal(a.id, 'gaia');
  // Ensure no Hermes leakage
  assert.ok(!a.displayName.includes('Hermes'));
});

test('identity: user defaults to Bojan for dev', () => {
  delete process.env.GAIA_USER_DISPLAY_NAME;
  const u = getUserIdentity();
  assert.equal(u.displayName, 'Bojan');
  assert.equal(u.id, 'bojan');
});

test('identity: user can be overridden via explicit displayName', () => {
  const u = getUserIdentity({ displayName: 'Alice' });
  assert.equal(u.displayName, 'Alice');
  assert.equal(u.id, 'alice');
});

test('identity: user can be overridden via GAIA_USER_DISPLAY_NAME env', () => {
  const prev = process.env.GAIA_USER_DISPLAY_NAME;
  process.env.GAIA_USER_DISPLAY_NAME = 'John';
  const u = getUserIdentity();
  assert.equal(u.displayName, 'John');
  if (prev === undefined) delete process.env.GAIA_USER_DISPLAY_NAME;
  else process.env.GAIA_USER_DISPLAY_NAME = prev;
});

test('identity: user can be derived from req header x-user-display-name', () => {
  const u = getUserIdentity({ req: { headers: { 'x-user-display-name': 'Alice' } } });
  assert.equal(u.displayName, 'Alice');
});

test('identity: getConversationContext returns Gaia and user', () => {
  const ctx = getConversationContext({ userDisplayName: 'Bojan' });
  assert.equal(ctx, 'conversation between Gaia and Bojan');
  const ctx2 = getConversationContext({ userDisplayName: 'Alice' });
  assert.equal(ctx2, 'conversation between Gaia and Alice');
});

test('Hindsight conversational record is stored as Gaia ↔ Bojan (default)', async () => {
  const capture = {};
  const client = {
    reflect: async ({ domain, context, summary, provenance, metadata }) => {
      capture.domain = domain;
      capture.context = context;
      capture.summary = summary;
      capture.metadata = metadata;
      capture.provenance = provenance;
    }
  };
  // Mock hindsightClient to capture what memory.js sends
  const hindsight = {
    reflect: async (payload) => {
      // Simulate hindsightClient's mapping: domain -> tags, context -> context
      capture.payload = payload;
    }
  };
  // Use real reflectOnTurn which calls hindsight.reflect
  const fakeHindsight = {
    reflect: async (opts) => {
      capture.opts = opts;
    }
  };
  // Directly test reflectOnTurn
  reflectOnTurn(fakeHindsight, {
    conversationId: 'conv-123',
    userText: 'Ik ben in Maarn',
    assistantText: 'Leuk, hoe is het daar?',
    metadata: { gaia_memory_ingest: 'retain' },
  });
  // Wait for async catch (fire-and-forget is async but we made it sync via await in test helper? reflectOnTurn is fire-and-forget, need to wait)
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(capture.opts);
  assert.equal(capture.opts.domain, 'context');
  assert.equal(capture.opts.context, 'conversation between Gaia and Bojan');
  assert.match(capture.opts.summary, /^Bojan: Ik ben in Maarn/);
  assert.match(capture.opts.summary, /Gaia: Leuk/);
  assert.equal(capture.opts.metadata.agent_identity, 'Gaia');
  assert.equal(capture.opts.metadata.conversation_agent, 'Gaia');
  assert.equal(capture.opts.metadata.user_display_name, 'Bojan');
  assert.ok(!capture.opts.summary.includes('Hermes'));
  assert.ok(!capture.opts.context.includes('Hermes'));
  assert.ok(!capture.opts.metadata.agent_identity.includes('Hermes'));
});

test('No Hindsight conversational record contains Hermes Agent as assistant identity', async () => {
  const fakeHindsight = {
    reflect: async (opts) => {
      assert.equal(opts.metadata.agent_identity, 'Gaia');
      assert.ok(!opts.context.includes('Hermes'));
      assert.ok(!opts.summary.includes('Hermes Agent'));
      assert.ok(!JSON.stringify(opts).includes('Hermes Agent'));
    }
  };
  reflectOnTurn(fakeHindsight, {
    conversationId: 'c1',
    userText: 'Kun je dit voor me regelen?',
    assistantText: 'Natuurlijk, ik regel het.',
    metadata: {},
  });
  await new Promise((r) => setImmediate(r));
});

test('Calling Hermes does not change conversation identity (capability_executor separate)', async () => {
  let captured = null;
  const fakeHindsight = {
    reflect: async (opts) => { captured = opts; }
  };
  reflectOnTurn(fakeHindsight, {
    conversationId: 'c1',
    userText: 'Kun je dit voor me regelen?',
    assistantText: 'Gedaan via Hermes.',
    metadata: {},
    capabilityExecutor: 'hermes',
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(captured.metadata.agent_identity, 'Gaia');
  assert.equal(captured.metadata.conversation_agent, 'Gaia');
  assert.equal(captured.capabilityExecutor, undefined); // not top-level
  assert.equal(captured.metadata.capability_executor, 'hermes');
  assert.equal(captured.context, 'conversation between Gaia and Bojan');
  // Hermes appears only as executor, not as agent
  assert.ok(!captured.context.includes('Hermes'));
});

test('Calling another capability does not change conversation identity', async () => {
  let captured = null;
  const fakeHindsight = {
    reflect: async (opts) => { captured = opts; }
  };
  reflectOnTurn(fakeHindsight, {
    conversationId: 'c1',
    userText: 'Speel een liedje',
    assistantText: 'Hier is je liedje',
    metadata: {},
    capabilityExecutor: 'melodiq',
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(captured.metadata.agent_identity, 'Gaia');
  assert.equal(captured.metadata.capability_executor, 'melodiq');
  assert.equal(captured.context, 'conversation between Gaia and Bojan');
});

test('agent_identity=default cannot result in Hermes being exposed', async () => {
  let captured = null;
  const fakeHindsight = {
    reflect: async (opts) => { captured = opts; }
  };
  // Even if caller tries to pass agent_identity=default in metadata, it must be overridden to Gaia
  reflectOnTurn(fakeHindsight, {
    conversationId: 'c1',
    userText: 'I always work better after midnight, remember that',
    assistantText: 'Noted, I will remember your preference for late nights.',
    metadata: { agent_identity: 'default', platform: 'api_server' },
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(captured.metadata.agent_identity, 'Gaia');
  assert.notEqual(captured.metadata.agent_identity, 'default');
  assert.ok(!captured.metadata.agent_identity.includes('Hermes'));
});

test('User identity is dynamically supplied rather than hardcoded inside Hindsight adapter', async () => {
  // Verify that hindsightClient itself does not hardcode Bojan/Gaia
  const fs = require('fs');
  const path = require('path');
  const clientSrc = fs.readFileSync(path.join(__dirname, '../src/hindsightClient.js'), 'utf-8');
  const codeOnly = clientSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
  assert.ok(!codeOnly.includes('Bojan'), 'hindsightClient must not hardcode Bojan');
  assert.ok(!codeOnly.includes('Hermes Agent'), 'hindsightClient must not hardcode Hermes Agent');
  // memory.js should not hardcode "Bo:" literal either (now uses identity)
  const memorySrc = fs.readFileSync(path.join(__dirname, '../src/memory.js'), 'utf-8');
  const memoryCode = memorySrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
  // Allow the test helper string but not the production summary literal "Bo: "
  // The new code uses `${userIdentity.displayName}:`
  assert.ok(memoryCode.includes('getUserIdentity') || memoryCode.includes('getAssistantIdentity'), 'memory.js must use identity module');
  assert.ok(!memoryCode.includes('`Bo: ${userText}'), 'memory.js must not hardcode Bo: literal');
});

test('Future user identity Alice produces Gaia ↔ Alice without code changes', async () => {
  let captured = null;
  const fakeHindsight = {
    reflect: async (opts) => { captured = opts; }
  };
  reflectOnTurn(fakeHindsight, {
    conversationId: 'c1',
    userText: 'Hallo Gaia, I wanted to share how my day went today',
    assistantText: 'Hallo Alice, I am glad you shared that with me',
    metadata: {},
    userDisplayName: 'Alice',
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(captured.context, 'conversation between Gaia and Alice');
  assert.equal(captured.summary, 'Alice: Hallo Gaia, I wanted to share how my day went today\n\nGaia: Hallo Alice, I am glad you shared that with me');
  assert.equal(captured.metadata.user_display_name, 'Alice');
  assert.equal(captured.metadata.agent_identity, 'Gaia');

  // Also via identity module directly
  const ctx = getConversationContext({ userDisplayName: 'John' });
  assert.equal(ctx, 'conversation between Gaia and John');
});

test('Internal Hermes execution metadata may still identify Hermes where appropriate', async () => {
  let captured = null;
  const fakeHindsight = {
    reflect: async (opts) => { captured = opts; }
  };
  reflectOnTurn(fakeHindsight, {
    conversationId: 'c1',
    userText: 'Please handle this task for me with some context',
    assistantText: 'I have handled your task via the internal capability.',
    metadata: {},
    capabilityExecutor: 'hermes',
  });
  await new Promise((r) => setImmediate(r));
  // Hermes is allowed as capability_executor
  assert.equal(captured.metadata.capability_executor, 'hermes');
  // But conversational identity remains Gaia
  assert.equal(captured.metadata.agent_identity, 'Gaia');
  assert.equal(captured.metadata.conversation_agent, 'Gaia');
});

test('Existing Hindsight memory functionality remains intact (domain tag still context)', async () => {
  let captured = null;
  const fakeHindsight = {
    reflect: async (opts) => { captured = opts; }
  };
  reflectOnTurn(fakeHindsight, {
    conversationId: 'c1',
    userText: 'I always work better after midnight, remember that',
    assistantText: 'Noted.',
    metadata: { gaia_memory_ingest: 'retain' },
  });
  await new Promise((r) => setImmediate(r));
  // Tags should still be ['context'] via domain
  assert.equal(captured.domain, 'context');
  assert.equal(captured.context, 'conversation between Gaia and Bojan');
  assert.equal(captured.metadata.gaia_memory_ingest, 'retain');
});
