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
 * A conversationId is REQUIRED: the findings are written into the conversation
 * (saveResearchMessage), so a job without one would have nowhere to land and a
 * client would only ever see "finished" with no content. startResearchJob
 * refuses such a job and never submits the run.
 */

const fs = require('fs');
const path = require('path');
const { buildReachPrompt, HERMES_OUTBOX_DIR } = require('./researchReach');

const TERMINAL_FAILURES = new Set(['failed', 'cancelled', 'interrupted', 'stopping']);

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
      : 'Het onderzoek is klaar, maar er kwam geen tekst terug.';
    return `Onderzoek afgerond${skill}.\n\n${body}${fileLine}`;
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
 * One poll cycle: ask Hermes about every running job, close the ones that
 * ended, and hand the finished ones to `onCompleted` (which saves the
 * message). Never throws.
 *
 * @param {{ hermes: object, store: object, library?: object, outboxDir?: string,
 *   onCompleted?: (job: object) => Promise<void>|void }} input
 * @returns {Promise<Array<object>>} the jobs whose status changed this cycle
 */
async function pollResearchJobs({ hermes, store, library, outboxDir = resolveOutboxDir(), onCompleted } = {}) {
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
    } else if (TERMINAL_FAILURES.has(state.status)) {
      const updated = store.update(job.id, {
        status: 'failed',
        error: state.error || state.status,
      });
      if (updated) changed.push(updated);
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
  saveResearchMessage,
  resolveOutboxDir,
  TERMINAL_FAILURES,
};
