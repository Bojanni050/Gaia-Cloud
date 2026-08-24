'use strict';

/**
 * Hermes client — the only place the Gaia API touches a reasoning provider.
 *
 * Talks to an OpenAI-compatible `/chat/completions` endpoint. Provider
 * choice, model name and auth stay here; nothing about them is returned to
 * callers. Both `chat()` (non-streaming, Desktop's contract, unchanged)
 * and `stream()` (SSE, added for docs/web-migration-plan.md's Phase B)
 * live behind this same client shape.
 */
function createHermesClient({ baseUrl, model, authToken, fetchImpl = fetch, timeoutMs = 120000 }) {
  const root = String(baseUrl || '').replace(/\/+$/, '');
  if (!root) {
    throw new Error('HERMES_BASE_URL is required');
  }

  const headers = { 'Content-Type': 'application/json' };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;

  async function chat(messages) {
    let response;
    try {
      response = await fetchImpl(`${root}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, stream: false, messages }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // Server-side diagnostic only; the client still gets a calm error.
      console.error(`[hermes] unreachable at ${root}: ${error.message}`);
      throw new Error('hermes unreachable');
    }
    if (!response.ok) {
      console.error(`[hermes] responded ${response.status} at ${root}`);
      throw new Error(`hermes responded with an error`);
    }

    let data;
    try {
      data = await response.json();
    } catch (_) {
      console.error(`[hermes] unreadable response at ${root}`);
      throw new Error('hermes returned an unreadable response');
    }
    const content = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : undefined;
    if (typeof content !== 'string' || content.length === 0) {
      console.error(`[hermes] no content in response at ${root}: ${JSON.stringify(data).slice(0, 200)}`);
      throw new Error('hermes returned no content');
    }
    return content;
  }

  /**
   * Streams a reply, calling `onDelta(content, isReasoning)` per token as
   * it arrives and resolving with the full accumulated text once the
   * stream ends. Frame shape matches the OpenAI-compatible SSE format
   * gaia-web's HermesProvider._readSse already parses (data:
   * {"choices":[{"delta":{"content"|"reasoning_content":...}}]}, ended by
   * "data: [DONE]") — deliberately, so a future client cutover to this
   * endpoint changes only the URL, not the parsing.
   *
   * PATCH: Native Vision Support
   * messages[].content can be either:
   *   - string: plain text message
   *   - Array: multimodal content blocks [{ type: "text", text: "..." }, { type: "image_url", ... }]
   * JSON.stringify correctly serializes both formats.
   *
   * @param {Array<{role: string, content: string|Array}>} messages
   * @param {{ signal?: AbortSignal, onDelta?: (chunk: string, isReasoning?: boolean) => void }} [options]
   * @returns {Promise<string>}
   */
  async function stream(messages, { signal, onDelta } = {}) {
    let response;
    try {
      response = await fetchImpl(`${root}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, stream: true, messages }),
        signal,
      });
    } catch (error) {
      console.error(`[hermes] stream unreachable at ${root}: ${error.message}`);
      throw new Error('hermes unreachable');
    }
    if (!response.ok || !response.body) {
      console.error(`[hermes] stream responded ${response.status} at ${root}`);
      throw new Error('hermes responded with an error');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = buffer.replace(/\r\n/g, '\n');

        let sep;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const delta = parseSseFrame(frame);
          if (!delta) continue;
          if (delta.content) {
            fullText += delta.content;
            if (onDelta) onDelta(delta.content, false);
          }
          if (delta.reasoning) {
            if (onDelta) onDelta(delta.reasoning, true);
          }
        }
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      console.error(`[hermes] stream read failed at ${root}: ${error.message}`);
      throw new Error('hermes stream failed');
    }

    if (fullText.length === 0) {
      console.error(`[hermes] stream produced no content at ${root}`);
      throw new Error('hermes returned no content');
    }
    return fullText;
  }

  return { chat, stream };
}

function parseSseFrame(frame) {
  const lines = frame.split('\n');
  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return null;
    try {
      const obj = JSON.parse(payload);
      const delta = obj?.choices?.[0]?.delta;
      if (delta) {
        return {
          content: delta.content || '',
          reasoning: delta.reasoning_content || '',
        };
      }
    } catch (_) { /* malformed frame, skip */ }
  }
  return null;
}

module.exports = { createHermesClient };
