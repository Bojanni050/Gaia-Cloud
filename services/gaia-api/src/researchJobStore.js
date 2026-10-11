'use strict';

/**
 * Durable store for research jobs — the runs Gaia has put out at Hermes and
 * is not waiting for.
 *
 * Why durable: a research run can outlive a process (minutes to tens of
 * minutes), and the whole point of the async shape is that the answer does not
 * depend on the turn that started it. Losing the job on a restart would lose
 * the research silently, so the jobs live on disk next to the other stores.
 *
 * Layout: one JSON file (`<jobsDir>/research-jobs.json`) holding a bounded
 * array of jobs, newest last. Rewritten atomically-ish on every change
 * (write to `.tmp`, then rename) — a single small file, not a log, because a
 * job's status transitions matter and JSONL would need replay logic for the
 * same answer. Same directory-resolution shape as decisionStore.js.
 *
 * A job is:
 *   { id, conversationId, skillId, question, status, runId,
 *     createdAt, updatedAt, resultText, file, error, messageSaved,
 *     deliveredAt }
 * status: 'running' → 'done' | 'failed'
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_JOBS = 200;

function resolveJobsDir(env = process.env) {
  if (env.GAIA_RESEARCH_JOBS_PATH) return env.GAIA_RESEARCH_JOBS_PATH;
  const devPath = path.resolve(__dirname, '../data/research-jobs');
  const containerPath = '/app/data/research-jobs';
  return fs.existsSync('/app') ? containerPath : devPath;
}

/**
 * @param {{ jobsDir?: string, now?: () => Date }} [options]
 */
function createResearchJobStore(options = {}) {
  const jobsDir = options.jobsDir || resolveJobsDir();
  const now = options.now || (() => new Date());
  const filePath = path.join(jobsDir, 'research-jobs.json');

  function readAll() {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      // Missing or unreadable store: no jobs, never a thrown error — a job
      // store must not be able to break a turn or a poll.
      return [];
    }
  }

  function writeAll(jobs) {
    const trimmed = jobs.slice(-MAX_JOBS);
    fs.mkdirSync(jobsDir, { recursive: true });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(trimmed, null, 2), 'utf-8');
    fs.renameSync(tmp, filePath);
    return trimmed;
  }

  /** @returns {object} the created job */
  function create({ conversationId = null, skillId, question, runId = null }) {
    const timestamp = now().toISOString();
    const job = {
      id: `rj_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`,
      conversationId: conversationId || null,
      skillId,
      question: String(question || ''),
      status: 'running',
      runId,
      createdAt: timestamp,
      updatedAt: timestamp,
      resultText: null,
      file: null,
      error: null,
      messageSaved: false,
      deliveredAt: null,
    };
    writeAll([...readAll(), job]);
    return job;
  }

  /** @returns {object|null} */
  function get(id) {
    return readAll().find((job) => job.id === id) || null;
  }

  /** @returns {Array<object>} newest last */
  function list() {
    return readAll();
  }

  /** @returns {Array<object>} jobs still running */
  function listRunning() {
    return readAll().filter((job) => job.status === 'running');
  }

  /** @returns {Array<object>} finished jobs the client has not seen yet */
  function listUndelivered() {
    return readAll().filter((job) => job.status !== 'running' && !job.deliveredAt);
  }

  /** @returns {object|null} the updated job */
  function update(id, patch) {
    const jobs = readAll();
    const index = jobs.findIndex((job) => job.id === id);
    if (index === -1) return null;
    const updated = { ...jobs[index], ...patch, updatedAt: now().toISOString() };
    jobs[index] = updated;
    writeAll(jobs);
    return updated;
  }

  /** @returns {object|null} */
  function markDelivered(id) {
    return update(id, { deliveredAt: now().toISOString() });
  }

  return { create, get, list, listRunning, listUndelivered, update, markDelivered, jobsDir };
}

module.exports = { createResearchJobStore, resolveJobsDir, MAX_JOBS };
