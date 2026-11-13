'use strict';

/**
 * The little bit of Server-Sent Events every streaming TTS provider needs:
 * pull the `data:` payloads out of a response body, and read each payload's
 * JSON. Providers differ only in where inside that JSON the audio sits — the
 * framing is the same, so it lives here once instead of in each client.
 *
 * Kept deliberately forgiving: a keep-alive comment, a blank line, an event
 * name line or a half-written tail is framing, not audio, and must never
 * break a reply that is already being spoken.
 */

/**
 * Reads server-sent events out of a response body (a web `ReadableStream`,
 * or anything else async-iterable over byte/string chunks) and yields each
 * `data:` payload. A final line without a trailing newline still counts.
 *
 * @param {AsyncIterable<Uint8Array|string>} body
 * @returns {AsyncGenerator<string, void, void>}
 */
async function* sseData(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const part of body) {
    buffer += typeof part === 'string' ? part : decoder.decode(part, { stream: true });
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (line.startsWith('data:')) yield line.slice(5).trim();
    }
  }
  const tail = buffer.replace(/\r$/, '').trim();
  if (tail.startsWith('data:')) yield tail.slice(5).trim();
}

/**
 * One streamed chunk's JSON. `[DONE]` (OpenAI's end marker) and anything
 * that will not parse — a provider's keep-alive or a half-written line —
 * are not audio and yield nothing rather than breaking the reply.
 * @param {string} payload
 * @returns {object|null}
 */
function parseStreamPayload(payload) {
  if (!payload || payload === '[DONE]') return null;
  try {
    const event = JSON.parse(payload);
    return event && typeof event === 'object' ? event : null;
  } catch (_) {
    return null;
  }
}

module.exports = { sseData, parseStreamPayload };
