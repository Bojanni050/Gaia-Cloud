'use strict';

/**
 * Mastra research agent — Gaia's deep research capability, built on Mastra.
 *
 * This is the proof-of-concept integration of https://mastra.ai into Gaia's
 * architecture. It does NOT replace the Hermes research reach
 * (researchReach.js + researchJob.js); it is a PARALLEL capability, switched
 * on by its own flag (GAIA_MASTRA_RESEARCH=on), so a deployment can run both
 * and compare, or migrate gradually.
 *
 * What the agent is: a typed Mastra Agent whose instructions are Gaia's SOUL
 * (loaded from identity/soul.md, the same constitution every turn uses), whose
 * model is Gaia's reasoning role (resolved through providerConfigResolver, so
 * the admin panel's role selection governs it — no separate Mastra env vars),
 * and whose tools are Gaia's own subsystems (web search, Hindsight recall,
 * Foundation archive, conversation search) wrapped as Mastra tools.
 *
 * What the agent is NOT: a second Gaia. It produces FINDINGS — material,
 * sources, structure — never the reply. The turn that submitted the research
 * still owns the answer, in Gaia's voice, through responseEngine.js. This is
 * the same boundary researchReach.js draws ("materiaal, geen antwoord").
 *
 * Why Mastra for this: Mastra's agent loop handles tool calling, retries and
 * multi-step reasoning natively; its workflows could later add human-in-the-loop
 * checkpoints (suspend/resume for approvals); its memory could persist research
 * threads; its observability (traces, evals, scorers) gives Gaia's research a
 * measurement surface Hermes' skill-naming approach does not have.
 *
 * Why CommonJS with a dynamic import: gaia-api is `"type": "commonjs"`.
 * Mastra's packages (`@mastra/core`, `@mastra/memory`) are ESM-only, so this
 * module loads them lazily inside an async factory. Callers never see the
 * ESM/CJS seam — they await `createMastraResearchAgent()` and get a plain
 * object with `submitResearch()` and `getRun()`.
 *
 * Failure posture: if Mastra is not installed, or the agent cannot be built,
 * `createMastraResearchAgent()` resolves to null. A missing optional
 * capability degrades to "not available", never to a broken turn — the same
 * rule every other Gaia subsystem follows.
 */

const { buildResearchTools } = require('./mastraTools');

/**
 * The instructions the research agent runs under: Gaia's SOUL, plus a short
 * research-specific frame that states the boundary (findings, not the reply)
 * and the sourcing discipline (cite, never invent).
 *
 * @param {string} soulPrompt Gaia's constitution, loaded by soul.js
 * @returns {string}
 */
function buildResearchInstructions(soulPrompt) {
  const soul = String(soulPrompt || '').trim();
  return [
    soul,
    '',
    '---',
    '',
    '## Research mode',
    '',
    'You are running as Gaia\'s research faculty — a background investigation',
    'she started because a question needed depth, sources and time. Your job is',
    'to gather MATERIAL, not to write her reply. She will answer the person',
    'herself, in her own voice, from what you find.',
    '',
    'Discipline:',
    '- Cite every claim. A finding without a source is a guess.',
    '- Use the tools: search the live web, recall what Gaia already understands,',
    '  search the recorded archive, search past conversations. Combine them.',
    '- Distinguish what is confirmed, what is hypothesis, what is unknown.',
    '- Return a structured summary: findings, sources, open questions.',
    '- Never address the person directly. This is material for Gaia, not a message to them.',
    '- Stay in the language of the question (Dutch in, Dutch findings).',
  ].join('\n');
}

/**
 * Resolves the Mastra model string from Gaia's provider config. Gaia speaks
 * OpenAI-compatible `/chat/completions`; Mastra's model router accepts
 * `provider/model` strings and reads provider keys from env. To stay inside
 * Gaia's provider abstraction (the admin panel owns provider+key+model), we
 * do NOT use Mastra's router here — instead we hand Mastra a custom model
 * via its `createModel` seam, pointing at Gaia's resolved baseUrl/model/key.
 *
 * This keeps the Invisible Implementation principle: no provider name, no
 * model name, no key ever crosses into a client response, and the admin
 * panel remains the single place an operator configures inference.
 *
 * @param {{ baseUrl: string, model: string, apiKey: string, provider: string }} roleConfig
 * @returns {Promise<object>} a Mastra-compatible model instance
 */
async function resolveMastraModel(roleConfig) {
  if (!roleConfig || !roleConfig.baseUrl || !roleConfig.model) {
    throw new Error('research role config is incomplete (baseUrl/model missing)');
  }
  // Mastra's `createModel` (from @mastra/core/llm) builds a model from an
  // OpenAI-compatible endpoint. Lazy import — ESM-only package.
  const { createModel } = await import('@mastra/core/llm');
  return createModel({
    provider: 'openai-compatible',
    baseUrl: roleConfig.baseUrl,
    apiKey: roleConfig.apiKey || '',
    model: roleConfig.model,
  });
}

