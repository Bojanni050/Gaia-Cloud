'use strict';

/**
 * The Orchestrator — executes a Decision (decision/decisionEngine.js). It
 * makes no judgment calls of its own: no "this looks hard, let's use
 * Hermes" logic lives here. Given the same Decision, it always does the
 * same thing.
 *
 *   native      -> invoke the native generator (gaiaGenerator.js) when
 *                   available; structured error when not configured
 *   capability  -> resolve the named capability and invoke it
 *   tool        -> resolve the named tool capability and invoke it (same
 *                   resolution path as `capability` — a tool is just a
 *                   capability whose id happens to be tool-shaped)
 *   clarify     -> structured result, no capability call
 *   refuse      -> structured result, no capability call
 *   plan        -> Decision Engine 3.0: execute Gaia's steps SEQUENTIALLY,
 *                  resolving backward step references, stopping on a failed
 *                  required step (structured failure; optional steps are
 *                  recorded and skipped). No replanning, no hidden step
 *                  insertion, no parallelism — execution is exactly the
 *                  plan (see executePlan below).
 *
 * A capability's raw output is returned as-is; this module never touches
 * capability internals (provider routing, streaming framing) and never
 * writes to a response itself — see responseEngine.js for the seam that
 * turns an ExecutionResult into what the client actually sees.
 *
 * P0 Logos ↔ Capability contract (runtime integration): every capability
 * invocation — single actions AND plan steps — runs through the generic
 * outcome loop (logos/capabilityLoop.js). The Decision carries what Logos
 * demands (`expected_outcome`); the result is evaluated against it, so a
 * technically successful capability call is NOT automatically a successful
 * task. Adapters expose `invokeCapability`; legacy `{ invoke }` entries are
 * wrapped by the neutral bridge (capabilities/legacyBridge.js). This module
 * holds no capability-specific logic — routing is by id only.
 */

const { validateDecision } = require('../decision/decisionSchema');
const { validateCapabilitySkill } = require('../capabilityRegistry');
const { normalizeExpectedOutcome } = require('../logos/capabilityContract');
const { runCapabilityLoop } = require('../logos/capabilityLoop');
const { wrapLegacyCapability } = require('../capabilities/legacyBridge');

/**
 * @typedef {Object} ExecutionResult
 * @property {'native'|'capability'|'tool'|'clarify'|'refuse'} action
 * @property {string} [capability]
 * @property {*} [output] - the capability's result on success (structured payloads unwrapped), or null when none was called
 * @property {string} [error] - set when a named capability/tool was not available, or when the outcome loop ends in failure
 * @property {string} [reason] - carried through from the Decision, for clarify/refuse
 * @property {{ verdict: string, attempts: number, maxAttempts: number, reason: string|null }} [outcome] - the P0 outcome evaluation for capability executions
 */

/**
 * Resolves a registered capability entry to the generic P0 adapter
 * interface. Entries exposing `invokeCapability` (Hermes via its adapter)
 * are used directly; legacy `{ invoke }` entries go through the neutral
 * bridge. Returns null when the id is not registered or has no usable
 * shape — the caller reports "not available" exactly as before.
 */
function resolveAdapter(capabilities, capabilityId) {
  const entry = capabilities ? capabilities[capabilityId] : null;
  if (!entry || typeof entry !== 'object') return null;
  if (typeof entry.invokeCapability === 'function') return entry;
  if (typeof entry.invoke === 'function') {
    return wrapLegacyCapability({ id: capabilityId, invoke: entry.invoke });
  }
  return null;
}

/** Fallback expectation when Logos stated none: a completed, non-empty result. */
function defaultExpectedOutcome({ capabilityId, task, step }) {
  const what = task || (step ? `${step.type} step "${step.id}"` : null) || capabilityId;
  return { description: `A completed ${what} result`, minLength: 1 };
}

function latestUserText(messages) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m && m.role === 'user' && typeof m.content === 'string' && m.content.trim()) return m.content;
  }
  return null;
}

/**
 * Builds the generic CapabilityRequest for one execution. Objective and
 * instruction come from the Decision (Logos); the assembled messages and
 * the selected skill ride along as neutral context for the adapter.
 */
