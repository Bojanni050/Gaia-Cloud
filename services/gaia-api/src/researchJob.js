'use strict';

/**
 * The research job lifecycle — submit, poll, deliver.
 *
 * Gaia puts a research question out at Hermes as a RUN (no waiting), answers
 * the person immediately, and this module picks the result up later: it polls
 * the run, imports any document the run left in the shared volume into Gaia's
 * own library, writes the findings into the conversation, and lets the client
 * notice via the poll endpoint (src/researchRoutes.js).
 *
 * Every failure is contained. A run that cannot be submitted, a poll that
 * cannot reach Hermes, an unreadable document — none of it may break a turn or
 * a poll cycle; the job simply stays `running` and is retried next cycle, or
 * lands as `failed` with a reason.
 *
 * An approval is not a failure and not a hang: when a run parks on
 * `waiting_for_approval` the job goes to `awaiting_approval` carrying the
 * flagged command (redacted by Hermes before it left), and the question is
 * written into the conversation like the findings are. The person answers
 * through the poll endpoint, answerJobApproval() forwards the decision, and
 * the run carries on. Nobody answering is the `blocked` case.
 *
 * A conversationId is REQUIRED: the findings are written into the conversation
 * (saveResearchMessage), so a job without one would have nowhere to land and a
 * client would only ever see "finished" with no content. startResearchJob
 * refuses such a job and never submits the run.
 */

const fs = require('fs');
const path = require('path');
const { buildReachPrompt, HERMES_OUTBOX_DIR } = require('./researchReach');

const TERMINAL_FAILURES = new Set(['failed', 'cancelled', 'interrupted']);
// A run parked on an approval is NOT finished and NOT a failure: it is a
// QUESTION for a person. Gaia keeps the job alive in `awaiting_approval`,
// surfaces the flagged command through the poll endpoint and the conversation,
// and forwards the answer with answerJobApproval(). Only when the run parks
// but no readable question comes with it does the job close as `blocked`.
const APPROVAL_STATES = new Set(['waiting_for_approval']);

// The hard cap on an investigation, and the cadence of the check-ins Gaia
// gives the person while it runs. A grounded-citations run is an agent loop:
// measured live 2026-10-11 it was still going after 15 minutes and 33 tool
// calls. Ten minutes is where Gaia stops waiting for depth and takes what
// Hermes has. The run is NOT cancelled — the Hermes API has no cancel, so it
// is simply no longer waited on — and the job closes honestly as `done` with
// `deadlineHit: true`, so the message can say it was cut off instead of
// pretending the investigation finished.
const DEFAULT_DEADLINE_MS = 10 * 60 * 1000;
// A long investigation must not be silent. Every interval Gaia says, in the
// conversation itself, that it is still running — a check-in, never a promise.
const DEFAULT_CHECKIN_MS = 3 * 60 * 1000;

function readDeadlineMs(env = process.env) {
  const raw = env.GAIA_RESEARCH_DEADLINE_MS;
  // An empty value is the .env.example convention for "not set", not a
  // request to disable the cap — only an explicit 0 does that.
  if (raw === undefined || String(raw).trim() === '') return DEFAULT_DEADLINE_MS;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_DEADLINE_MS;
}

function readCheckinMs(env = process.env) {
  const raw = env.GAIA_RESEARCH_CHECKIN_MS;
  if (raw === undefined || String(raw).trim() === '') return DEFAULT_CHECKIN_MS;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_CHECKIN_MS;
}

const MIME_BY_EXT = Object.freeze({
  '.pdf': 'application/pdf',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.html': 'text/html',
  '.xml': 'application/xml',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
});

function resolveOutboxDir(env = process.env) {
  if (env.GAIA_RESEARCH_OUTBOX) return env.GAIA_RESEARCH_OUTBOX;
  const devPath = path.resolve(__dirname, '../data/research-outbox');
  const containerPath = '/shared/research-out';
  return fs.existsSync('/app') ? containerPath : devPath;
}

