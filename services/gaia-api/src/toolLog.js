'use strict';

/**
 * Toolgebruik — one cheap observability record per tool call the model makes
 * during a turn (kind 'tool.call'), so we can answer "did she reach for her
 * own tools, and did anything come back?" from
 * `GET /admin/api/logos/decisions` instead of inferring it from her prose.
 *
 * The gap this closes was real and expensive: after the 18-10-2026 Yassine
 * conversation it was impossible to tell whether Gaia had called
 * `search_memory` and found nothing, or never called it at all. Nothing in the
 * logs recorded that a tool round had happened — `llm.call` covers the model
 * call, not the tools inside it.
 *
 * Counts and verdicts only — never the tool result text, never the query, the
 * same posture as `recall.measure` and `llm.call`. The result's *length* is
 * logged because that distinguishes a rendered memory block from a one-line
 * refusal without ever carrying the words.
 */

/**
 * What a tool says when it ran fine but found nothing. These are the tools'
 * own fixed sentences (reasoning/memoryTool.js, reasoning/webSearchTool.js) —
 * they live here because the log line must stay content-free and therefore
 * cannot echo the text it would otherwise match on.
 */
const EMPTY_TEXTS = new Set([
  'Nothing to keep.',
  'Nothing to search for.',
  'Nothing in memory about that.',
  'Nothing named to take back.',
  'Nothing named to forget.',
  'No search query was given, so nothing was looked up.',
]);

/**
 * What a tool says when it could not do the thing at all — a failure, a
 * refusal, or a dispatcher miss. Distinct from `empty` on purpose: "your memory
 * has nothing about this" and "the lookup broke" are different diagnoses.
 */
const FAILED_TEXTS = new Set([
  'That could not be done.',
  'That could not be kept right now.',
  'That could not be looked up right now.',
  'That could not be taken back right now.',
  'That could not be forgotten right now.',
  'Unknown action.',
]);

/** `The web lookup failed (<message>).` — the only failure with variable text. */
const WEB_FAILURE_PREFIX = 'The web lookup failed (';

/**
 * Classify one tool result without keeping it.
 * @param {*} resultText the string the tool handed back to the model
 * @returns {'answered'|'empty'|'failed'} 'answered' whenever nothing matches —
 *   a changed tool wording degrades to a visible `resultChars`, never a crash.
 */
function classifyToolResult(resultText) {
  const text = typeof resultText === 'string' ? resultText.trim() : '';
  if (FAILED_TEXTS.has(text) || text.startsWith(WEB_FAILURE_PREFIX)) return 'failed';
  if (EMPTY_TEXTS.has(text)) return 'empty';
  return 'answered';
}

/**
 * @param {{
 *   tool: string,
 *   resultText: string,
 *   round?: number|null,
 *   conversationId?: string|null,
 *   ok?: boolean,
 *   latencyMs?: number|null,
 *   timestamp?: string,
 * }} entry
 * @param {(line: string) => void} [sink] injectable for tests; defaults to
 *   console.log. A non-function (e.g. a console-like object passed through a
 *   loose `logger`) is ignored and falls back to console.log, so a logging call
 *   can never crash its caller.
 */
function logToolCall(entry, sink = (line) => console.log(line)) {
  const text = typeof entry.resultText === 'string' ? entry.resultText : '';
  const record = {
    kind: 'tool.call',
    timestamp: entry.timestamp || new Date().toISOString(),
    tool: entry.tool || null,
    round: Number.isFinite(entry.round) ? entry.round : null,
    conversationId: entry.conversationId || null,
    // `ok` is "the dispatch did not throw"; `outcome` is the tool's own verdict.
    ok: entry.ok !== false,
    outcome: entry.outcome || classifyToolResult(text),
    resultChars: text.length,
    latencyMs: Number.isFinite(entry.latencyMs) ? entry.latencyMs : null,
  };
  const write = typeof sink === 'function' ? sink : (line) => console.log(line);
  try {
    write(JSON.stringify(record));
  } catch (_) { /* observability never breaks a turn */ }
  return record;
}

/**
 * The other half of "could she reach her tools": a provider that rejects
 * `tools` outright makes the generator retry once without them, and without a
 * record of that, a turn with no `tool.call` line reads as "she chose not to
 * look" when the truth is "she was never offered the choice".
 * @param {{ status?: number|null, conversationId?: string|null, timestamp?: string }} entry
 * @param {(line: string) => void} [sink]
 */
function logToolUnavailable(entry = {}, sink = (line) => console.log(line)) {
  const record = {
    kind: 'tool.unavailable',
    timestamp: entry.timestamp || new Date().toISOString(),
    reason: 'tools_rejected',
    status: Number.isFinite(entry.status) ? entry.status : null,
    conversationId: entry.conversationId || null,
  };
  const write = typeof sink === 'function' ? sink : (line) => console.log(line);
  try {
    write(JSON.stringify(record));
  } catch (_) { /* observability never breaks a turn */ }
  return record;
}

module.exports = { logToolCall, logToolUnavailable, classifyToolResult, EMPTY_TEXTS, FAILED_TEXTS };
