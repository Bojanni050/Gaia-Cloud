'use strict';

/**
 * Chronicle — the source-of-truth archive (v3.0 memory pipe:
 * Chronicle → Hindsight/Insight → Logos).
 *
 * Completed turns register here with status `observation`: hard,
 * registered source facts. Derived knowledge (patterns, hypotheses,
 * reflections) keeps status `interpretation`/`hypothesis` and is never
 * auto-promoted to `confirmed` (Absolute Override: only a human confirms).
 *
 * This client is fire-and-forget by contract: append() never throws and
 * the live response path never awaits it. Configure with
 * CHRONICLE_URL (POST {base}/v1/observations) or CHRONICLE_PATH (local
 * JSONL file); unconfigured it resolves silently after a debug log line.
 */

const fs = require('fs');
const path = require('path');

function resolveChroniclePath(env = process.env) {
  if (env.CHRONICLE_PATH) return env.CHRONICLE_PATH;
  const devPath = path.resolve(__dirname, '../data/chronicle.jsonl');
  const containerPath = '/app/data/chronicle.jsonl';
  return fs.existsSync('/app') ? containerPath : devPath;
}

/**
 * @param {{ baseUrl?: string, chroniclePath?: string, fetchImpl?: Function, env?: NodeJS.ProcessEnv }} [options]
 * @returns {{ append: (entry: object) => Promise<boolean> }}
 */
function createChronicleClient(options = {}) {
  const env = options.env || process.env;
  const baseUrl = options.baseUrl !== undefined
    ? options.baseUrl
    : (env.CHRONICLE_URL || '');
  const chroniclePath = options.chroniclePath !== undefined
    ? options.chroniclePath
    : resolveChroniclePath(env);
  const fetchImpl = options.fetchImpl || fetch;

  /**
   * Registers one completed turn as an observation. Never throws:
   * returns true when stored, false otherwise.
   * @param {{ conversationId?: string, userText?: string, assistantText?: string,
   *           status?: string, metadata?: object }} entry
   */
  async function append(entry = {}) {
    const record = {
      status: entry.status || 'observation',
      conversation_id: entry.conversationId || null,
      user_text: entry.userText || null,
      assistant_text: entry.assistantText || null,
      metadata: entry.metadata || {},
      observed_at: new Date().toISOString(),
    };
    // Absolute Override: the archive never mints `confirmed` itself.
    if (record.status === 'confirmed') record.status = 'observation';
    try {
      if (baseUrl) {
        const root = String(baseUrl).replace(/\/+$/, '');
        await fetchImpl(`${root}/v1/observations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(record),
          signal: AbortSignal.timeout(4000),
        }).catch(() => null);
        return true;
      }
      try {
        fs.mkdirSync(path.dirname(chroniclePath), { recursive: true });
        fs.appendFileSync(chroniclePath, `${JSON.stringify(record)}\n`, 'utf-8');
        return true;
      } catch (_) {
        return false;
      }
    } catch (_) {
      return false;
    }
  }

  return { append };
}

module.exports = { createChronicleClient, resolveChroniclePath };
