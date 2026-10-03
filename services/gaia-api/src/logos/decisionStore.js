'use strict';

/**
 * Durable persistence for the Logos decision log lines that
 * intentLog.js/logosLog.js already produce (structured JSON, one line per
 * decision). Those write to console.log by default, which only survives as
 * long as `docker logs`' own retention — fine for live tailing, not for
 * looking back at "why did Gaia classify this the way it did" after the
 * fact. This store is that missing durability, not a replacement for the
 * console logging (turn.js keeps both: console.log for live tailing,
 * this store for later lookup).
 *
 * Layout: one append-only JSONL file per UTC day
 * (`<decisionsDir>/YYYY-MM-DD.jsonl`) — bounded per-file growth, no shared
 * index to corrupt under concurrent writes, and old days can be pruned by
 * deleting files directly. Same directory-resolution shape as
 * conversationStore.js/library.js.
 */

const fs = require('fs');
const path = require('path');

function resolveDecisionsDir(env = process.env) {
  if (env.LOGOS_DECISIONS_PATH) return env.LOGOS_DECISIONS_PATH;
  const devPath = path.resolve(__dirname, '../../data/logos-decisions');
  const containerPath = '/app/data/logos-decisions';
  return fs.existsSync('/app') ? containerPath : devPath;
}

function dayFile(decisionsDir, date) {
  const day = date.toISOString().slice(0, 10); // YYYY-MM-DD
  return path.join(decisionsDir, `${day}.jsonl`);
}

/**
 * @param {{ decisionsDir?: string, now?: () => Date }} [options]
 */
function createDecisionStore(options = {}) {
  const decisionsDir = options.decisionsDir || resolveDecisionsDir();
  const now = options.now || (() => new Date());

  /**
   * Appends one already-built log record (the same object
   * logIntentDecision/logReasoningResult return) as a JSONL line. Never
   * throws — a logging seam must not be able to break the turn it's
   * observing; callers that care about failures should check the return
   * value instead.
   * @param {object} record
   * @returns {boolean} whether the write succeeded
   */
  function append(record) {
    try {
      fs.mkdirSync(decisionsDir, { recursive: true });
      fs.appendFileSync(dayFile(decisionsDir, now()), `${JSON.stringify(record)}\n`, 'utf-8');
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Reads back the most recent decisions, newest first. Walks day-files
   * backward from today until `limit` is satisfied — cheap for the common
   * case (recent lookups), never loads the whole history into memory at
   * once beyond what's needed.
   * @param {{ limit?: number, kind?: string }} [query] `kind` filters to
   *   e.g. 'intentiq.decision' or 'logos.result'; omitted returns all kinds.
   * @returns {Array<object>}
   */
  function list(query = {}) {
    const limit = Number.isFinite(query.limit) && query.limit > 0 ? Math.floor(query.limit) : 50;
    if (!fs.existsSync(decisionsDir)) return [];

    const files = fs
      .readdirSync(decisionsDir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .sort()
      .reverse(); // newest day first

    const results = [];
    for (const file of files) {
      let lines;
      try {
        lines = fs.readFileSync(path.join(decisionsDir, file), 'utf-8').split('\n');
      } catch (_) {
        continue; // an unreadable day-file doesn't fail the whole listing
      }
      // Walk each day's lines newest-last-written-first (file is
      // append-only in write order, so reverse to get recency).
      for (let i = lines.length - 1; i >= 0 && results.length < limit; i -= 1) {
        const line = lines[i].trim();
        if (!line) continue;
        let record;
        try {
          record = JSON.parse(line);
        } catch (_) {
          continue; // a partially-written line (e.g. mid-append crash) is skipped, not fatal
        }
        if (query.kind && record.kind !== query.kind) continue;
        results.push(record);
      }
      if (results.length >= limit) break;
    }
    return results;
  }

  return { append, list, decisionsDir };
}

module.exports = { createDecisionStore, resolveDecisionsDir };
