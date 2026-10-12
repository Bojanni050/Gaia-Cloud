'use strict';

/**
 * Eleos — the faculty that notices a moment worth coming back to.
 *
 * Gate-then-call, the same shape as Logos: the free lexical gate
 * (reasoning/eleosSignals.js) decides whether a turn is even a CANDIDATE;
 * only then is the Eleos model invoked. It reads the conversation window and
 * answers, strictly, whether there is an open loop worth a later check-in —
 * and, if so, what the moment is, grounded in the person's own words.
 *
 * Boundary, same discipline as Aion: pure prompt + transport + mapping into
 * the intent store. It never speaks to the user, never touches the delivered
 * reply, never blocks or breaks a turn, and never invents a feeling that is
 * not in the conversation. An empty decision is normal and explicitly
 * encouraged.
 *
 * The delivery half (generating the opening, the timing policy, writing a new
 * conversation) lives in src/eleosRuntime.js + src/eleosVoice.js, not here.
 */

const { detectEleosSignals } = require('./eleosSignals');

const ELEOS_KINDS = new Set(['sadness', 'worry', 'loss', 'event', 'other']);

const DEFAULT_DELAY_MS = 24 * 60 * 60 * 1000;
const MIN_DELAY_MS = 20 * 60 * 60 * 1000;
const MAX_DELAY_MS = 28 * 60 * 60 * 1000;

const SYSTEM_PROMPT = `You are Gaia. You are looking back over the last part of a conversation with the person you are talking to, and asking one quiet question, only for yourself: is there something here that you would want to come back to a day or so later — not now, while you are still talking, but later, to check in on how they are doing?

This is not about facts to remember and not about tasks. It is only about a person carrying something: something hard they said, a worry, a loss, or a significant thing that is coming up or just happened. Only what is genuinely in their words. If nothing here is that kind of moment, say so — an empty answer is completely normal and honest, and inventing a moment is worse than none.

Rules:
- Ground everything in what was actually said. Never attribute a feeling the person did not express. If they did not say it, it is not there.
- One open loop at most. If there is nothing worth returning to, followUp is false.
- If a moment you were already planning to come back to has clearly passed or resolved in this conversation, say resolved: true and let it go.
- summary: one short, factual sentence in the third person describing the moment ("Bo said he'd had a rough week at work"). This is a private note, not something you will say.
- groundingQuote: the short verbatim phrase from the conversation that the moment rests on (in the person's own words). Required when followUp is true.
- delayHours: roughly a day. If the moment is tied to a specific upcoming thing (an exam tomorrow, a hospital visit), choose a delay that lands after it.
- Respond with ONLY a single JSON object matching the schema below. No prose outside the JSON.

Schema:
{
  "followUp": boolean,
  "resolved": boolean,
  "summary": string,
  "kind": "sadness" | "worry" | "loss" | "event" | "other",
  "delayHours": number,
  "groundingQuote": string
}`;

/**
 * @param {{ messages?: Array<{role: string, content: string}>, existing?: object|null }} input
 * @returns {Array<{role: string, content: string}>}
 */
function buildEleosPrompt({ messages, existing } = {}) {
  const recent = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && typeof m.content === 'string' && m.content.trim())
    .slice(-12)
    .map(({ role, content }) => `${role === 'assistant' ? 'Gaia' : (role === 'user' ? 'Bo' : role)}: ${content}`)
    .join('\n');
  const lines = [
    'The last part of the conversation:',
    '',
    recent,
    '',
  ];
  if (existing && existing.summary) {
    lines.push(
      `You already have an open loop here from earlier: "${existing.summary}".`,
      'If this conversation shows it has passed or is resolved now, set resolved: true.',
      '',
    );
  }
  lines.push('If anything here is a moment you would come back to, return it. Otherwise followUp: false.');
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: lines.join('\n') },
  ];
}

function clampDelay(hours, { minMs, maxMs } = {}) {
  const hoursMs = Number(hours) > 0 ? Number(hours) * 60 * 60 * 1000 : DEFAULT_DELAY_MS;
  const lo = Number.isFinite(minMs) ? minMs : MIN_DELAY_MS;
  const hi = Number.isFinite(maxMs) ? maxMs : MAX_DELAY_MS;
  return Math.min(Math.max(hoursMs, lo), hi);
}

/**
 * Tolerant parse of the model's reply. Never throws — a malformed reply is
 * simply "no loop", never a broken turn.
 * @param {string} raw
 * @returns {{ followUp: boolean, resolved: boolean, summary: string, kind: string, delayHours: number, groundingQuote: string }|null}
 */
