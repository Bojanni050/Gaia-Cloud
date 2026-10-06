'use strict';

/**
 * Memory tool — the on-demand counterpart to Aion.
 *
 * Aion runs in the background and writes what Gaia herself wants to keep into
 * HER bank (`gaia`). This is the explicit, in-conversation path: when the
 * person asks Gaia to remember something (or she judges it worth keeping), the
 * model calls `remember`, and the statement lands in the shared system-memory
 * bank (`bojan`) — the same bank the gated conversation reflection writes to.
 * It is deliberately NOT Gaia's own bank: hers is for what she chooses; this
 * is for what she is asked to hold.
 *
 * Boundary: schema + a single write. It reasons about nothing, and it never
 * lets a failure reach the turn.
 */

const REMEMBER_DOMAIN = 'remembered';

const REMEMBER_TOOL = Object.freeze({
  type: 'function',
  function: {
    name: 'remember',
    description: "Keep something in your long-term memory so it stays with you beyond this conversation. Use it when the person asks you to remember something, or when something is clearly worth keeping. Write it as one short, self-contained statement about the person or the world — not as a message to them.",
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The memory as one short, self-contained statement.' },
        kind: {
          type: 'string',
          enum: ['fact', 'preference', 'decision', 'person', 'event', 'other'],
          description: 'Optional category.',
        },
      },
      required: ['text'],
    },
  },
});

/**
 * @param {{ hindsight?: object, now?: () => Date }} options `hindsight` is the
 *   system-memory client (the `bojan` bank).
 */
function createMemoryTool({ hindsight, now = () => new Date() } = {}) {
  if (!hindsight || typeof hindsight.reflect !== 'function') {
    throw new Error('memoryTool requires a hindsight client');
  }

  /**
   * @param {string} name
   * @param {object} args
   * @returns {Promise<string>} the tool result handed back to the model
   */
  async function onToolCall(name, args) {
    if (name !== 'remember') return 'Unknown action.';
    const text = String((args && args.text) || '').replace(/\s+/g, ' ').trim();
    if (!text) return 'Nothing to keep.';
    const kind = args && typeof args.kind === 'string' ? args.kind : 'other';
    try {
      await hindsight.reflect({
        summary: text,
        domain: REMEMBER_DOMAIN,
        context: 'remembered on request',
        metadata: {
          gaia_remembered: 'true',
          gaia_remembered_kind: kind,
          gaia_remembered_at: now().toISOString(),
        },
      });
      return 'Kept.';
    } catch (_) {
      return 'That could not be kept right now.';
    }
  }

  return { onToolCall, TOOL: REMEMBER_TOOL };
}

module.exports = { createMemoryTool, REMEMBER_TOOL, REMEMBER_DOMAIN };
