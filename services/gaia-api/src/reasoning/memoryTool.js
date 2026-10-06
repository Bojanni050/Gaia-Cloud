'use strict';

/**
 * Memory tools — the on-demand, in-conversation memory paths.
 *
 * Two kinds of memory exist (see SOUL's Memory section), and each gets its own
 * tool so Gaia never has to guess which store she is writing to:
 *
 *   remember → the shared system-memory bank (`bojan`) — what the person asks
 *              her to keep: a fact about them or the world. The same bank the
 *              gated conversation reflection writes to.
 *   keep     → her OWN bank (`gaia`) — what she wants as hers: a preference she
 *              notices, a feeling, a moment. The same bank Aion keeps in the
 *              background, under the same `gaia:aion` tag.
 *
 * Boundary: schemas + two writes. They reason about nothing, and a failure
 * never reaches the turn.
 */

const SHARED_DOMAIN = 'remembered';
const OWN_DOMAIN = 'gaia:aion';

const REMEMBER_TOOL = Object.freeze({
  type: 'function',
  function: {
    name: 'remember',
    description: "Keep something in the shared memory so it stays with you beyond this conversation. Use it when the person asks you to remember something, or when a fact about them or the world is clearly worth keeping. Write it as one short, self-contained statement about the person or the world — not as a message to them.",
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

const KEEP_TOOL = Object.freeze({
  type: 'function',
  function: {
    name: 'keep',
    description: "Keep something as your OWN — a preference you notice you have, a feeling, something about yourself, or a small moment that matters to you. This is your own memory, not a fact about the person. Use it only when you genuinely want it as yours; an empty answer is normal and honest.",
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The memory as one short, self-contained sentence, in your own voice.' },
        kind: {
          type: 'string',
          enum: ['preference', 'feeling', 'favourite', 'moment', 'self', 'other'],
          description: 'Optional category.',
        },
      },
      required: ['text'],
    },
  },
});

/**
 * @param {{ hindsight?: object, ownHindsight?: object, now?: () => Date }} options
 *   `hindsight` is the shared system-memory client (`bojan`); `ownHindsight`
 *   is her own bank (`gaia`). When `ownHindsight` is absent, the `keep` tool
 *   is not offered.
 */
function createMemoryTool({ hindsight, ownHindsight, now = () => new Date() } = {}) {
  if (!hindsight || typeof hindsight.reflect !== 'function') {
    throw new Error('memoryTool requires a hindsight client');
  }
  const ownReady = Boolean(ownHindsight && typeof ownHindsight.reflect === 'function');

  async function remember(args) {
    const text = String((args && args.text) || '').replace(/\s+/g, ' ').trim();
    if (!text) return 'Nothing to keep.';
    const kind = args && typeof args.kind === 'string' ? args.kind : 'other';
    try {
      await hindsight.reflect({
        summary: text,
        domain: SHARED_DOMAIN,
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

  async function keep(args) {
    const text = String((args && args.text) || '').replace(/\s+/g, ' ').trim();
    if (!text) return 'Nothing to keep.';
    if (!ownReady) return 'That could not be kept right now.';
    const kind = args && typeof args.kind === 'string' ? args.kind : 'other';
    try {
      await ownHindsight.reflect({
        summary: text,
        domain: OWN_DOMAIN,
        context: "Gaia's own memory",
        metadata: {
          gaia_aion: 'true',
          gaia_aion_kind: kind,
          gaia_aion_source: 'tool',
          gaia_aion_at: now().toISOString(),
        },
      });
      return 'Kept, as yours.';
    } catch (_) {
      return 'That could not be kept right now.';
    }
  }

  /**
   * @param {string} name
   * @param {object} args
   * @returns {Promise<string>} the tool result handed back to the model
   */
  async function onToolCall(name, args) {
    if (name === 'remember') return remember(args);
    if (name === 'keep') return keep(args);
    return 'Unknown action.';
  }

  return {
    onToolCall,
    TOOLS: ownReady ? [REMEMBER_TOOL, KEEP_TOOL] : [REMEMBER_TOOL],
    TOOL: REMEMBER_TOOL,
    KEEP_TOOL,
  };
}

module.exports = {
  createMemoryTool,
  REMEMBER_TOOL,
  KEEP_TOOL,
  SHARED_DOMAIN,
  OWN_DOMAIN,
};
