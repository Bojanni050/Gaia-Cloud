'use strict';

/**
 * Skill recipes — what a learned skill may be built from, checked before it is
 * ever proposed (phase 1) or executed (phase 2).
 *
 * A recipe is an ordered list of tool calls. That is the whole vocabulary: the
 * eight verbs in `skillGap.js`'s TOOL_CAPABILITY, borrowed here so there is one
 * list of what exists. A capability is never a step (`hermes` and `native` are
 * the turn's engine, `hindsight` recall happens on its own, `research` answers
 * later), and a registry skill is never a step either — `memory-retrieval` is a
 * label and `systematic-debugging` runs inside Hermes. Only `desktop` carries a
 * skill in its arguments.
 *
 * The interesting rule is the data flow, and it is not about which steps are
 * allowed — it is about which pair of steps is allowed together. A recipe that
 * reads the person's disk and then reaches the web is built entirely from
 * primitives that already exist, yet it moves local content off the machine.
 * Whether that happens invisibly is decided by the policy the broker already
 * has: `file-read` and `file-search` run without a prompt, and so do
 * `web_search` and `open-url`. Nothing in such a recipe ever shows the content
 * moving, and the person approved the recipe once, not each run.
 *
 * So the rule is narrow and stated in terms of what the person can see: a
 * recipe may not combine a prompt-free local read with a prompt-free external
 * send. `file-write` and `run-command` are `confirm`, so their arguments are
 * shown every run — a `web_search` result flowing into one of those is visible
 * and stays allowed. Both directions of the taint argument rest on the same
 * question: would the person see it happen?
 *
 * Boundary: pure validation over frozen metadata and a passed-in recipe. No
 * I/O, no model call, no execution. Nothing here can grant an ability; it can
 * only refuse a combination.
 */

const { TOOL_CAPABILITY } = require('./skillGap');
const { getCapabilityProfile, validateCapabilitySkill } = require('./capabilityRegistry');
const { SKILL_POLICY } = require('./desktopBroker');

/** A recipe is a sequence, not a program: long enough to be useful, short enough to finish. */
const MAX_STEPS = 8;

/**
 * Steps whose output is content from the person's own machine, and which run
 * without a prompt. Anything here must not meet an external send.
 */
const LOCAL_READ_SKILLS = Object.freeze(['file-read', 'file-search']);

/**
 * Tools that leave the machine without a prompt. `web_search` is a tool;
 * `open-url` is a desktop skill, so the same question is asked of both.
 */
const EXTERNAL_SEND_TOOLS = Object.freeze(['web_search']);
const EXTERNAL_SEND_SKILLS = Object.freeze(['open-url']);

function isLocalRead(step) {
  return step.tool === 'desktop'
    && LOCAL_READ_SKILLS.includes(step.skill)
    && SKILL_POLICY[step.skill] === 'auto';
}

function isExternalSend(step) {
  if (EXTERNAL_SEND_TOOLS.includes(step.tool)) return true;
  return step.tool === 'desktop'
    && EXTERNAL_SEND_SKILLS.includes(step.skill)
    && SKILL_POLICY[step.skill] === 'auto';
}

function describe(step) {
  return step && step.tool === 'desktop' && step.skill
    ? `desktop(${step.skill})`
    : String(step && step.tool);
}

/**
 * Normalizes one step to `{ tool, skill }` without inventing values: a step is
 * what the proposal wrote, and a field that is not a string is not a name.
 */
function readStep(step) {
  const record = step && typeof step === 'object' ? step : {};
  return {
    tool: typeof record.tool === 'string' ? record.tool.trim().toLowerCase() : '',
    skill: typeof record.skill === 'string' ? record.skill.trim().toLowerCase() : '',
    raw: record,
  };
}

/**
 * Every reason this recipe cannot be proposed, in reading order. A review card
 * wants all of them at once, not the first one that failed.
 * @param {{ capability?: string, steps?: Array<{ tool?: string, skill?: string }> }} recipe
 * @returns {string[]} empty when the recipe is acceptable
 */
function recipeProblems(recipe) {
  const problems = [];
  const record = recipe && typeof recipe === 'object' ? recipe : {};
  const rawSteps = Array.isArray(record.steps) ? record.steps : [];
  if (rawSteps.length === 0) {
    problems.push('a recipe needs at least one step');
    return problems;
  }
  if (rawSteps.length > MAX_STEPS) {
    problems.push(`a recipe carries at most ${MAX_STEPS} steps, this one has ${rawSteps.length}`);
  }

  const steps = rawSteps.map(readStep);
  const usedCapabilities = new Set();

  steps.forEach((step, index) => {
    const at = `step ${index + 1}`;
    if (!step.tool) {
      problems.push(`${at} names no tool`);
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(TOOL_CAPABILITY, step.tool)) {
      // The common mistake this catches: a capability or a skill id written
      // where a tool belongs ("hermes", "file-write", "memory-retrieval").
      problems.push(`${at} uses "${step.tool}", which is not a tool the model can call`);
      return;
    }
    const capability = TOOL_CAPABILITY[step.tool];
    usedCapabilities.add(capability);

    if (step.tool !== 'desktop' && step.skill) {
      problems.push(`${at} gives "${step.tool}" a skill, but only desktop carries one`);
      return;
    }
    if (step.tool === 'desktop' && !step.skill) {
      problems.push(`${at} uses desktop without naming a skill`);
      return;
    }
    if (step.skill) {
      const invalid = validateCapabilitySkill(capability, step.skill);
      if (invalid) problems.push(`${at}: ${invalid}`);
    }
  });

  // The pair rule. Order is irrelevant on purpose: the executor hands each
  // result back before the next step, so either direction moves the content.
  const localRead = steps.find((step) => isLocalRead(step));
  const externalSend = steps.find((step) => isExternalSend(step));
  if (localRead && externalSend) {
    problems.push(
      `"${describe(localRead)}" reads this computer and "${describe(externalSend)}" leaves it, `
      + 'and neither asks the person — a recipe may not move local content off the machine unseen',
    );
  }

  const capability = typeof record.capability === 'string' ? record.capability.trim() : '';
  if (!capability) {
    problems.push('a recipe names the capability it belongs to, or awareness can never show it');
  } else if (!getCapabilityProfile(capability)) {
    problems.push(`capability "${capability}" is not registered`);
  } else if (rawSteps.length > 0 && steps.every((step) => step.tool)) {
    // A skill hangs under the capability whose tools it uses; anything else is
    // a skill with no owner.
    if (!usedCapabilities.has(capability)) {
      problems.push(`capability "${capability}" owns none of this recipe's steps`);
    }
  }

  return problems;
}

/**
 * @param {{ capability?: string, steps?: Array<{ tool?: string, skill?: string }> }} recipe
 * @returns {string|null} null when the recipe is acceptable, else the first problem
 */
function validateSkillRecipe(recipe) {
  const problems = recipeProblems(recipe);
  return problems.length > 0 ? problems[0] : null;
}

module.exports = {
  validateSkillRecipe,
  recipeProblems,
  isLocalRead,
  isExternalSend,
  describe,
  MAX_STEPS,
  LOCAL_READ_SKILLS,
  EXTERNAL_SEND_TOOLS,
  EXTERNAL_SEND_SKILLS,
};