function buildCapabilityRequest({ capabilityId, task, input, messages, skill, conversationId, expectedOutcome }) {
  const userInput = input && typeof input.userInput === 'string' && input.userInput.trim() ? input.userInput : null;
  const query = input && typeof input.query === 'string' && input.query.trim() ? input.query : null;
  const instruction = userInput || query || latestUserText(messages) || task || `execute ${capabilityId}`;
  return {
    capabilityId,
    objective: task || `execute ${capabilityId}`,
    instruction,
    expected_outcome: expectedOutcome,
    context: {
      messages: Array.isArray(messages) ? messages : [],
      task,
      input: input && typeof input === 'object' ? input : {},
      conversationId: conversationId || null,
      ...(typeof skill === 'string' && skill ? { skill } : {}),
    },
  };
}

/** Unwraps a loop result: structured payloads (`data`) win over evaluation text. */
function unwrapLoopOutput(lastResult) {
  if (!lastResult || typeof lastResult !== 'object') return null;
  if (lastResult.data !== undefined) return lastResult.data;
  return lastResult.output;
}

function outcomeSummary(loop) {
  return {
    verdict: loop.verdict,
    attempts: loop.attempts,
    maxAttempts: loop.maxAttempts,
    reason: loop.lastEvaluation && loop.lastEvaluation.reason ? loop.lastEvaluation.reason : null,
  };
}

/**
 * @param {import('../decision/decisionSchema').Decision} decision
 * @param {{
 *   capabilities?: Record<string, { invoke: (messages: Array, options?: object) => Promise<*> }>,
 *   nativeGenerator?: { generate: Function, stream?: Function },
 *   messages?: Array,
 *   onDelta?: Function,
 *   conversationId?: string|null,
 * }} [context]
 * @returns {Promise<ExecutionResult>}
 */
async function execute(decision, {
  capabilities = {},
  nativeGenerator,
  messages,
  onDelta,
  conversationId = null,
} = {}) {
  const problem = validateDecision(decision);
  if (problem) {
    throw new Error(`Orchestrator received an invalid decision: ${problem}`);
  }
  // Capability Registry 1.0 — defensive pre-execution skill check (the
  // Decision schema already validates this; an injected decision that
  // bypassed it must still never reach a capability with a skill its
  // capability does not expose).
  if (decision.action === 'plan') {
    for (const step of decision.steps || []) {
      if (step.skill) {
        const skillProblem = validateCapabilitySkill(step.capability, step.skill);
        if (skillProblem) {
          throw new Error(`Orchestrator received an invalid decision: plan step "${step.id}": ${skillProblem}`);
        }
      }
    }
  }

  switch (decision.action) {
    case 'native': {
      if (!nativeGenerator || typeof nativeGenerator.generate !== 'function') {
        return { action: 'native', output: null, error: 'native generator is not available' };
      }
      // Streaming when possible: if the caller wants deltas and the
      // generator supports them, stream; otherwise fall back to the
      // non-streaming generate() path.
      let output;
      if (onDelta && typeof nativeGenerator.stream === 'function') {
        output = await nativeGenerator.stream(messages, { onDelta });
      } else {
        output = await nativeGenerator.generate(messages);
      }
      return { action: 'native', output };
    }

    case 'capability':
    case 'tool': {
      const adapter = resolveAdapter(capabilities, decision.capability);
      if (!adapter) {
        return {
          action: decision.action,
          capability: decision.capability,
          output: null,
          error: `capability "${decision.capability}" is not available`,
        };
      }
      // P0: Logos stated what must be achieved (or the neutral default
      // applies); the loop evaluates every attempt against it.
      const expectedOutcome = normalizeExpectedOutcome(decision.expected_outcome)
        || defaultExpectedOutcome({ capabilityId: decision.capability, task: decision.task });
      const request = buildCapabilityRequest({
        capabilityId: decision.capability,
        task: decision.task,
        input: decision.input,
        messages,
        skill: undefined,
        conversationId,
        expectedOutcome,
      });
      const loop = await runCapabilityLoop({
        request,
        adapter,
        max_attempts: decision.max_attempts,
        adapterOptions: { onDelta, conversationId },
      });
      const outcome = outcomeSummary(loop);
      if (loop.verdict === 'success') {
        return { action: decision.action, capability: decision.capability, output: unwrapLoopOutput(loop.lastResult), outcome };
      }
      if (loop.verdict === 'ask_user') {
        // The execution stops here; Gaia asks the user for what is missing.
        // Mapped onto the existing clarify shape the Response Engine speaks.
        const missing = loop.lastEvaluation && loop.lastEvaluation.missingInfo
          ? loop.lastEvaluation.missingInfo
          : (loop.lastEvaluation && loop.lastEvaluation.reason) || 'missing information';
        return { action: 'clarify', output: null, reason: `capability needs more information: ${missing}`, outcome, question: missing };
      }
      return {
        action: decision.action,
        capability: decision.capability,
        output: null,
        error: (loop.lastEvaluation && loop.lastEvaluation.reason) || 'capability execution failed',
        reason: decision.reason,
        outcome,
      };
    }

    case 'clarify':
      return { action: 'clarify', output: null, reason: decision.reason };

    case 'refuse':
      return { action: 'refuse', output: null, reason: decision.reason };

    case 'plan':
      return executePlan(decision, { capabilities, nativeGenerator, messages, onDelta, conversationId });

    /* istanbul ignore next -- unreachable: validateDecision already rejects any other action */
    default:
      throw new Error(`Orchestrator cannot execute unknown decision action: ${decision.action}`);
  }
}

