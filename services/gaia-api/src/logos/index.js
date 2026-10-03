'use strict';

/**
 * Logos — composes the unified V3 faculty for one turn.
 *
 * V3: intent interpretation and reasoning are prompt-level faculties of
 * one Logos pass, not separate IntentIQ/ReasonIQ subsystems. An optional
 * intent hint may be supplied (while IntentIQ still exists); Logos tests
 * it, never trusts it blindly, and works without it.
 *
 * Not wired into turn.js's live path: the live turn is direct generation
 * and Logos runs as background reflection after delivery (see turn.js's
 * runDeferredCognition). This module exists for explicit callers and
 * tests that want the full single-pass seam in one place.
 */

const logos = require('./logos');

/**
 * @param {Array<{role: string, content: string}>} messages
 * @param {{
 *   evidence?: Array<{content: string, source?: string}>,
 *   intentHint?: object|null,
 *   contextId?: string,
 *   model?: object,
 *   reasoningModel?: object,
 *   silent?: boolean,
 *   logger?: Function,
 * }} [options]
 * @returns {Promise<{ intentHint: object|null, logosResult: object }>}
 */
async function runLogos(messages, options = {}) {
  const text = latestUserText(messages);
  const logosResult = await logos.evaluate(
    {
      text,
      intentHint: options.intentHint || null,
      conversationContext: messages,
      evidence: options.evidence || [],
      contextId: options.contextId,
    },
    { model: options.model || options.reasoningModel, silent: options.silent, logger: options.logger }
  );

  return { intentHint: options.intentHint || null, logosResult };
}

function latestUserText(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i -= 1) {
    if (messages[i] && messages[i].role === 'user') return messages[i].content || '';
  }
  return '';
}

module.exports = { runLogos };