/**
 * Submits one research question as a Hermes run and records the job.
 * @returns {Promise<object|null>} the job, or null when nothing was submitted
 */
async function startResearchJob({ question, skillId, conversationId, hermes, store, outboxDir = HERMES_OUTBOX_DIR } = {}) {
  if (!store || typeof store.create !== 'function') return null;
  if (!hermes || typeof hermes.submitRun !== 'function') return null;
  // The findings are written into the conversation, so a job without one has
  // nowhere to land. Enforced here as well as in the turn, so the invariant
  // holds for every caller.
  if (!conversationId) {
    console.warn('[gaia:research] no conversationId — not submitting a run');
    return null;
  }
  try {
    const input = buildReachPrompt({ skillId, question, outboxDir });
    const { runId } = await hermes.submitRun({ input });
    if (!runId) return null;
    return store.create({ conversationId, skillId, question, runId });
  } catch (err) {
    console.warn(`[gaia:research] run submit failed (non-fatal): ${err && err.message}`);
    return null;
  }
}

/** @returns {string|null} the newest not-yet-imported file, or null */
function pickOutboxFile(outboxDir, sinceIso) {
  try {
    if (!fs.existsSync(outboxDir)) return null;
    // 5s of slack: the volume and the container clocks are not guaranteed to
    // agree to the millisecond, and a file written right at submit time still
    // belongs to this job.
    const since = (Date.parse(sinceIso) || 0) - 5000;
    const candidates = [];
    for (const entry of fs.readdirSync(outboxDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue; // skips imported/ as well
      const full = path.join(outboxDir, entry.name);
      try {
        const stat = fs.statSync(full);
        if (stat.mtimeMs >= since) candidates.push({ full, mtimeMs: stat.mtimeMs });
      } catch (_) {
        // a file that vanished between listing and stat is not an error
      }
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return candidates[0].full;
  } catch (_) {
    return null;
  }
}

/**
 * Imports one outbox file into Gaia's library and moves it aside so it is
 * never imported twice. The move only happens after a successful save — a
 * failed import leaves the file for the next poll.
 * @returns {{ fileId: string, filename: string, mimeType: string, bytes: number }|null}
 */
function importOutboxFile(filePath, { library } = {}) {
  if (!filePath || !library || typeof library.saveFile !== 'function') return null;
  try {
    const buffer = fs.readFileSync(filePath);
    const filename = path.basename(filePath);
    const mimeType = MIME_BY_EXT[path.extname(filename).toLowerCase()] || 'application/octet-stream';
    const meta = library.saveFile(buffer, { filename, mimeType });
    if (!meta || !meta.id) return null;
    const archived = path.join(path.dirname(filePath), 'imported');
    fs.mkdirSync(archived, { recursive: true });
    try {
      fs.renameSync(filePath, path.join(archived, `${Date.now()}-${filename}`));
    } catch (_) {
      // Imported but not moved: the next poll might import it twice. The
      // document is in the library either way; log rather than fail.
      console.warn('[gaia:research] could not archive the imported document');
    }
    return { fileId: meta.id, filename, mimeType, bytes: buffer.length };
  } catch (err) {
    console.warn(`[gaia:research] document import failed (non-fatal): ${err && err.message}`);
    return null;
  }
}

/**
 * The message Gaia adds to the conversation once a job ends.
 * @returns {string}
 */
function renderResearchMessage(job) {
  if (!job) return '';
  const skill = job.skillId ? ` (skill ${job.skillId})` : '';
  const fileLine = job.file
    ? `\n\nBijgaand document: ${job.file.filename} (${Math.round((job.file.bytes || 0) / 1024)} kB).`
    : '';
  if (job.status === 'done') {
    const body = job.resultText && job.resultText.trim().length > 0
      ? job.resultText.trim()
      : job.deadlineHit
        ? 'Er kwam geen tussenstand terug.'
        : 'Het onderzoek is klaar, maar er kwam geen tekst terug.';
    if (job.deadlineHit) {
      const cappedMinutes = Math.round((job.deadlineMs || DEFAULT_DEADLINE_MS) / 60000);
      return `Ik heb het onderzoek na ${cappedMinutes} minuten afgekapt${skill} — dat duurde`
        + ' te lang. Dit is wat er tot nu toe is:\n\n' + body + fileLine;
    }
    return `Onderzoek afgerond${skill}.\n\n${body}${fileLine}`;
  }
  if (job.status === 'awaiting_approval') {
    const approval = job.approval || {};
    return `Hermes wil voor dit onderzoek een commando uitvoeren en vraagt om`
      + ` goedkeuring${approval.description ? ` (${approval.description})` : ''}:\n\n`
      + '```\n' + (approval.command || '(onbekend commando)') + '\n```\n\n'
      + 'Zeg of het mag en ik laat het doorlopen.';
  }
  if (job.status === 'blocked') {
    return `Het onderzoek${skill} is gestopt: Hermes wilde een commando uitvoeren dat zonder`
      + ' goedkeuring niet mag, en er was niemand om die te geven. Er is niets stuk —'
      + ` alleen dit stuk onderzoek is niet afgekomen.${fileLine}`;
  }
  return `Het onderzoek${skill} is niet gelukt: ${job.error || 'onbekende oorzaak'}.${fileLine}`;
}

/**
 * Writes the finished job's message into the conversation history, so the
 * findings appear in the chat itself rather than only in the poll response.
 * @returns {boolean} whether it was saved
 */
function saveResearchMessage({ job, historyStore } = {}) {
  if (!job || !historyStore || typeof historyStore.getConversation !== 'function') return false;
  if (!job.conversationId) return false;
  try {
    const conversation = historyStore.getConversation(job.conversationId);
    const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
    messages.push({ role: 'assistant', content: renderResearchMessage(job) });
    historyStore.saveConversation(job.conversationId, messages);
    return true;
  } catch (err) {
    console.warn(`[gaia:research] could not write the findings into the conversation: ${err && err.message}`);
    return false;
  }
}

/**
 * The message Gaia adds while a job is still running. A check-in, not a
 * promise: the person can see the investigation is alive, and nothing is
 * claimed about a result that does not exist yet.
 * @returns {string}
 */
function renderResearchCheckin(job, now = Date.now()) {
  if (!job) return '';
  const startedAt = Date.parse(job.createdAt || '') || now;
  const minutes = Math.max(1, Math.round((now - startedAt) / 60000));
  const skill = job.skillId ? ` (skill ${job.skillId})` : '';
  return `Het onderzoek loopt nog${skill} — ${minutes} minuten bezig.`
    + ' Ik meld me zodra het er is.';
}

/**
 * Writes a check-in into the conversation history, the same way the findings
 * land there, so a long run is visible where the person is actually looking.
 * @returns {boolean} whether it was saved
 */
function saveResearchCheckin({ job, historyStore, now = Date.now() } = {}) {
  if (!job || !historyStore || typeof historyStore.getConversation !== 'function') return false;
  if (!job.conversationId) return false;
  try {
    const conversation = historyStore.getConversation(job.conversationId);
    const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
    messages.push({ role: 'assistant', content: renderResearchCheckin(job, now) });
    historyStore.saveConversation(job.conversationId, messages);
    return true;
  } catch (err) {
    console.warn(`[gaia:research] could not write the check-in into the conversation: ${err && err.message}`);
    return false;
  }
}

/**
 * Narrows Hermes' approval payload to what a person needs to decide: the
 * flagged command (already redacted by Hermes before it leaves), its
 * description, and the choices the run itself offers.
 * @returns {{ command: string, description: string, choices: string[] }|null}
 */
function normalizeApproval(approval) {
  if (!approval || typeof approval !== 'object') return null;
  const command = typeof approval.command === 'string' ? approval.command : '';
  if (!command) return null;
  const choices = Array.isArray(approval.choices) && approval.choices.length > 0
    ? approval.choices.filter((c) => typeof c === 'string')
    : ['once', 'deny'];
  return {
    command,
    description: typeof approval.description === 'string' ? approval.description : '',
    choices,
  };
}

/** @returns {boolean} whether this is a new question rather than a re-read of the same one */
function approvalIsNew(job, approval) {
  if (job.status !== 'awaiting_approval') return true;
  const previous = job.approval || {};
  return previous.command !== approval.command || previous.description !== approval.description;
}

/**
 * Answers a parked run's approval with the person's decision. The job goes
 * back to `running` — a deny does not fail the run, it blocks that one
 * command and the agent carries on — and the next poll cycle picks up
 * whatever the run does next.
 *
 * @param {{ jobId: string, choice: string, hermes: object, store: object }} input
 * @returns {Promise<{ ok: boolean, job: object|null, error: string|null, status: number }>}
 */
async function answerJobApproval({ jobId, choice, hermes, store } = {}) {
  const job = store && typeof store.get === 'function' ? store.get(jobId) : null;
  if (!job) return { ok: false, job: null, error: 'unknown research job', status: 404 };
  if (job.status !== 'awaiting_approval') {
    return { ok: false, job, error: 'this job is not waiting for a decision', status: 409 };
  }
  if (!job.runId) return { ok: false, job, error: 'the run is gone', status: 409 };

  const allowed = (job.approval && job.approval.choices) || ['once', 'deny'];
  const wanted = String(choice || '').trim().toLowerCase();
  if (!allowed.includes(wanted)) {
    return { ok: false, job, error: `choice must be one of: ${allowed.join(', ')}`, status: 400 };
  }
  if (!hermes || typeof hermes.answerApproval !== 'function') {
    return { ok: false, job, error: 'hermes is not configured', status: 503 };
  }

  let result;
  try {
    result = await hermes.answerApproval(job.runId, { choice: wanted });
  } catch (err) {
    return { ok: false, job, error: (err && err.message) || 'hermes unreachable', status: 502 };
  }
  if (!result || !result.ok) {
    return { ok: false, job, error: (result && result.error) || 'hermes rejected the decision', status: 502 };
  }

  // The decision is in; the run resumes. Clearing `approval` means the next
  // park (a new question) counts as new and gets its own message.
  const updated = store.update(job.id, { status: 'running', approval: null, error: null });
  return { ok: true, job: updated || job, error: null, status: 204 };
}

/**
 * One poll cycle: ask Hermes about every running job, close the ones that
 * ended, and hand the finished ones to `onCompleted` (which saves the
 * message). Never throws.
 *
 * @param {{ hermes: object, store: object, library?: object, outboxDir?: string,
 *   onCompleted?: (job: object) => Promise<void>|void,
 *   onCheckin?: (job: object) => Promise<void>|void, deadlineMs?: number,
 *   checkinMs?: number, now?: () => number }} input
 * @returns {Promise<Array<object>>} the jobs whose status changed this cycle
 */
async function pollResearchJobs({
  hermes,
  store,
  library,
  outboxDir = resolveOutboxDir(),
  onCompleted,
  onCheckin,
  deadlineMs = readDeadlineMs(),
  checkinMs = readCheckinMs(),
  now = Date.now,
} = {}) {
  const changed = [];
  if (!store || typeof store.listRunning !== 'function') return changed;
  if (!hermes || typeof hermes.getRun !== 'function') return changed;

  let running;
  try {
    running = store.listRunning();
  } catch (_) {
    return changed;
  }

  for (const job of running) {
    if (!job.runId) {
      const updated = store.update(job.id, { status: 'failed', error: 'run niet gestart' });
      if (updated) changed.push(updated);
      continue;
    }

    // The hard cap. At the deadline Gaia stops waiting for depth and takes
    // what Hermes has right now — the run is not cancelled (the Hermes API has
    // no cancel), it is simply no longer waited on. Closed as `done` so every
    // client already knows the status, with `deadlineHit` so the message can
    // say honestly that it was cut off.
    const startedAt = Date.parse(job.createdAt || '') || null;
    const age = startedAt ? now() - startedAt : 0;
    if (deadlineMs > 0 && startedAt && age >= deadlineMs) {
      let partial = null;
      try {
        partial = await hermes.getRun(job.runId);
      } catch (_) {
        partial = null; // "give me what you have" — unreachable Hermes has nothing
      }
      const updated = store.update(job.id, {
        status: 'done',
        resultText: (partial && partial.output) || job.resultText || null,
        deadlineHit: true,
        deadlineMs,
        error: null,
      });
      if (updated) changed.push(updated);
      continue;
    }

    let state;
    try {
      state = await hermes.getRun(job.runId);
    } catch (_) {
      continue; // Hermes unreachable this cycle: retry next one
    }
    if (!state || !state.status) continue;

    if (state.status === 'completed') {
      const documentPath = job.file ? null : pickOutboxFile(outboxDir, job.createdAt);
      const file = documentPath ? importOutboxFile(documentPath, { library }) : null;
      const updated = store.update(job.id, {
        status: 'done',
        resultText: state.output || null,
        file: file || job.file || null,
      });
      if (updated) changed.push(updated);
    } else if (APPROVAL_STATES.has(state.status)) {
      const approval = normalizeApproval(state.approval);
      if (!approval) {
        // Parked with nothing readable to ask: close it honestly rather than
        // leave a job that never finishes.
        const updated = store.update(job.id, { status: 'blocked', error: 'approval_required' });
        if (updated) changed.push(updated);
      } else if (approvalIsNew(job, approval)) {
        // A question for a person. It travels the same way the findings do:
        // into the conversation, plus the poll endpoint for the client.
        const updated = store.update(job.id, { status: 'awaiting_approval', approval });
        if (updated) changed.push(updated);
      }
      // Same question, still unanswered: no change, so no second message.
    } else if (TERMINAL_FAILURES.has(state.status)) {
      const updated = store.update(job.id, {
        status: 'failed',
        error: state.error || state.status,
      });
      if (updated) changed.push(updated);
    }

    // Still running (nothing above closed it): a long investigation must not be
    // silent. Only the timestamp is persisted here, and the message goes out
    // through onCheckin — `changed` stays the "status changed" contract its
    // callers rely on to mark a job delivered.
    const lastCheckin = Date.parse(job.lastCheckinAt || '') || 0;
    if (checkinMs > 0 && age >= checkinMs && now() - lastCheckin >= checkinMs) {
      const ticked = store.update(job.id, { lastCheckinAt: new Date(now()).toISOString() });
      if (ticked && onCheckin) {
        try {
          await onCheckin(ticked);
        } catch (err) {
          console.warn(`[gaia:research] check-in failed (non-fatal): ${err && err.message}`);
        }
      }
    }
  }

  if (onCompleted) {
    for (const job of changed) {
      try {
        await onCompleted(job);
      } catch (err) {
        console.warn(`[gaia:research] completion handling failed (non-fatal): ${err && err.message}`);
      }
    }
  }

  return changed;
}

module.exports = {
  startResearchJob,
  pollResearchJobs,
  pickOutboxFile,
  importOutboxFile,
  renderResearchMessage,
  renderResearchCheckin,
  saveResearchMessage,
  saveResearchCheckin,
  readDeadlineMs,
  readCheckinMs,
  answerJobApproval,
  normalizeApproval,
  resolveOutboxDir,
  DEFAULT_DEADLINE_MS,
  DEFAULT_CHECKIN_MS,
  TERMINAL_FAILURES,
  APPROVAL_STATES,
};