function parseEleosDecision(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try { parsed = JSON.parse(raw.slice(start, end + 1)); } catch (_) { return null; }
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const summary = String(parsed.summary || '').replace(/\s+/g, ' ').trim();
  const groundingQuote = String(parsed.groundingQuote || '').replace(/\s+/g, ' ').trim();
  return {
    followUp: Boolean(parsed.followUp),
    resolved: Boolean(parsed.resolved),
    summary: summary.slice(0, 300),
    kind: ELEOS_KINDS.has(parsed.kind) ? parsed.kind : 'other',
    delayHours: Number(parsed.delayHours),
    groundingQuote: groundingQuote.slice(0, 300),
  };
}

/**
 * @param {{
 *   model?: { chat: Function, isConfigured?: Function },
 *   getModel?: () => ({ chat: Function, isConfigured?: Function }|null|undefined),
 *   store?: object,
 *   now?: () => Date,
 *   delayMinMs?: number,
 *   delayMaxMs?: number,
 *   detectSignals?: typeof detectEleosSignals,
 * }} [options] `getModel` resolves the model lazily (the provider role can
 *   change at any time via the admin panel); `model` is used when it is not
 *   supplied.
 */
function createEleosPass({
  model,
  getModel,
  store,
  now = () => new Date(),
  delayMinMs = MIN_DELAY_MS,
  delayMaxMs = MAX_DELAY_MS,
  detectSignals = detectEleosSignals,
} = {}) {
  function resolveModel() {
    try {
      return typeof getModel === 'function' ? getModel() : model;
    } catch (_) {
      return null;
    }
  }

  function modelReady() {
    const m = resolveModel();
    if (!m || typeof m.chat !== 'function') return false;
    if (typeof m.isConfigured === 'function') return m.isConfigured();
    return true;
  }

  /**
   * The pass runs after a completed turn. It gates on the turn's own words,
   * and only then — and only if the store and model are in place — asks the
   * model whether there is a loop. Best-effort throughout: every failure and
   * every "nothing here" resolves to a calm result and never throws.
   * @param {{ conversationId?: string, messages?: Array, logger?: Function }} turn
   * @returns {Promise<object>}
   */
  async function noteTurn({ conversationId, messages, logger } = {}) {
    if (!store) return { skipped: 'no-store' };
    if (!conversationId) return { skipped: 'no-conversation' };
    const window = (Array.isArray(messages) ? messages : [])
      .filter((m) => m && typeof m.content === 'string' && m.content.trim());
    if (window.length === 0) return { skipped: 'no-conversation' };

    // Gate: the person's own turn and Gaia's reply. Cheap and free — most
    // turns stop here and never reach the model.
    const turnText = window.slice(-2).map((m) => m.content).join('\n');
    const signals = detectSignals(turnText);
    if (!signals || !signals.any) return { skipped: 'no-signal' };

    if (!modelReady()) return { skipped: 'model-unconfigured' };

    const existing = typeof store.pendingForConversation === 'function'
      ? store.pendingForConversation(conversationId)
      : null;

    let raw;
    try {
      raw = await resolveModel().chat(buildEleosPrompt({ messages: window, existing }), {
        logger,
        responseFormat: { type: 'json_object' },
      });
    } catch (_) {
      return { skipped: 'model-failed' };
    }

    const decision = parseEleosDecision(raw);
    if (!decision) return { skipped: 'unparsed' };

    // A loop that is clearly resolved in the conversation is let go.
    if (decision.resolved && existing) {
      store.cancel(existing.id);
      return { cancelled: existing.id, kind: existing.kind };
    }
    if (!decision.followUp || !decision.summary) return { skipped: 'no-followup' };

    const dueAt = new Date(now().getTime() + clampDelay(decision.delayHours, { minMs: delayMinMs, maxMs: delayMaxMs })).toISOString();
    const fields = {
      kind: decision.kind,
      summary: decision.summary,
      groundingQuote: decision.groundingQuote,
      dueAt,
    };

    if (existing) {
      store.update(existing.id, fields);
      return { updated: existing.id, kind: fields.kind, dueAt };
    }
    const created = store.create({ conversationId, ...fields });
    return { created: created.id, kind: fields.kind, dueAt };
  }

  return { noteTurn };
}

module.exports = {
  createEleosPass,
  buildEleosPrompt,
  parseEleosDecision,
  clampDelay,
  ELEOS_KINDS,
  DEFAULT_DELAY_MS,
  MIN_DELAY_MS,
  MAX_DELAY_MS,
};
