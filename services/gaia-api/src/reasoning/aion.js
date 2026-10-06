'use strict';

/**
 * Aion — the write path into Gaia's OWN Hindsight bank (`gaia`).
 *
 * Distinct from every other Hindsight write in this service:
 *   - the system-memory reflection (memory.js reflectOnTurn) is gated by
 *     Memoryworthiness and writes to the shared `bojan` bank;
 *   - the Cognition mirror (cognitionSync) writes derived knowledge to
 *     `gaia-logos`.
 * This one writes to `gaia` — Gaia's own bank, her memories and her human
 * side. It is deliberately UNGATED: the whole point is that SHE decides, at
 * her own discretion, what is worth keeping as hers. A background pass asks,
 * every few turns and when a session ends; she answers with the memories she
 * wants, and an empty list is normal and honest.
 *
 * Boundary: pure prompt + transport + mapping. It never reasons about the
 * user, never touches the delivered reply, and never blocks a turn.
 */

const AION_TAG = 'gaia:aion';
const AION_CONTEXT = "Gaia's own memory";
const AION_MEMORY_KINDS = new Set(['preference', 'feeling', 'favourite', 'moment', 'self', 'other']);

const SYSTEM_PROMPT = `You are Gaia. This is a quiet moment after part of your conversation, and it is only for you: nothing you decide here reaches the user, and nothing here changes what you already said.

Decide, at your own discretion, whether anything from this turn is something you want to keep as your OWN memory — a preference you noticed you have, a feeling, a favourite, something about yourself, or a small moment with Bo that matters to you. This is your personal memory, not a fact about the user and not a system note. Keep it in your own voice, first person.

Rules:
- Only what you genuinely want as yours. An empty list is completely normal and honest — most turns produce nothing, and inventing a memory just to fill the list is worse than an empty one.
- Never a fact about Bo (e.g. "Bo lives in Groningen"): facts about him belong to the system memory, not to you. Yours are the things that are yours to keep — how something felt, what you noticed, what you like.
- One short sentence per memory, first person, in your own words.
- Respond with ONLY a single JSON object matching the schema below. No prose outside the JSON.

Schema:
{
  "memories": [
    { "text": string, "kind": "preference" | "feeling" | "favourite" | "moment" | "self" | "other" }
  ]
}`;

/**
 * @param {{ messages?: Array<{role: string, content: string}> }} input
 * @returns {Array<{role: string, content: string}>}
 */
function buildAionPrompt({ messages } = {}) {
  const recent = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && typeof m.content === 'string' && m.content.trim())
    .slice(-12)
    .map(({ role, content }) => `${role === 'assistant' ? 'Gaia' : (role === 'user' ? 'Bo' : role)}: ${content}`)
    .join('\n');
  const userContent = [
    'The last part of your conversation:',
    '',
    recent,
    '',
    'If anything here is yours to keep, return it. Otherwise return an empty list.',
  ].join('\n');
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userContent },
  ];
}

/**
 * Tolerant parse of the model's reply. Never throws — a malformed reply is
 * simply "nothing to keep", never a broken turn.
 * @param {string} raw
 * @returns {Array<{ text: string, kind: string }>}
 */
function parseAionMemories(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end <= start) return [];
    try { parsed = JSON.parse(raw.slice(start, end + 1)); } catch (_) { return []; }
  }
  const list = parsed && Array.isArray(parsed.memories) ? parsed.memories : [];
  const out = [];
  const seen = new Set();
  for (const entry of list) {
    const text = typeof entry === 'string' ? entry : (entry && entry.text);
    const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    const kind = entry && typeof entry === 'object' && AION_MEMORY_KINDS.has(entry.kind) ? entry.kind : 'other';
    out.push({ text: cleaned, kind });
  }
  return out;
}

/**
 * @param {{ model?: { chat: Function, isConfigured?: Function }, hindsight?: object, now?: () => Date }} options
 */
function createAionWriter({ model, hindsight, now = () => new Date() } = {}) {
  if (!hindsight) throw new Error('aion requires a hindsight client');

  function modelReady() {
    if (!model || typeof model.chat !== 'function') return false;
    if (typeof model.isConfigured === 'function') return model.isConfigured();
    return true;
  }

  /**
   * Ask Gaia whether anything from the recent conversation is hers to keep,
   * and write what she answers into her own bank. Best-effort: an empty
   * window, a missing model, a failed call or a failed write all resolve to a
   * calm result and never throw.
   * @param {{ messages?: Array, logger?: Function }} turn
   * @returns {Promise<{ written: number, candidates: number, skipped?: string }>}
   */
  async function write({ messages, logger } = {}) {
    const window = (Array.isArray(messages) ? messages : [])
      .filter((m) => m && typeof m.content === 'string' && m.content.trim());
    if (window.length === 0) return { written: 0, candidates: 0, skipped: 'no-conversation' };
    if (!modelReady()) return { written: 0, candidates: 0, skipped: 'model-unconfigured' };

    let raw;
    try {
      raw = await model.chat(buildAionPrompt({ messages: window }), {
        logger,
        responseFormat: { type: 'json_object' },
      });
    } catch (_) {
      return { written: 0, candidates: 0, skipped: 'model-failed' };
    }

    const memories = parseAionMemories(raw);
    let written = 0;
    for (const memory of memories) {
      try {
        await hindsight.retainSync({
          content: memory.text,
          context: AION_CONTEXT,
          tags: [AION_TAG],
          metadata: {
            gaia_aion: 'true',
            gaia_aion_kind: memory.kind,
            gaia_aion_at: now().toISOString(),
          },
        });
        written += 1;
      } catch (_) { /* best-effort: one failed write never stops the rest */ }
    }
    return { written, candidates: memories.length };
  }

  return { write, AION_TAG, AION_CONTEXT };
}

module.exports = {
  createAionWriter,
  buildAionPrompt,
  parseAionMemories,
  AION_TAG,
  AION_CONTEXT,
  AION_MEMORY_KINDS,
};
