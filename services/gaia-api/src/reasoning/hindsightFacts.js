'use strict';

/**
 * Hindsight extracts facts from a retained document asynchronously, so the
 * native fact ids may not be queryable the instant the write returns. The
 * hypothesis, pattern and cognition adapters all adopt those ids right after
 * writing; this is the one place that waits for them.
 *
 * Polls `listMemories` up to `attempts` times, `delayMs` apart, and returns the
 * first non-empty answer (or the last, empty one).
 * @param {{ listMemories: Function }} client
 * @param {string} documentId
 * @param {number} [attempts]
 * @param {number} [delayMs]
 */
async function adoptDocumentFacts(client, documentId, attempts = 3, delayMs = 150) {
  let last = [];
  for (let i = 0; i < attempts; i += 1) {
    last = await client.listMemories({ documentId, type: 'world' });
    if (last.length > 0) return last;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return last;
}

module.exports = { adoptDocumentFacts };
