'use strict';

/**
 * Primary/backup generation failover — the v3.0 live inference seam.
 *
 * Gaia speaks through ONE configured inference provider at a time
 * (primary first, backup on retryable failure). The backup is a plain
 * OpenAI-compatible inference provider — no tools, no memory, no agency.
 * Config (not content or intent) decides priority: there is no
 * content-driven provider choice in the live flow.
 *
 * Failover rules:
 *   - backup is used when no primary is configured, or when the primary
 *     fails BEFORE visible output with a timeout, network error, 429 or 5xx
 *     (gaiaGenerator.GenerationError with retryable === true).
 *   - never on config errors or other 4xx.
 *   - streaming failover is only allowed before the first visible content
 *     token; afterwards the Response Engine reports the failure and no
 *     second generation starts.
 *   - Hermes is never a fallback and is never called from here.
 */

const { isRetryableGenerationError } = require('./gaiaGenerator');

/**
 * @param {{ generate?: Function, stream?: Function }|null|undefined} generator
 * @returns {boolean}
 */
function hasGenerator(generator) {
  return Boolean(generator && (typeof generator.generate === 'function' || typeof generator.stream === 'function'));
}

/**
 * Non-streaming generation with backup failover.
 * @param {Array} messages assembled prompt (system + history)
 * @param {{ primary?: object|null, backup?: object|null }} generators
 * @returns {Promise<string>}
 */
async function generateWithFailover(messages, { primary, backup } = {}) {
  if (hasGenerator(primary) && typeof primary.generate === 'function') {
    try {
      return await primary.generate(messages);
    } catch (err) {
      if (!hasGenerator(backup) || typeof backup.generate !== 'function' || !isRetryableGenerationError(err)) {
        throw err;
      }
      try {
        console.log(JSON.stringify({ kind: 'generation.failover', from: 'primary', to: 'backup', mode: 'non-streaming' }));
      } catch (_) { /* never break generation */ }
      return backup.generate(messages);
    }
  }
  if (hasGenerator(backup) && typeof backup.generate === 'function') {
    return backup.generate(messages);
  }
  const err = new Error('generation is not configured');
  err.code = 'not_configured';
  err.retryable = false;
  throw err;
}

/**
 * Streaming generation with backup failover. `onDelta` receives
 * `(chunk, isReasoning)`; only non-reasoning chunks count as visible
 * output. Failover runs only before the first visible chunk.
 * @param {Array} messages
 * @param {{ primary?: object|null, backup?: object|null, onDelta?: Function, signal?: AbortSignal }} options
 * @returns {Promise<string>} full accumulated text
 */
async function streamWithFailover(messages, { primary, backup, onDelta, signal } = {}) {
  const runStream = async (generator, deltaForwarder) => {
    if (typeof generator.stream === 'function') {
      return generator.stream(messages, { ...(signal ? { signal } : {}), ...(deltaForwarder ? { onDelta: deltaForwarder } : {}) });
    }
    // Non-streaming generator behind a streaming transport: produce the
    // full text, then deliver it as one delta (Response Engine dedupes).
    const text = await generator.generate(messages);
    if (deltaForwarder) deltaForwarder(text, false);
    return text;
  };

  if (hasGenerator(primary)) {
    let visibleOutput = false;
    const trackingDelta = onDelta
      ? (chunk, isReasoning) => {
        if (chunk && !isReasoning) visibleOutput = true;
        onDelta(chunk, isReasoning);
      }
      : undefined;
    try {
      return await runStream(primary, trackingDelta);
    } catch (err) {
      const mayFailover = !visibleOutput
        && hasGenerator(backup)
        && isRetryableGenerationError(err);
      if (!mayFailover) throw err;
      try {
        console.log(JSON.stringify({ kind: 'generation.failover', from: 'primary', to: 'backup', mode: 'streaming' }));
      } catch (_) { /* never break generation */ }
      return runStream(backup, onDelta);
    }
  }
  if (hasGenerator(backup)) {
    return runStream(backup, onDelta);
  }
  const err = new Error('generation is not configured');
  err.code = 'not_configured';
  err.retryable = false;
  throw err;
}

/**
 * @param {Error} error
 * @returns {boolean} true when no generator was configured at all
 */
function isNotConfiguredError(error) {
  return Boolean(error && error.code === 'not_configured');
}

module.exports = {
  hasGenerator,
  generateWithFailover,
  streamWithFailover,
  isNotConfiguredError,
};
