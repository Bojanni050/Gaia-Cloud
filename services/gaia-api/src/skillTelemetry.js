'use strict';

/**
 * Skill telemetry — what a window of the durable decision log says about the
 * abilities Gaia reached for, what came back, and what she asked for and did not
 * find.
 *
 * Why this exists: before a formation pass proposes anything, the cheapest
 * question is whether there is signal at all. Three of them, from records that
 * already exist (no new logging except `tool.offered`, which is the missing
 * denominator):
 *
 *   offered   — a tool was on the table this turn (`tool.offered`)
 *   used      — she actually called it (`tool.call`)
 *   usable    — what came back was an answer, not an empty or a failure
 *
 * A tool that is offered and never called is a description problem; a tool that
 * is called and comes back empty is a wiring or query problem; a name that is
 * called and does not exist is a missing ability (`skill.gap`). Those are three
 * different repairs, and until they are counted apart they look identical.
 *
 * Only `unknown-tool` and `unknown-skill` gaps are `learnable`: a skill the
 * client cannot carry is the client's limit, and a tool that was not wired this
 * turn is a registration question. The formation pass may only propose on the
 * first two, so the flag is stated here instead of being re-derived there.
 *
 * Boundary: pure aggregation over already content-free records. No I/O, no
 * model call, no clock of its own. Every field this reads is a name, a count or
 * a verdict — never a prompt, an argument or a result.
 */

const { TOOL_CAPABILITY } = require('./skillGap');
const { CAPABILITY_REGISTRY } = require('./capabilityRegistry');

/** How many log lines one look-back covers. A day of conversation is far less. */
const DEFAULT_LIMIT = 5000;

/** Why a gap exists decides whether it is learnable; see the header. */
const LEARNABLE_REASONS = Object.freeze(['unknown-tool', 'unknown-skill']);

function countsFor() {
  return { calls: 0, answered: 0, empty: 0, failed: 0, resultChars: 0, latencyMs: 0, latencyCount: 0 };
}

function round(value) {
  return Math.round(value * 10) / 10;
}

/**
 * @param {Array<object>} records decision-log lines (any mix of kinds)
 * @returns {{
 *   window: { records: number, since: string|null, until: string|null },
 *   tools: Array<object>,
 *   capabilities: Array<object>,
 *   gaps: Array<object>,
 *   unreached: string[],
 * }}
 */