/**
 * Creates the Mastra research agent.
 *
 * @param {{
 *   soulPrompt: string,
 *   roleConfig: { baseUrl: string, model: string, apiKey: string, provider: string },
 *   webSearch?: object,
 *   hindsight?: object,
 *   foundation?: object,
 *   conversationSearch?: object,
 *   storage?: object,
 * }} deps
 * @returns {Promise<object|null>} the agent facade, or null when unavailable
 */
async function createMastraResearchAgent(deps = {}) {
  const { soulPrompt, roleConfig } = deps;
  if (!soulPrompt) {
    console.warn('[gaia:mastra] no SOUL prompt — research agent not created');
    return null;
  }
  if (!roleConfig || !roleConfig.baseUrl || !roleConfig.model) {
    console.warn('[gaia:mastra] no reasoning role config — research agent not created');
    return null;
  }

  let MastraAgent;
  try {
    // ESM-only package, loaded lazily. A missing install resolves to null,
    // not a crash — the capability is optional by design.
    ({ Agent: MastraAgent } = await import('@mastra/core/agent'));
  } catch (err) {
    console.warn(`[gaia:mastra] @mastra/core not installed — research agent disabled (${err && err.message})`);
    return null;
  }

  const tools = buildResearchTools({
    webSearch: deps.webSearch,
    hindsight: deps.hindsight,
    foundation: deps.foundation,
    conversationSearch: deps.conversationSearch,
  });

  let model;
  try {
    model = await resolveMastraModel(roleConfig);
  } catch (err) {
    console.warn(`[gaia:mastra] could not build model — research agent disabled (${err && err.message})`);
    return null;
  }

  let agent;
  try {
    agent = new MastraAgent({
      id: 'gaia-research',
      name: 'Gaia Research',
      instructions: buildResearchInstructions(soulPrompt),
      model,
      tools,
    });
  } catch (err) {
    console.warn(`[gaia:mastra] agent construction failed — research agent disabled (${err && err.message})`);
    return null;
  }

  return createResearchAgentFacade(agent);
}

/**
 * Wraps the Mastra agent behind Gaia's research-job shape. The facade speaks
 * the same contract `researchJobs.start()` already uses: submit a question,
 * get a run id, poll for the result. Internally it drives the Mastra agent's
 * `generate()`; the run id is a Mastra run id so a future poller can use
 * Mastra's own run inspection.
 *
 * @param {object} agent the Mastra Agent instance
 */
function createResearchAgentFacade(agent) {
  const runs = new Map();

  async function submitResearch({ question, conversationId, skillId }) {
    if (!question) return null;
    const startedAt = new Date().toISOString();
    const runId = `mastra_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    const record = {
      runId,
      conversationId: conversationId || null,
      skillId: skillId || 'mastra-research',
      question: String(question),
      status: 'running',
      startedAt,
      resultText: null,
      error: null,
      steps: [],
    };
    runs.set(runId, record);

    // Fire-and-forget: the turn does not wait. The poller (or a future
    // Mastra-native run inspector) picks the result up later.
    agent.generate(String(question))
      .then((result) => {
        const text = (result && (result.text || result.content)) || '';
        const steps = Array.isArray(result && result.steps)
          ? result.steps.map((s) => ({
              toolCalls: Array.isArray(s && s.toolCalls) ? s.toolCalls.map((tc) => tc.toolName || tc.name) : [],
            }))
          : [];
        const entry = runs.get(runId);
        if (entry) {
          entry.status = 'completed';
          entry.resultText = String(text);
          entry.steps = steps;
          entry.finishedAt = new Date().toISOString();
        }
      })
      .catch((err) => {
        const entry = runs.get(runId);
        if (entry) {
          entry.status = 'failed';
          entry.error = (err && err.message) || 'research failed';
          entry.finishedAt = new Date().toISOString();
        }
      });

    return {
      runId,
      status: 'running',
      conversationId: record.conversationId,
      skillId: record.skillId,
      question: record.question,
      startedAt,
    };
  }

  function getRun(runId) {
    const entry = runs.get(runId);
    if (!entry) return null;
    return {
      status: entry.status,
      output: entry.resultText,
      error: entry.error,
      steps: entry.steps,
    };
  }

  function listRuns() {
    return Array.from(runs.values());
  }

  return { submitResearch, getRun, listRuns };
}

module.exports = {
  createMastraResearchAgent,
  buildResearchInstructions,
  createResearchAgentFacade,
};
