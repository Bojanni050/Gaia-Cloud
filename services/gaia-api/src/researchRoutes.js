'use strict';

/**
 * The poll endpoint for research jobs — how a client learns that something it
 * is not waiting for has finished.
 *
 * Deliberately a plain poll and not a streaming channel: the client asks what
 * changed since it last looked, which survives a reconnect, a backgrounded
 * window, or a desktop app that was closed while the run was still going. The
 * Kairos realtime SSE stream is a per-connection thing and would lose the
 * signal in exactly those cases.
 *
 * Routes (mounted under /research, Bearer-auth required):
 *   GET  /research/jobs          → { running: [...], finished: [...] }
 *        `finished` holds the jobs this client has not acknowledged yet, so a
 *        client that never polls loses nothing and one that polls twice sees
 *        each result once.
 *   POST /research/jobs/:id/ack  → mark one job as seen (204)
 *   POST /research/jobs/:id/approval  { choice } → answer a run that parked on
 *        a question for a person (204). The choice must be one the job's own
 *        `approval.choices` lists.
 *
 * What travels here is metadata only — id, status, question, timestamps and a
 * file reference. The findings themselves are written into the conversation
 * (src/researchJob.js), so a client renders them with the rest of the
 * transcript instead of inventing a second place for them.
 */

const express = require('express');

/**
 * The client-facing view of one job — metadata only. The findings themselves
 * live in the conversation, so there is exactly one place a result can be.
 *
 * Exported because the turn itself reports the job it just submitted (and the
 * SSE research frame does too): one shape for every surface, so a client's
 * indicator cannot disagree with what it polls a moment later.
 *
 * @param {object} job
 * @returns {object}
 */
function researchJobView(job) {
  return {
    id: job.id,
    conversationId: job.conversationId,
    skillId: job.skillId,
    question: job.question,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    messageSaved: Boolean(job.messageSaved),
    // The question, when the run is waiting on a person. `choices` is what
    // Hermes itself offers, so a client renders exactly the decisions that
    // will be accepted.
    approval: job.status === 'awaiting_approval' && job.approval
      ? {
          command: job.approval.command,
          description: job.approval.description,
          choices: job.approval.choices,
        }
      : null,
    file: job.file
      ? { id: job.file.fileId, filename: job.file.filename, mimeType: job.file.mimeType }
      : null,
  };
}

/** @param {{ store: ReturnType<import('./researchJobStore').createResearchJobStore>, auth: import('express').RequestHandler, answerApproval?: (jobId: string, choice: string) => Promise<object> }} deps */
function createResearchRouter({ store, auth, answerApproval }) {
  const router = express.Router();

  const clientShape = researchJobView;

  router.get('/jobs', auth, (req, res) => {
    try {
      res.json({
        running: store.listRunning().map(clientShape),
        finished: store.listUndelivered().map(clientShape),
      });
    } catch (_) {
      // A poll must never look like a crash with no explanation.
      res.status(503).json({ error: 'research jobs unavailable' });
    }
  });

  router.post('/jobs/:id/ack', auth, (req, res) => {
    try {
      const job = store.markDelivered(req.params.id);
      if (!job) return res.status(404).json({ error: 'unknown research job' });
      return res.status(204).end();
    } catch (_) {
      return res.status(503).json({ error: 'research jobs unavailable' });
    }
  });

  // The person's decision on a run that parked. Gaia forwards it; the run
  // resumes and the next poll cycle closes the job with its findings.
  router.post('/jobs/:id/approval', auth, async (req, res) => {
    if (typeof answerApproval !== 'function') {
      return res.status(503).json({ error: 'approvals are not wired' });
    }
    const choice = req.body && req.body.choice;
    try {
      const result = await answerApproval(req.params.id, choice);
      if (result.ok) return res.status(204).end();
      return res.status(result.status || 502).json({ error: result.error || 'could not answer the approval' });
    } catch (_) {
      return res.status(502).json({ error: 'could not answer the approval' });
    }
  });

  return router;
}

module.exports = { createResearchRouter, researchJobView };