/**
 * Formats one step's structured output into the compact text block handed
 * to later reasoning/generation steps. Purely presentational — retrieval
 * results become readable context; no interpretation happens here.
 * @param {{ type: string, capability?: string, mode?: string }} step
 * @param {*} output raw step output
 */
function formatStepOutputForContext(step, output) {
  const header = `[${step.id} · ${step.capability || step.mode || step.type}]`;
  if (output == null) return `${header}\n(geen resultaat)`;
  if (typeof output === 'string') return `${header}\n${output}`;
  // Structured outputs ({results:[], total}) from retrieval capabilities:
  if (Array.isArray(output.results)) {
    if (output.results.length === 0) return `${header}\n(geen resultaten)`;
    const isWeb = step.capability === 'web';
    const lines = output.results.map((r) => {
      if (typeof r === 'string') return `- ${r.slice(0, 280)}`;
      const title = r.title ? `${r.title} — ` : '';
      const text = r.text || r.snippet || '';
      const rel = r && typeof r.relevance === 'number' ? ` (relevance: ${r.relevance})` : '';
      const url = r.url ? ` (bron: ${r.url})` : '';
      return `- ${title}${String(text).slice(0, 280)}${rel}${url}`;
    });
    const guidance = isWeb
      ? '\nUse these sources as background only — answer in your own words; mention sources only where they genuinely support a claim.'
      : '';
    return [header, ...lines, guidance].join('\n');
  }
  return `${header}\n${JSON.stringify(output).slice(0, 600)}`;
}

/**
 * Decision Engine 3.0 — sequential plan execution.
 *
 * Executes EXACTLY the steps Gaia decided, in order, resolving each step's
 * backward `sources` references into prior results. No replanning, no
 * step insertion, no parallelism (spec §11/§13): a failed REQUIRED step
 * stops the plan with a structured failure; an OPTIONAL step's failure is
 * recorded and execution continues without its result. The last successful
 * step's output becomes ExecutionResult.output — normally a generation
 * step speaking in Gaia's voice, or a terminal capability result when the
 * plan ends at retrieval/capability (web-style, spec §8).
 *
 * @param {import('../decision/decisionSchema').Decision} decision action==='plan'
 * @param {object} ctx same context as execute()
 */
