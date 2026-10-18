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
 * A third verb reads back: `search_memory` is the on-demand counterpart to the
 * per-turn gated recall (`memory.js`'s `recallRelevantContext`). Recall only
 * runs when the turn carried a past-reference cue; on a turn that didn't, Gaia
 * had no way to open her own memory and could honestly answer "I cannot look
 * that up". This tool lets her reach for it herself — ungated, across every bank
 * the turn's recall spans (the cross-bank client `server.js` builds), rendered
 * through the same `condenseMemoryContext` the passive path uses.
 *
 * INVARIANT: the `gaia` bank is HERS ALONE. No client can write to it — the
 * only writers are this `keep` tool and the background Aion pass, both of
 * which are her own decisions (see SOUL's Memory section: nobody decides what
 * goes into her own memory, and a request to remember something belongs to the
 * shared bank instead). There is deliberately no user-facing write path.
 *
 * A fourth verb takes something back: `retract_memory` is how the person's
 * "that is not correct" reaches the store instead of stopping at an apology.
 * It has no opinion of its own — memoryRetraction.js finds the memory the
 * person meant, invalidates it, retires the derived statement it came from,
 * and keeps their correction as theirs. The tool exists so the verdict has
 * somewhere to go; a memory the model dislikes is not a reason to use it.
 *
 * A fifth verb is `forget_memory` — the same withdrawal for the other thing a
 * person says: "I do not want you to have that". It passes no judgement on
 * truth and keeps nothing in the memory's place, because a memory can be true
 * and still not belong in recall. Without it, "forget this" had no verb at all
 * and the only route out of the store was to call the person's own history a
 * lie.
 *
 * Boundary: schemas, a read, two writes, one retraction and one forgetting.
 * They reason about nothing, and a failure never reaches the turn.
 */

const { AsyncLocalStorage } = require('node:async_hooks');
// Same renderer the passive recall path uses (`renderMemoryContext`), so an
// on-demand lookup and a gated one show her memory the same way — including
// the "(uncertain)" marker for low-confidence items.
const { condenseMemoryContext } = require('../memory');
// The retraction path — the person's verdict carried out, never her own call.
const { retractMemory, forgetMemory, renderRetractionReceipt, renderForgetReceipt } = require('./memoryRetraction');

/**
 * Lets the turn that is running hear that `remember` kept something, without the tool knowing about
 * turns, streams or clients: the turn wraps its generation in `withKeptNotifier`, and `remember` calls
 * the notifier of whichever turn it is running inside (so two turns at once never hear each other's).
 * Only the shared bank (`bojan`) is announced; her own bank (`gaia`) is hers and stays unannounced.
 */
const turnKept = new AsyncLocalStorage();

/**
 * @param {(kept: { bank: string, kind: string, text: string }) => void} onKept
 * @param {() => Promise<any>} fn
 */
function withKeptNotifier(onKept, fn) {
  return turnKept.run({ onKept }, fn);
}

function announceKept(kept) {
  const store = turnKept.getStore();
  if (!store || typeof store.onKept !== 'function') return;
  try {
    store.onKept(kept);
  } catch (_) {
    /* announcing never touches the turn */
  }
}

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
    description: "Keep something as your OWN — a preference you notice you have, a feeling, something about yourself, or a small moment that matters to you. This is your own memory, not a fact about the person. Use it ONLY by your own choice: never because someone asked you to put something in your memory — that is not theirs to decide, and a request to remember something belongs to the shared memory instead. An empty answer is normal and honest.",
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

const SEARCH_TOOL = Object.freeze({
  type: 'function',
  function: {
    name: 'search_memory',
    description: "Look something up in your memory — what you have come to understand about the person and the world, and what you keep as your own. Use this when you need to recall something that is not already in this conversation, instead of saying you cannot look it up. Give a short search phrase; you will get back the remembered statements that match, or none.",
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for, as a short search phrase.' },
      },
      required: ['query'],
    },
  },
});

const RETRACT_TOOL = Object.freeze({
  type: 'function',
  function: {
    name: 'retract_memory',
    description: "Take back something you remembered that turned out not to be true. Use it when the person tells you that something you said from memory is wrong: give what you recalled in `quote` — a few words are enough, the statement is found for you — and put their own correction in `correction` if they gave you one. Every copy of that statement is withdrawn from recall, and if it came from something you had confirmed, that statement is retired too, so it cannot come back. Use it ONLY when the person says it is not true, never to make a memory you dislike go away.",
    parameters: {
      type: 'object',
      properties: {
        quote: { type: 'string', description: 'The remembered statement that is not true, as you recalled it.' },
        correction: { type: 'string', description: "What is true instead, in the person's own words. Optional — leave it out when they only said it was wrong." },
      },
      required: ['quote'],
    },
  },
});

