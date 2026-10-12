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

  async function chat(messages, { timeoutMs: callTimeoutMs = timeoutMs } = {}) {
    // Diagnostic logging (temporary)
    const imageBlockPresent = messages.some((m) => 
      Array.isArray(m.content) && m.content.some((c) => c.type === 'image_url')
    );
    console.log(JSON.stringify({
      kind: 'vision.trace',
      stage: 'llm_client',
      messageCount: messages.length,
      messageRoles: messages.map((m) => m.role),
      contentTypesPerMessage: messages.map((m) => 
        Array.isArray(m.content) ? m.content.map((c) => c.type) : ['text']
      ),
      imageBlockPresent,
    }));

    let response;
    try {
      response = await fetchImpl(`${root}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, stream: false, messages }),
        signal: AbortSignal.timeout(callTimeoutMs),
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

  /**
   * Submits an agent run without waiting for it — the async primitive the
   * research pipeline is built on. `input` is a plain string (the same
   * skill-naming prompt chat() would carry), never the reply. Resolves with
   * the run id so the caller can poll later.
   *
   * @param {{ input: string, instructions?: string, sessionId?: string, idempotencyKey?: string }} request
   * @returns {Promise<{ runId: string|null, status: string|null }>}
   */
  async function submitRun({ input, instructions, sessionId, idempotencyKey } = {}) {
    const body = { input: String(input || '') };
    if (instructions) body.instructions = String(instructions);
    if (sessionId) body.session_id = String(sessionId);
    const requestHeaders = { ...headers };
    if (idempotencyKey) requestHeaders['Idempotency-Key'] = String(idempotencyKey).slice(0, 255);

    let response;
    try {
      response = await fetchImpl(`${root}/runs`, {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify(body),
      });
    } catch (error) {
      console.error(`[hermes] run submit unreachable at ${root}: ${error.message}`);
      throw new Error('hermes unreachable');
    }
    if (!response.ok) {
      console.error(`[hermes] run submit responded ${response.status} at ${root}`);
      throw new Error('hermes rejected the run');
    }
    const data = await response.json().catch(() => null);
    return { runId: (data && data.run_id) || null, status: (data && data.status) || null };
  }

  /**
   * Reads one submitted run's state. `output` is the run's text once it
   * completed; a run that failed or was cancelled carries the terminal
   * status instead.
   *
   * @param {string} runId
   * @returns {Promise<{ status: string|null, output: string|null, error: string|null, raw: object|null }>}
   */
  async function getRun(runId) {
    let response;
    try {
      response = await fetchImpl(`${root}/runs/${encodeURIComponent(runId)}`, { headers });
    } catch (error) {
      console.error(`[hermes] run status unreachable at ${root}: ${error.message}`);
      throw new Error('hermes unreachable');
    }
    if (!response.ok) {
      console.error(`[hermes] run status responded ${response.status} at ${root}`);
      throw new Error('hermes run unreadable');
    }
    const data = await response.json().catch(() => null);
    if (!data) return { status: null, output: null, error: null, approval: null, raw: null };
    return {
      status: data.status || null,
      output: typeof data.output === 'string' ? data.output : null,
      error: data.error || null,
      // Present while the run is parked on a human decision: the flagged
      // command (already redacted by Hermes) plus the choices a caller may
      // send back through answerApproval().
      approval: data.approval || null,
      raw: data,
    };
  }

  /**
   * Answers a run's pending approval — the human decision, forwarded. This is
   * the ONE place Gaia can grant a Hermes run permission to run a command it
   * flagged, so it is deliberately a plain forward: the decision is the
   * caller's (ultimately a person's), never this module's.
   *
   * @param {string} runId
   * @param {{ choice: string, requestId?: string }} decision choice is one of
   *   the run's own `choices` ('once' | 'session' | 'always' | 'deny')
   * @returns {Promise<{ ok: boolean, status: number, error: string|null }>}
   */
  async function answerApproval(runId, { choice, requestId } = {}) {
    const body = { choice: String(choice || '').trim().toLowerCase() };
    if (requestId) body.request_id = String(requestId);
    let response;
    try {
      response = await fetchImpl(`${root}/runs/${encodeURIComponent(runId)}/approval`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    } catch (error) {
      console.error(`[hermes] approval unreachable at ${root}: ${error.message}`);
      throw new Error('hermes unreachable');
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.error(`[hermes] approval responded ${response.status} at ${root}: ${text.slice(0, 200)}`);
      return { ok: false, status: response.status, error: text.slice(0, 200) || 'hermes rejected the decision' };
    }
    return { ok: true, status: response.status, error: null };
  }

  return { chat, stream, submitRun, getRun, answerApproval };
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