async function executePlan(decision, ctx = {}) {
  const {
    capabilities = {},
    nativeGenerator,
    messages,
    onDelta,
    conversationId = null,
  } = ctx;

  const stepReports = [];
  const outputsById = new Map(); // stepId → formatted context text for later steps
  let lastOutput = null;

  for (const step of decision.steps || []) {
    const startedAt = Date.now();
    // Resolve this step's references: prior results ride along as a plain
    // sources map AND as rendered context for generation/reasoning inputs.
    const resolvedSources = {};
    for (const ref of step.sources || []) {
      resolvedSources[ref] = outputsById.has(ref) ? outputsById.get(ref) : null;
    }

    let invokeMessages = messages;
    if ((step.type === 'reasoning' || step.type === 'generation') && step.sources && step.sources.length > 0) {
      const contextBlock = ['Results from earlier plan steps:', ''];
      for (const ref of step.sources) {
        contextBlock.push(outputsById.has(ref) ? outputsById.get(ref) : `[${ref}] (ontbreekt — optionele stap faalde)`);
        contextBlock.push('');
      }
      invokeMessages = [
        ...(messages || []),
        { role: 'system', content: contextBlock.join('\n').trim() },
      ];
    }

    // P0: every capability-backed step runs through the outcome loop —
    // the step's own expected_outcome when Logos stated one, else the
    // neutral per-type default. Native generation stays direct (not a
    // capability execution).
    const runStepThroughLoop = async ({ stepMessages, stepInput }) => {
      const adapter = resolveAdapter(capabilities, step.capability);
      if (!adapter) {
        throw new Error(`capability "${step.capability}" is not available`);
      }
      const expectedOutcome = normalizeExpectedOutcome(step.expected_outcome)
        || defaultExpectedOutcome({ capabilityId: step.capability, task: decision.task, step });
      const request = buildCapabilityRequest({
        capabilityId: step.capability,
        task: decision.task,
        input: stepInput,
        messages: stepMessages,
        skill: step.skill,
        conversationId,
        expectedOutcome,
      });
      const loop = await runCapabilityLoop({
        request,
        adapter,
        max_attempts: decision.max_attempts,
        adapterOptions: { onDelta, conversationId },
      });
      if (loop.verdict === 'success') return unwrapLoopOutput(loop.lastResult);
      if (loop.verdict === 'ask_user') {
        const missing = loop.lastEvaluation && loop.lastEvaluation.missingInfo
          ? loop.lastEvaluation.missingInfo
          : (loop.lastEvaluation && loop.lastEvaluation.reason) || 'missing information';
        throw new Error(`capability needs more information: ${missing}`);
      }
      throw new Error((loop.lastEvaluation && loop.lastEvaluation.reason) || 'capability execution failed');
    };

    try {
      let output;
      switch (step.type) {
        case 'retrieval':
        case 'capability': {
          const stepInput = Object.keys(resolvedSources).length > 0
            ? { ...(step.input || {}), sources: resolvedSources }
            : (step.input || {});
          output = await runStepThroughLoop({ stepMessages: messages, stepInput });
          break;
        }
        case 'reasoning': {
          output = await runStepThroughLoop({ stepMessages: invokeMessages, stepInput: step.input });
          break;
        }
        case 'generation': {
          if (step.mode === 'native') {
            if (!nativeGenerator || typeof nativeGenerator.generate !== 'function') {
              throw new Error('native generator is not available');
            }
            output = onDelta && typeof nativeGenerator.stream === 'function'
              ? await nativeGenerator.stream(invokeMessages, { onDelta })
              : await nativeGenerator.generate(invokeMessages);
          } else {
            output = await runStepThroughLoop({ stepMessages: invokeMessages, stepInput: step.input });
          }
          break;
        }
        default:
          throw new Error(`unknown step type: ${step.type}`);
      }

      lastOutput = output;
      outputsById.set(step.id, formatStepOutputForContext(step, output));
      stepReports.push({
        id: step.id,
        type: step.type,
        capability: step.capability || null,
        status: 'success',
        latencyMs: Date.now() - startedAt,
      });
    } catch (err) {
      stepReports.push({
        id: step.id,
        type: step.type,
        capability: step.capability || null,
        status: 'failed',
        latencyMs: Date.now() - startedAt,
        error: String(err && err.message ? err.message : err),
      });
      if (!step.optional) {
        // Required failure ⇒ the plan stops HERE. Structured failure, calm
        // null output; no replanning, no silent fallback to another
        // capability — that choice belongs to Gaia, not to execution.
        return {
          action: 'plan',
          output: null,
          error: `plan step "${step.id}" failed: ${err && err.message ? err.message : err}`,
          reason: decision.reason,
          steps: stepReports,
        };
      }
      outputsById.set(step.id, `[${step.id}] (stap faalde — optioneel, plan ging verder)`);
    }
  }

  return { action: 'plan', output: lastOutput, steps: stepReports, reason: decision.reason };
}

module.exports = { execute };