const FORGET_TOOL = Object.freeze({
  type: 'function',
  function: {
    name: 'forget_memory',
    description: "Forget something: take it out of your memory because the person asked you to, whether or not it was ever true. Use it when they say a memory should not be there — \"forget that\", \"that should not be in your memory\", \"I do not want you to remember this\". Nothing is kept in its place, so do not use it when they tell you something is WRONG and give you what is true instead — that is `retract_memory`. Every copy of the memory is withdrawn from recall and the statement behind it is retired, so it cannot come back. Use it ONLY because the person asked, never to make a memory you dislike go away.",
    parameters: {
      type: 'object',
      properties: {
        quote: { type: 'string', description: 'The memory to forget, quoted closely enough to find it — a few words are enough.' },
      },
      required: ['quote'],
    },
  },
});

/**
 * @param {{ hindsight?: object, ownHindsight?: object, searchHindsight?: object,
 *           banks?: Array<{name: string, client: object}>, home?: {name: string, client: object},
 *           cognition?: object|null, sync?: object|null, now?: () => Date }} options
 *   `hindsight` is the shared system-memory client (`bojan`); `ownHindsight`
 *   is her own bank (`gaia`); `searchHindsight` is the cross-bank recall client
 *   the turn's gated recall uses. When `ownHindsight` is absent, the `keep` tool
 *   is not offered; when `searchHindsight` is absent, `search_memory` is not.
 *   `banks` is every bank a memory may be taken back FROM (each with the client
 *   that owns it, so the right store is patched); `home` is where a correction
 *   is kept; `cognition`/`sync` retire the derived statement a memory came
 *   from. Without `banks` neither `retract_memory` nor `forget_memory` is
 *   offered at all — better no tool than one that pretends to take something
 *   back.
 */
function createMemoryTool({
  hindsight,
  ownHindsight,
  searchHindsight,
  banks = null,
  home = null,
  cognition = null,
  sync = null,
  now = () => new Date(),
} = {}) {
  if (!hindsight || typeof hindsight.reflect !== 'function') {
    throw new Error('memoryTool requires a hindsight client');
  }
  const ownReady = Boolean(ownHindsight && typeof ownHindsight.reflect === 'function');
  const searchReady = Boolean(searchHindsight && typeof searchHindsight.recall === 'function');
  const retractReady = Array.isArray(banks) && banks.length > 0;

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
      announceKept({ bank: 'bojan', kind, text });
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

  async function searchMemory(args) {
    const query = String((args && args.query) || '').replace(/\s+/g, ' ').trim();
    if (!query) return 'Nothing to search for.';
    if (!searchReady) return 'That could not be looked up right now.';
    try {
      const results = await searchHindsight.recall(query);
      const lines = condenseMemoryContext(results);
      if (lines.length === 0) return 'Nothing in memory about that.';
      return lines.join('\n');
    } catch (_) {
      return 'That could not be looked up right now.';
    }
  }

  /**
   * Taking a memory back is not a write to a store she owns — it is the
   * person's verdict carried out (see memoryRetraction.js). She needs the
   * person to have said it first; the tool exists so the verdict has somewhere
   * to go, and the receipt names the memory so it is visible which one went.
   */
  async function retractMemoryFromMemory(args) {
    const quote = String((args && args.quote) || '').replace(/\s+/g, ' ').trim();
    if (!quote) return 'Nothing named to take back.';
    if (!retractReady) return 'That could not be taken back right now.';
    try {
      const receipt = await retractMemory({
        banks,
        home,
        cognition,
        sync,
        quote,
        correction: args && args.correction,
        now: now(),
      });
      return renderRetractionReceipt(receipt);
    } catch (_) {
      return 'That could not be taken back right now.';
    }
  }

  /**
   * Forgetting is the second thing a person can ask of memory — "I do not want
   * you to have that" — and unlike a retraction it says nothing about truth. It
   * shares the withdrawal machinery (and the receipt shape) with retraction;
   * what it does not do is keep a correction, because nothing was offered as the
   * true version.
   */
  async function forgetMemoryFromMemory(args) {
    const quote = String((args && args.quote) || '').replace(/\s+/g, ' ').trim();
    if (!quote) return 'Nothing named to forget.';
    if (!retractReady) return 'That could not be forgotten right now.';
    try {
      const receipt = await forgetMemory({ banks, cognition, sync, quote, now: now() });
      return renderForgetReceipt(receipt);
    } catch (_) {
      return 'That could not be forgotten right now.';
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
    if (name === 'search_memory') return searchMemory(args);
    if (name === 'retract_memory') return retractMemoryFromMemory(args);
    if (name === 'forget_memory') return forgetMemoryFromMemory(args);
    return 'Unknown action.';
  }

  const TOOLS = [REMEMBER_TOOL];
  if (searchReady) TOOLS.push(SEARCH_TOOL);
  if (ownReady) TOOLS.push(KEEP_TOOL);
  if (retractReady) TOOLS.push(RETRACT_TOOL, FORGET_TOOL);

  return {
    onToolCall,
    TOOLS,
    TOOL: REMEMBER_TOOL,
    KEEP_TOOL,
    SEARCH_TOOL,
    RETRACT_TOOL,
    FORGET_TOOL,
  };
}

module.exports = {
  createMemoryTool,
  withKeptNotifier,
  REMEMBER_TOOL,
  KEEP_TOOL,
  SEARCH_TOOL,
  RETRACT_TOOL,
  FORGET_TOOL,
  SHARED_DOMAIN,
  OWN_DOMAIN,
};
