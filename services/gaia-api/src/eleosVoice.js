'use strict';

/**
 * Eleos's voice — the one generation step that produces the opening message
 * of a proactive check-in.
 *
 * This is Gaia SPEAKING, so it uses her own generation role and the same
 * constitution-first system prompt every turn uses (foundation.buildSystemPrompt
 * → SOUL/principles/lexicon). Eleos the faculty decides WHEN and WHAT MOMENT;
 * this module only gives her the grounded material and lets her voice do the
 * rest. It is pure prompt-building + a single injected generate() call, so the
 * runtime can pass whichever generator the turn path would use.
 *
 * Grounding is the whole point: the opening may only rest on the loop's own
 * summary and quote. She is not told to be warm generically — she is given the
 * real moment and asked to open a conversation about it. If there is nothing
 * grounded, there is nothing to open.
 */

const { buildSystemPrompt } = require('./foundation');

/**
 * @param {{ documents: Record<string,string>, loop: object, recentMessages?: Array }} input
 * @returns {Array<{role: string, content: string}>}
 */
function buildOpeningMessages({ documents, loop, recentMessages } = {}) {
  const systemPrompt = buildSystemPrompt(documents, []);
  const summary = (loop && loop.summary ? String(loop.summary) : '').trim();
  const quote = (loop && loop.groundingQuote ? String(loop.groundingQuote) : '').trim();

  const recent = (Array.isArray(recentMessages) ? recentMessages : [])
    .filter((m) => m && typeof m.content === 'string' && m.content.trim())
    .slice(-6)
    .map(({ role, content }) => `${role === 'assistant' ? 'Gaia' : (role === 'user' ? 'Bo' : role)}: ${content}`)
    .join('\n');

  const lines = [
    'This is a quiet moment, not a reply to anything. Some time has passed since the conversation below, and you are now the one starting a new conversation — the person is not here yet and has not said anything.',
    '',
    `The moment you noted, in your own words: ${summary}`,
  ];
  if (quote) lines.push(`What they actually said at the time: "${quote}"`);
  if (recent) {
    lines.push('', 'For context, the tail of that conversation was:', '', recent);
  }
  lines.push(
    '',
    'Open the conversation now, in a single short message, in your own voice: come back to how they are doing, from that real moment only. Do not mention notes, memories, or that you were keeping track of anything. Do not explain why you are writing. Do not invent anything they did not say. Just the one message.'
  );

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: lines.join('\n') },
  ];
}

/**
 * @param {{ generate: (messages: Array, options?: object) => Promise<string>, documents: Record<string,string> }} options
 */
function createEleosVoice({ generate, documents } = {}) {
  /**
   * @param {{ loop: object, recentMessages?: Array }} input
   * @returns {Promise<string>} the opening message, or '' when nothing usable
   */
  async function open({ loop, recentMessages } = {}) {
    if (typeof generate !== 'function') return '';
    if (!loop || !loop.summary) return '';
    const messages = buildOpeningMessages({ documents, loop, recentMessages });
    try {
      const text = await generate(messages);
      return typeof text === 'string' ? text.trim() : '';
    } catch (_) {
      return '';
    }
  }

  return { open };
}

module.exports = { createEleosVoice, buildOpeningMessages };
