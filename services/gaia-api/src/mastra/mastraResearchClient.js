'use strict';

/**
 * Mastra research client — the bridge between a Mastra research agent and
 * Gaia's existing research-job lifecycle.
 *
 * Gaia already has an async research shape (researchJob.js): a turn submits
 * a job, answers immediately, and a poll cycle picks the findings up later,
 * writes them into the conversation, and announces them through
 * GET /research/jobs. This module plugs a Mastra agent INTO that same
 * lifecycle, so a Mastra research run is indistinguishable from a Hermes
 * research run from the client's point of view: same store, same poll
 * endpoint, same conversation write, same capability awareness.
 *
 * The two research paths (Hermes skill-naming vs Mastra agent) are PARALLEL,
 * not nested. A deployment enables one or the other (or both, to compare)
 * via env flags. They share the job store and the poll endpoint; they differ
 * in who does the investigating.
 *
 * Boundary: this client never produces Gaia's reply. It submits research,
 * polls for results, and hands findings to the existing onCompleted hook —
 * which writes them into the conversation as material, exactly like the
 * Hermes path. The turn that started the research still owns the answer.
 */

const { createMastraResearchAgent } = require('./mastraResearchAgent');

/**
 * Creates the Mastra research client, or null when the capability is off
 * or unavailable. Mirrors the shape `server.js` builds for the Hermes
 * research path: `{ start }`.
 *
 * @param {{
 *   enabled: boolean,
 *   soulPrompt: string,
 *   roleConfig: object|null,
 *   webSearch?: object,
 *   hindsight?: object,
 *   foundation?: object,
 *   conversationSearch?: object,
 * }} deps
 * @returns {Promise<object|null>}
 */
async function createMastraResearchClient(deps = {}) {
  if (!deps.enabled) return null;

  const agent = await createMastraResearchAgent({
    soulPrompt: deps.soulPrompt,
    roleConfig: deps.roleConfig,
    webSearch: deps.webSearch,
    hindsight: deps.hindsight,
    foundation: deps.foundation,
    conversationSearch: deps.conversationSearch,
  });
  if (!agent) return null;

  return createMastraResearchFacade(agent);
}

/**
 * Adapts the Mastra agent facade to Gaia's research-jobs contract:
 * `start({ question, skillId, conversationId })` returns a job record with
 * a `runId`, and `getRun(runId)` returns the run's state. The store and the
 * poller are shared with the Hermes path — only the executor differs.
 *
 * @param {{ submitResearch: Function, getRun: Function, listRuns: Function }} agent
 */
function createMastraResearchFacade(agent) {
  async function start({ question, skillId, conversationId } = {}) {
    if (!question) return null;
    try {
      const result = await agent.submitResearch({ question, conversationId, skillId });
      if (!result || !result.runId) return null;
      return {
        id: `mj_${result.runId}`,
        runId: result.runId,
        conversationId: result.conversationId,
        skillId: result.skillId || 'mastra-research',
        question: result.question,
        status: 'running',
        createdAt: result.startedAt,
        updatedAt: result.startedAt,
        resultText: null,
        file: null,
        error: null,
        messageSaved: false,
        deliveredAt: null,
        executor: 'mastra',
      };
    } catch (err) {
      console.warn(`[gaia:mastra] research submit failed (non-fatal): ${err && err.message}`);
      return null;
    }
  }

  async function pollRun(runId) {
    try {
      return agent.getRun(runId);
    } catch (err) {
      console.warn(`[gaia:mastra] run poll failed (non-fatal): ${err && err.message}`);
      return null;
    }
  }

  return { start, pollRun, listRuns: agent.listRuns, executor: 'mastra' };
}

/**
 * Polls all running Mastra research jobs and updates the shared store.
 * Mirrors `pollResearchJobs` from researchJob.js, but drives the Mastra
 * agent's in-process run map instead of Hermes' `/runs` endpoint.
 *
 * Designed to be called from the same poll cycle as the Hermes poller, or
 * from its own interval — server.js decides.
 *
 * @param {{
 *   client: { pollRun: Function },
 *   store: object,
 *   onCompleted?: (job: object) => Promise<void>|void,
 *   deadlineMs?: number,
 *   now?: () => number,
 * }} input
 * @returns {Promise<Array<object>>} jobs whose status changed this cycle
 */
async function pollMastraResearchJobs({
  client,
  store,
  onCompleted,
  deadlineMs = 10 * 60 * 1000,
  now = Date.now,
} = {}) {
  const changed = [];
  if (!client || typeof client.pollRun !== 'function') return changed;
  if (!store || typeof store.listRunning !== 'function') return changed;

  let running;
  try {
    running = store.listRunning().filter((job) => job.executor === 'mastra');
  } catch (_) {
    return changed;
  }

  for (const job of running) {
    if (!job.runId) {
      const updated = store.update(job.id, { status: 'failed', error: 'run niet gestart' });
      if (updated) changed.push(updated);
      continue;
    }

    const startedAt = Date.parse(job.createdAt || '') || null;
    const age = startedAt ? now() - startedAt : 0;
    if (deadlineMs > 0 && startedAt && age >= deadlineMs) {
      const updated = store.update(job.id, {
        status: 'done',
        resultText: job.resultText || null,
        deadlineHit: true,
        deadlineMs,
        error: null,
      });
      if (updated) changed.push(updated);
      continue;
    }

    const state = await client.pollRun(job.runId);
    if (!state || !state.status) continue;

    if (state.status === 'completed') {
      const updated = store.update(job.id, {
        status: 'done',
        resultText: state.output || null,
      });
      if (updated) changed.push(updated);
    } else if (state.status === 'failed') {
      const updated = store.update(job.id, {
        status: 'failed',
        error: state.error || 'mastra research failed',
      });
      if (updated) changed.push(updated);
    }
    // 'running' — no change this cycle.
  }

  if (onCompleted) {
    for (const job of changed) {
      try {
        await onCompleted(job);
      } catch (err) {
        console.warn(`[gaia:mastra] onCompleted failed (non-fatal): ${err && err.message}`);
      }
    }
  }

  return changed;
}

module.exports = {
  createMastraResearchClient,
  createMastraResearchFacade,
  pollMastraResearchJobs,
};
