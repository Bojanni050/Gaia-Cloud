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
 * capability internals (retries, provider routing, streaming framing) and
 * never writes to a response itself — see responseEngine.js for the seam
 * that turns an ExecutionResult into what the client actually sees.
 */

const { validateDecision } = require('../decision/decisionSchema');

/**
 * @typedef {Object} ExecutionResult
 * @property {'native'|'capability'|'tool'|'clarify'|'refuse'} action
 * @property {string} [capability]
 * @property {*} [output] - the capability's raw result, or null when none was called
 * @property {string} [error] - set when a named capability/tool was not available
 * @property {string} [reason] - carried through from the Decision, for clarify/refuse
 */

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
      const capability = capabilities[decision.capability];
      if (!capability || typeof capability.invoke !== 'function') {
        return {
          action: decision.action,
          capability: decision.capability,
          output: null,
          error: `capability "${decision.capability}" is not available`,
        };
      }
      // conversationId rides along for capabilities that need to identify
      // the current conversation (e.g. conversation_search) — pure context
      // forwarding; the Orchestrator makes no judgment with it.
      const output = await capability.invoke(messages, { onDelta, task: decision.task, input: decision.input, conversationId });
      return { action: decision.action, capability: decision.capability, output };
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
  // Structured outputs ({results:[...], total}) from retrieval capabilities:
  if (Array.isArray(output.results)) {
    if (output.results.length === 0) return `${header}\n(geen resultaten)`;
    const lines = output.results.map((r) => {
      const text = typeof r === 'string' ? r : (r.text || '');
      const rel = r && typeof r.relevance === 'number' ? ` (relevance: ${r.relevance})` : '';
      return `- ${String(text).slice(0, 280)}${rel}`;
    });
    return [header, ...lines].join('\n');
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

    try {
      let output;
      switch (step.type) {
        case 'retrieval':
        case 'capability': {
          const capability = capabilities[step.capability];
          if (!capability || typeof capability.invoke !== 'function') {
            throw new Error(`capability "${step.capability}" is not available`);
          }
          const stepInput = Object.keys(resolvedSources).length > 0
            ? { ...(step.input || {}), sources: resolvedSources }
            : (step.input || {});
          output = await capability.invoke(messages, { onDelta, task: decision.task, input: stepInput, conversationId });
          break;
        }
        case 'reasoning': {
          const capability = capabilities[step.capability];
          if (!capability || typeof capability.invoke !== 'function') {
            throw new Error(`reasoning capability "${step.capability}" is not available`);
          }
          output = await capability.invoke(invokeMessages, { onDelta, task: decision.task, input: step.input, conversationId });
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
            const capability = capabilities[step.capability];
            if (!capability || typeof capability.invoke !== 'function') {
              throw new Error(`generation capability "${step.capability}" is not available`);
            }
            output = await capability.invoke(invokeMessages, { onDelta, task: decision.task, input: step.input, conversationId });
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
