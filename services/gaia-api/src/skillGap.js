'use strict';

/**
 * Skill-gaps — one record per moment a turn reached for an ability that was
 * not there (kind 'skill.gap').
 *
 * Why this exists: Gaia can only compose a new skill out of primitives she
 * already has, and until now nothing recorded what she reached for and did not
 * find. A turn that asked for `open_website` (no such tool), or for a desktop
 * skill such as `send-email` (not in the registry), or for `run-command` on a
 * machine that carries only `open-url`, ended in a refusal and left no trace —
 * so the same gap could be hit every week without ever becoming visible. The
 * first step towards self-extension is therefore not granting an ability but
 * *seeing* the absence: repeated gaps across conversations are the evidence a
 * skill proposal rests on, exactly the way repeated observations are the
 * evidence a belief rests on (see reasoning/beliefFormationScan.js).
 *
 * Boundary: counts and verdicts only, never content. No prompt text, no user
 * words, no tool result, and no argument values. `skill` survives only when it
 * looks like a registry token, because a model can put anything in that field
 * and a page can put anything in the model. This log is a place a stray
 * sentence must never be able to land.
 */

/**
 * Tools that exist, and the capability each belongs to. A name outside this set
 * is a tool the model invented; a name inside it that the dispatcher does not
 * know was simply not registered for this turn.
 */
const TOOL_CAPABILITY = Object.freeze({
  remember: 'memory',
  keep: 'memory',
  search_memory: 'memory',
  retract_memory: 'memory_retraction',
  forget_memory: 'memory_forgetting',
  web_search: 'web_search',
  read_back: 'conversation_search',
  desktop: 'desktop',
});

/** The dispatcher's own sentence when no tool part claims the name. */
const UNKNOWN_ACTION = 'Unknown action.';

/** The broker's sentence when the model names a skill the registry lacks. */
const UNKNOWN_SKILL = 'That is not something the desktop can do.';

/**
 * The broker's sentence when the skill exists but this client's machine does
 * not carry it. Matched as a prefix: the sentence continues with what to do
 * instead, and a wording tweak after the colon must not lose the record.
 */
const NOT_CARRIED_PREFIX = 'Nothing happened: this computer cannot do that';

/** How much of a skill name is kept. Longer than any registry id. */
const MAX_SKILL_CHARS = 48;

/**
 * A skill name is only kept when it looks like a registry token — lowercase
 * words joined by dashes. Anything else (a sentence, a URL, a payload) becomes
 * null: the gap stays counted, the text never lands in the log.
 * @param {*} value
 * @returns {string|null}
 */
function skillToken(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_SKILL_CHARS) return null;
  if (!/^[a-z][a-z0-9-]*$/i.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

/**
 * Classify one tool result as a gap, or null when it is an ordinary result.
 * @param {{ tool?: string, input?: object, resultText?: string }} entry
 * @returns {{ reason: string, capability: string|null, skill: string|null }|null}
 */
function classifyGap({ tool, input, resultText } = {}) {
  const text = typeof resultText === 'string' ? resultText.trim() : '';
  if (!text) return null;
  const name = typeof tool === 'string' ? tool : '';
  const known = Object.prototype.hasOwnProperty.call(TOOL_CAPABILITY, name);
  const capability = known ? TOOL_CAPABILITY[name] : null;

  if (text === UNKNOWN_ACTION) {
    // The name is real but nothing served it this turn, or the model invented a
    // tool. Those are different gaps: one is a wiring decision, the other is a
    // missing ability.
    return { reason: known ? 'not-configured' : 'unknown-tool', capability, skill: null };
  }
  if (text === UNKNOWN_SKILL) {
    return { reason: 'unknown-skill', capability, skill: skillToken(input && input.skill) };
  }
  if (text.startsWith(NOT_CARRIED_PREFIX)) {
    return { reason: 'not-carried', capability, skill: skillToken(input && input.skill) };
  }
  return null;
}

/**
 * @param {{
 *   tool?: string,
 *   input?: object,
 *   resultText?: string,
 *   round?: number|null,
 *   conversationId?: string|null,
 *   timestamp?: string,
 * }} entry
 * @param {(line: string) => void} [sink] injectable for tests; a non-function
 *   falls back to console.log, so a logging call never crashes its caller.
 * @returns {object|null} the record, or null when the result was not a gap
 */
function logSkillGap(entry = {}, sink = (line) => console.log(line)) {
  const gap = classifyGap(entry);
  if (!gap) return null;
  const record = {
    kind: 'skill.gap',
    timestamp: entry.timestamp || new Date().toISOString(),
    reason: gap.reason,
    capability: gap.capability,
    skill: gap.skill,
    tool: typeof entry.tool === 'string' ? entry.tool : null,
    round: Number.isFinite(entry.round) ? entry.round : null,
    conversationId: entry.conversationId || null,
  };
  const write = typeof sink === 'function' ? sink : (line) => console.log(line);
  try {
    write(JSON.stringify(record));
  } catch (_) { /* observability never breaks a turn */ }
  return record;
}

module.exports = {
  logSkillGap,
  classifyGap,
  skillToken,
  TOOL_CAPABILITY,
  UNKNOWN_ACTION,
  UNKNOWN_SKILL,
  NOT_CARRIED_PREFIX,
};
