'use strict';

/**
 * Legacy capability bridge (P0 runtime integration — backward compatibility).
 *
 * Wraps an existing `{ invoke(messages, options) }` capability (the shape
 * the Orchestrator has always spoken: web, conversation_search, hindsight,
 * tools) into the generic `{ id, invokeCapability(request, options) }`
 * adapter interface, so EVERY capability execution runs through the same
 * P0 outcome loop — including capabilities that have no dedicated adapter
 * (yet). Small, temporary-compatible, and capability-neutral: it knows
 * nothing about any concrete capability.
 *
 * Translation both ways:
 *   request.context.{messages,task,input,conversationId,skill} → invoke(messages, {…})
 *   raw string → CapabilityResult as-is;
 *   raw structured payload → evaluation text (JSON summary) + original in `data`
 *   throw → generic failure result (never rethrown).
 */

const { validateCapabilityRequest, toCapabilityResult } = require('../logos/capabilityContract');

function evaluationTextFor(raw, capabilityId) {
  if (typeof raw === 'string') return raw;
  if (raw === null || raw === undefined) return '';
  try {
    const text = JSON.stringify(raw);
    return typeof text === 'string' ? text.slice(0, 600) : '';
  } catch (_) {
    return `capability "${capabilityId || 'unknown'}" returned an unstructured result`;
  }
}

/**
 * @param {{ id?: string, invoke: Function }} entry an existing legacy capability
 * @returns {{ id: string, invokeCapability: Function }}
 */
function wrapLegacyCapability(entry = {}) {
  const { id = 'legacy', invoke } = entry;
  if (typeof invoke !== 'function') {
    throw new Error('wrapLegacyCapability requires a legacy capability with invoke(messages, options)');
  }

  async function invokeCapability(request, options = {}) {
    const problem = validateCapabilityRequest(request);
    if (problem) {
      return {
        ok: false, technicalSuccess: false, output: null,
        error: `invalid capability request: ${problem}`,
        requiresUserInput: false, missingInfo: null,
      };
    }
    const ctx = request.context && typeof request.context === 'object' ? request.context : {};
    const messages = Array.isArray(ctx.messages) ? ctx.messages : [];
    const legacyOptions = {
      ...(options || {}),
      task: ctx.task,
      input: ctx.input,
      conversationId: ctx.conversationId,
      ...(typeof ctx.skill === 'string' && ctx.skill ? { skill: ctx.skill } : {}),
    };
    let raw;
    try {
      raw = await invoke(messages, legacyOptions);
    } catch (err) {
      return toCapabilityResult({ ok: false, error: String((err && err.message) || err) });
    }
    if (typeof raw === 'string' || raw === null || raw === undefined) {
      return toCapabilityResult(raw);
    }
    if (typeof raw === 'object') {
      const text = evaluationTextFor(raw, id);
      if (!text) {
        return toCapabilityResult({ ok: false, error: `capability "${id}" returned no content` });
      }
      return {
        ok: true, technicalSuccess: true, output: text, error: null,
        requiresUserInput: false, missingInfo: null, data: raw,
      };
    }
    return toCapabilityResult({ ok: false, error: `capability "${id}" returned an unusable result` });
  }

  return { id, invokeCapability };
}

module.exports = { wrapLegacyCapability };