function summarizeSkillUse(records) {
  const lines = Array.isArray(records) ? records : [];
  const byTool = new Map();
  const offeredTurns = new Map();
  const offeredCapabilityTurns = new Map();
  const gapCounts = new Map();
  const toolConversations = new Map();
  let since = null;
  let until = null;

  const toolOf = (name) => {
    if (!byTool.has(name)) byTool.set(name, { ...countsFor(), tool: name, capability: TOOL_CAPABILITY[name] || null });
    return byTool.get(name);
  };

  for (const record of lines) {
    if (!record || typeof record !== 'object') continue;
    const at = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN;
    if (Number.isFinite(at)) {
      if (since === null || at < since) since = at;
      if (until === null || at > until) until = at;
    }

    if (record.kind === 'tool.offered' && Array.isArray(record.tools)) {
      const capabilities = new Set();
      for (const name of record.tools) {
        if (typeof name !== 'string' || !name) continue;
        // A row for an offered tool too: offered and never called is a finding,
        // and it would otherwise vanish from the table.
        toolOf(name);
        offeredTurns.set(name, (offeredTurns.get(name) || 0) + 1);
        const capability = TOOL_CAPABILITY[name];
        if (capability) capabilities.add(capability);
      }
      for (const capability of capabilities) {
        offeredCapabilityTurns.set(capability, (offeredCapabilityTurns.get(capability) || 0) + 1);
      }
      continue;
    }

    if (record.kind === 'tool.call' && typeof record.tool === 'string') {
      const row = toolOf(record.tool);
      row.calls += 1;
      if (record.outcome === 'empty') row.empty += 1;
      else if (record.outcome === 'failed') row.failed += 1;
      else row.answered += 1;
      if (Number.isFinite(record.resultChars)) row.resultChars += record.resultChars;
      if (Number.isFinite(record.latencyMs)) {
        row.latencyMs += record.latencyMs;
        row.latencyCount += 1;
      }
      if (typeof record.conversationId === 'string' && record.conversationId) {
        if (!toolConversations.has(record.tool)) toolConversations.set(record.tool, new Set());
        toolConversations.get(record.tool).add(record.conversationId);
      }
      continue;
    }

    if (record.kind === 'skill.gap' && typeof record.reason === 'string') {
      const skill = typeof record.skill === 'string' ? record.skill : null;
      const tool = typeof record.tool === 'string' ? record.tool : null;
      const capability = typeof record.capability === 'string' ? record.capability : null;
      const key = [record.reason, capability || '', skill || '', tool || ''].join('|');
      if (!gapCounts.has(key)) {
        gapCounts.set(key, {
          reason: record.reason,
          capability,
          skill,
          tool,
          learnable: LEARNABLE_REASONS.includes(record.reason),
          count: 0,
          conversations: new Set(),
        });
      }
      const gap = gapCounts.get(key);
      gap.count += 1;
      if (typeof record.conversationId === 'string' && record.conversationId) {
        gap.conversations.add(record.conversationId);
      }
    }
  }

  const tools = [...byTool.values()]
    .map((row) => ({
      tool: row.tool,
      capability: row.capability,
      offered: offeredTurns.get(row.tool) || 0,
      turns: toolConversations.has(row.tool) ? toolConversations.get(row.tool).size : 0,
      calls: row.calls,
      answered: row.answered,
      empty: row.empty,
      failed: row.failed,
      avgResultChars: row.calls > 0 ? Math.round(row.resultChars / row.calls) : 0,
      avgLatencyMs: row.latencyCount > 0 ? round(row.latencyMs / row.latencyCount) : null,
    }))
    .sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool));

  // Every tool that exists, including the ones this window never saw at all: an
  // absent verb and an unused one are the same conclusion only when the
  // denominator is known.
  const unreached = Object.keys(TOOL_CAPABILITY).filter((name) => !byTool.has(name)).sort();

  const gaps = [...gapCounts.values()]
    .map((gap) => ({ ...gap, conversations: gap.conversations.size }))
    .sort((a, b) => b.count - a.count || String(a.skill || a.tool).localeCompare(String(b.skill || b.tool)));

  const capabilities = Object.keys(CAPABILITY_REGISTRY).map((capability) => {
    const ownTools = Object.keys(TOOL_CAPABILITY).filter((name) => TOOL_CAPABILITY[name] === capability);
    const rows = tools.filter((row) => row.capability === capability);
    const capabilityGaps = gaps.filter((gap) => gap.capability === capability);
    return {
      capability,
      description: CAPABILITY_REGISTRY[capability].description,
      offeredTurns: offeredCapabilityTurns.get(capability) || 0,
      calls: rows.reduce((sum, row) => sum + row.calls, 0),
      gaps: capabilityGaps.reduce((sum, gap) => sum + gap.count, 0),
      learnableGaps: capabilityGaps.filter((gap) => gap.learnable).reduce((sum, gap) => sum + gap.count, 0),
      tools: ownTools,
      unusedTools: ownTools.filter((name) => !byTool.has(name)),
    };
  }).sort((a, b) => b.calls + b.gaps - (a.calls + a.gaps) || a.capability.localeCompare(b.capability));

  return {
    window: {
      records: lines.length,
      since: since === null ? null : new Date(since).toISOString(),
      until: until === null ? null : new Date(until).toISOString(),
    },
    tools,
    capabilities,
    gaps,
    unreached,
  };
}

/**
 * Reads the window from a decision store and summarizes it. A store that throws
 * yields an empty summary rather than a failed request: this is a reading of
 * observability, never a source of truth for a turn.
 * @param {{ list: (query?: { limit?: number }) => Array<object> }|null} decisionStore
 * @param {{ limit?: number }} [options]
 */
function buildSkillTelemetry(decisionStore, options = {}) {
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : DEFAULT_LIMIT;
  if (!decisionStore || typeof decisionStore.list !== 'function') return summarizeSkillUse([]);
  let records = [];
  try {
    records = decisionStore.list({ limit });
  } catch (_) {
    records = [];
  }
  return summarizeSkillUse(Array.isArray(records) ? records : []);
}

module.exports = {
  summarizeSkillUse,
  buildSkillTelemetry,
  LEARNABLE_REASONS,
  DEFAULT_LIMIT,
};
