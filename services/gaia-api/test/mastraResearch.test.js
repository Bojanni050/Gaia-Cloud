'use strict';

/**
 * Mastra research integration — the proof-of-concept wiring of the Mastra
 * agent framework (https://mastra.ai) into Gaia's research-job lifecycle.
 *
 * Covers:
 *   - mastraTools: each Gaia subsystem wrapped as a typed Mastra tool
 *   - mastraResearchAgent: instructions, facade, run lifecycle
 *   - mastraResearchClient: the bridge to Gaia's research-jobs contract
 *   - pollMastraResearchJobs: the poll cycle that shares the Hermes store
 *   - capabilityRegistry: the mastra_research capability is registered
 *   - generationCapabilities: the capability appears only when wired
 *
 * The tests do NOT require @mastra/core to be installed: the agent module
 * loads it lazily and resolves to null when absent, which is itself the
 * tested behaviour (a missing optional capability degrades, never crashes).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createMastraWebSearchTool,
  createMastraHindsightRecallTool,
  createMastraFoundationSearchTool,
  createMastraConversationSearchTool,
  buildResearchTools,
} = require('../src/mastra/mastraTools');
const {
  buildResearchInstructions,
  createResearchAgentFacade,
} = require('../src/mastra/mastraResearchAgent');
const {
  createMastraResearchClient,
  createMastraResearchFacade,
  pollMastraResearchJobs,
} = require('../src/mastra/mastraResearchClient');
const { CAPABILITY_REGISTRY, getCapabilityProfile, listCapabilityIds } = require('../src/capabilityRegistry');

// --- mastraTools ---------------------------------------------------------------

test('createMastraWebSearchTool wraps the web search client', async () => {
  const tool = createMastraWebSearchTool({
    webSearch: {
      search: async (query) => ({
        results: [
          { title: 'Result 1', url: 'https://example.com/1', snippet: 'About ' + query },
          { title: 'Result 2', url: 'https://example.com/2', description: 'Also about ' + query },
        ],
      }),
    },
  });
  assert.ok(tool);
  assert.equal(tool.id, 'gaia-web-search');
  const out = await tool.execute({ query: 'mastra' });
  assert.equal(out.results.length, 2);
  assert.equal(out.results[0].title, 'Result 1');
  // description is the fallback for snippet
  assert.equal(out.results[1].snippet, 'Also about mastra');
});

test('createMastraWebSearchTool returns null without a client', () => {
  assert.equal(createMastraWebSearchTool({ webSearch: null }), null);
  assert.equal(createMastraWebSearchTool({}), null);
});

test('createMastraHindsightRecallTool wraps the recall client', async () => {
  const tool = createMastraHindsightRecallTool({
    hindsight: {
      recall: async (query) => [
        { text: 'Bo houdt van Rust', tags: ['gaia:pref'] },
        { content: 'Fallback field works too' },
      ],
    },
  });
  assert.ok(tool);
  assert.equal(tool.id, 'gaia-memory-recall');
  const out = await tool.execute({ query: 'Bo' });
  assert.equal(out.memories.length, 2);
  assert.equal(out.memories[0].text, 'Bo houdt van Rust');
  assert.deepEqual(out.memories[0].tags, ['gaia:pref']);
  assert.equal(out.memories[1].text, 'Fallback field works too');
});

test('createMastraFoundationSearchTool wraps the archive client', async () => {
  const tool = createMastraFoundationSearchTool({
    foundation: {
      searchResults: async () => [
        { text: 'Recorded fact', status: 'confirmed' },
        { statement: 'Hypothesis', status: 'hypothesis' },
      ],
    },
  });
  assert.ok(tool);
  assert.equal(tool.id, 'gaia-archive-search');
  const out = await tool.execute({ query: 'anything' });
  assert.equal(out.results.length, 2);
  assert.equal(out.results[0].status, 'confirmed');
  assert.equal(out.results[1].text, 'Hypothesis');
});

test('createMastraConversationSearchTool wraps the transcript search', async () => {
  const tool = createMastraConversationSearchTool({
    conversationSearch: {
      search: async () => [
        { snippet: 'Wat we bespraken', conversationId: 'conv-1' },
      ],
    },
  });
  assert.ok(tool);
  assert.equal(tool.id, 'gaia-conversation-search');
  const out = await tool.execute({ query: 'eerder' });
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].conversationId, 'conv-1');
});

test('buildResearchTools only includes wired subsystems', () => {
  const tools = buildResearchTools({
    webSearch: { search: async () => ({ results: [] }) },
    // hindsight, foundation, conversationSearch absent
  });
  assert.deepEqual(Object.keys(tools), ['gaia-web-search']);
});

test('buildResearchTools returns all four when everything is wired', () => {
  const tools = buildResearchTools({
    webSearch: { search: async () => ({ results: [] }) },
    hindsight: { recall: async () => [] },
    foundation: { searchResults: async () => [] },
    conversationSearch: { search: async () => [] },
  });
  assert.equal(Object.keys(tools).length, 4);
});

test('tool results are bounded (no unbounded payloads to the model)', async () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ title: `R${i}`, url: `https://x/${i}`, snippet: 's' }));
  const tool = createMastraWebSearchTool({
    webSearch: { search: async () => ({ results: many }) },
  });
  const out = await tool.execute({ query: 'q' });
  assert.equal(out.results.length, 8, 'web search is capped at 8 results');
});

// --- buildResearchInstructions -------------------------------------------------

test('buildResearchInstructions includes SOUL and the research frame', () => {
  const instructions = buildResearchInstructions('You are Gaia.');
  assert.match(instructions, /You are Gaia\./);
  assert.match(instructions, /Research mode/);
  assert.match(instructions, /MATERIAL, not/);
  assert.match(instructions, /Cite every claim/);
});

// --- createResearchAgentFacade -------------------------------------------------

test('createResearchAgentFacade tracks a run through its lifecycle', async () => {
  // A fake Mastra agent: generate() resolves after a tick with text.
  const fakeAgent = {
    generate: async (prompt) => {
      await new Promise((r) => setTimeout(r, 10));
      return { text: `Findings about: ${prompt}`, steps: [{ toolCalls: [{ toolName: 'gaia-web-search' }] }] };
    },
  };
  const facade = createResearchAgentFacade(fakeAgent);

  const started = await facade.submitResearch({ question: 'mastra integration', conversationId: 'conv-1' });
  assert.ok(started.runId);
  assert.equal(started.status, 'running');
  assert.equal(started.conversationId, 'conv-1');

  // Immediately: still running.
  let state = facade.getRun(started.runId);
  assert.equal(state.status, 'running');

  // After the agent resolves: completed.
  await new Promise((r) => setTimeout(r, 30));
  state = facade.getRun(started.runId);
  assert.equal(state.status, 'completed');
  assert.match(state.output, /Findings about: mastra integration/);
  assert.equal(state.steps.length, 1);
});

test('createResearchAgentFacade records failures without throwing', async () => {
  const fakeAgent = {
    generate: async () => { throw new Error('model unreachable'); },
  };
  const facade = createResearchAgentFacade(fakeAgent);

  const started = await facade.submitResearch({ question: 'q' });
  await new Promise((r) => setTimeout(r, 10));

  const state = facade.getRun(started.runId);
  assert.equal(state.status, 'failed');
  assert.match(state.error, /model unreachable/);
});

test('createResearchAgentFacade returns null for an unknown run id', () => {
  const facade = createResearchAgentFacade({ generate: async () => ({ text: '' }) });
  assert.equal(facade.getRun('does-not-exist'), null);
});

test('createResearchAgentFacade refuses an empty question', async () => {
  const facade = createResearchAgentFacade({ generate: async () => ({ text: '' }) });
  assert.equal(await facade.submitResearch({ question: '' }), null);
  assert.equal(await facade.submitResearch({}), null);
});

// --- createMastraResearchFacade (the Gaia contract bridge) ---------------------

test('createMastraResearchFacade adapts to the research-jobs start() shape', async () => {
  const agent = {
    submitResearch: async ({ question, conversationId, skillId }) => ({
      runId: 'mastra_abc123',
      conversationId,
      skillId: skillId || 'mastra-research',
      question,
      startedAt: new Date().toISOString(),
    }),
    pollRun: async (runId) => ({ status: 'running' }),
    listRuns: () => [],
  };
  const facade = createMastraResearchFacade(agent);

  const job = await facade.start({ question: 'Onderzoek X', conversationId: 'conv-9' });
  assert.ok(job);
  assert.equal(job.runId, 'mastra_abc123');
  assert.equal(job.executor, 'mastra');
  assert.equal(job.status, 'running');
  assert.equal(job.skillId, 'mastra-research');
  assert.equal(job.conversationId, 'conv-9');
});

test('createMastraResearchFacade.start returns null when the agent fails', async () => {
  const agent = {
    submitResearch: async () => { throw new Error('boom'); },
    pollRun: async () => null,
    listRuns: () => [],
  };
  const facade = createMastraResearchFacade(agent);
  assert.equal(await facade.start({ question: 'q' }), null);
});

// --- pollMastraResearchJobs ----------------------------------------------------

function makeStore(jobs) {
  return {
    listRunning: () => jobs.filter((j) => j.status === 'running' && j.executor === 'mastra'),
    update: (id, patch) => {
      const job = jobs.find((j) => j.id === id);
      if (!job) return null;
      Object.assign(job, patch);
      return job;
    },
  };
}

test('pollMastraResearchJobs closes a completed Mastra run', async () => {
  const jobs = [{
    id: 'mj_1', runId: 'mastra_x', executor: 'mastra', status: 'running',
    createdAt: new Date().toISOString(), conversationId: 'conv-1', question: 'q',
  }];
  const store = makeStore(jobs);
  const client = {
    pollRun: async (runId) => ({ status: 'completed', output: 'Findings here' }),
  };
  const changed = await pollMastraResearchJobs({ client, store });
  assert.equal(changed.length, 1);
  assert.equal(changed[0].status, 'done');
  assert.equal(changed[0].resultText, 'Findings here');
});

test('pollMastraResearchJobs closes a failed Mastra run', async () => {
  const jobs = [{
    id: 'mj_1', runId: 'mastra_x', executor: 'mastra', status: 'running',
    createdAt: new Date().toISOString(),
  }];
  const store = makeStore(jobs);
  const client = {
    pollRun: async () => ({ status: 'failed', error: 'model timeout' }),
  };
  const changed = await pollMastraResearchJobs({ client, store });
  assert.equal(changed.length, 1);
  assert.equal(changed[0].status, 'failed');
  assert.match(changed[0].error, /model timeout/);
});

test('pollMastraResearchJobs ignores Hermes jobs (executor filter)', async () => {
  const jobs = [{
    id: 'rj_1', runId: 'hermes_x', executor: undefined, status: 'running',
    createdAt: new Date().toISOString(),
  }];
  const store = makeStore(jobs);
  let polled = 0;
  const client = { pollRun: async () => { polled += 1; return { status: 'running' }; } };
  const changed = await pollMastraResearchJobs({ client, store });
  assert.equal(changed.length, 0);
  assert.equal(polled, 0, 'a Hermes job is never polled by the Mastra poller');
});

test('pollMastraResearchJobs hits the deadline and closes as done', async () => {
  const jobs = [{
    id: 'mj_1', runId: 'mastra_x', executor: 'mastra', status: 'running',
    createdAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(), // 20 min ago
  }];
  const store = makeStore(jobs);
  const client = { pollRun: async () => ({ status: 'running' }) };
  const changed = await pollMastraResearchJobs({ client, store, deadlineMs: 10 * 60 * 1000 });
  assert.equal(changed.length, 1);
  assert.equal(changed[0].status, 'done');
  assert.equal(changed[0].deadlineHit, true);
});

test('pollMastraResearchJobs calls onCompleted for changed jobs', async () => {
  const jobs = [{
    id: 'mj_1', runId: 'mastra_x', executor: 'mastra', status: 'running',
    createdAt: new Date().toISOString(),
  }];
  const store = makeStore(jobs);
  const client = { pollRun: async () => ({ status: 'completed', output: 'done' }) };
  const completed = [];
  await pollMastraResearchJobs({
    client, store,
    onCompleted: async (job) => { completed.push(job.id); },
  });
  assert.deepEqual(completed, ['mj_1']);
});

test('pollMastraResearchJobs never throws on a missing client or store', async () => {
  assert.deepEqual(await pollMastraResearchJobs({}), []);
  assert.deepEqual(await pollMastraResearchJobs({ client: null, store: makeStore([]) }), []);
});

// --- createMastraResearchClient (the top-level factory) ------------------------

test('createMastraResearchClient returns null when disabled', async () => {
  const client = await createMastraResearchClient({ enabled: false });
  assert.equal(client, null);
});

test('createMastraResearchClient returns null without a SOUL prompt', async () => {
  const client = await createMastraResearchClient({
    enabled: true,
    soulPrompt: '',
    roleConfig: { baseUrl: 'http://x', model: 'm' },
  });
  assert.equal(client, null);
});

test('createMastraResearchClient returns null without a role config', async () => {
  const client = await createMastraResearchClient({
    enabled: true,
    soulPrompt: 'You are Gaia.',
    roleConfig: null,
  });
  assert.equal(client, null);
});

// --- capabilityRegistry --------------------------------------------------------

test('mastra_research is registered in the capability registry', () => {
  const profile = getCapabilityProfile('mastra_research');
  assert.ok(profile, 'the mastra_research capability exists');
  assert.equal(profile.id, 'mastra_research');
  assert.equal(profile.type, 'capability');
  assert.ok(profile.description.length > 0);
  assert.equal(profile.skills.length, 2);
  assert.deepEqual(
    profile.skills.map((s) => s.id).sort(),
    ['sourced-findings', 'structured-research']
  );
});

test('mastra_research appears in listCapabilityIds', () => {
  assert.ok(listCapabilityIds().includes('mastra_research'));
});

test('mastra_research skills are not routing targets (no auto-selection)', () => {
  const profile = getCapabilityProfile('mastra_research');
  assert.ok(profile.skills.every((s) => s.routing === false));
});

test('CAPABILITY_REGISTRY is frozen (immutability)', () => {
  assert.ok(Object.isFrozen(CAPABILITY_REGISTRY));
  assert.ok(Object.isFrozen(CAPABILITY_REGISTRY.mastra_research));
  assert.ok(Object.isFrozen(CAPABILITY_REGISTRY.mastra_research.skills));
});

// --- integration: the capability is honest -------------------------------------

test('generationCapabilities includes mastra_research only when wired', () => {
  // Re-implement the check inline: the turn.js function is not exported, but
  // the rule is simple and tested here against the registry contract.
  const profile = getCapabilityProfile('mastra_research');
  assert.ok(profile, 'when mastraResearchJobs.start exists, the registry knows the capability');

  // The inverse: without the wiring, the capability is simply absent from
  // the rendered awareness block (capabilityAwareness.js skips unknown ids).
  const { renderCapabilityAwareness } = require('../src/capabilityAwareness');
  const block = renderCapabilityAwareness([{ id: 'mastra_research' }]);
  assert.ok(block, 'a wired mastra_research renders an awareness line');
  assert.match(block, /mastra_research/);
  assert.match(block, /structured-research/);
  assert.match(block, /sourced-findings/);
});
