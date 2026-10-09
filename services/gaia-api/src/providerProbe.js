'use strict';

/**
 * Connectivity probe for a role's resolved model — the admin "Test connection"
 * button. Sends one minimal chat completion and reports whether the provider
 * answered, how long it took, and (on failure) a short reason.
 *
 * Deliberately never throws: a failed probe is a value the caller shows, not a
 * crash. The API key is used but never returned.
 *
 * @param {{ baseUrl: string, model: string, apiKey?: string, timeoutMs?: number }} options
 * @returns {Promise<{ ok: boolean, latencyMs: number, status?: number, sample?: string, error?: string }>}
 */
async function probeChatCompletion({ baseUrl, model, apiKey, timeoutMs = 15000 } = {}) {
  const started = Date.now();
  const url = String(baseUrl || '').replace(/\/+$/, '') + '/chat/completions';
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      // A tiny, deterministic request: enough to prove the model answers,
      // cheap enough to run on every card without thinking about cost.
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 8,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latencyMs = Date.now() - started;
    const text = await response.text();
    if (!response.ok) {
      let detail = '';
      try {
        const j = JSON.parse(text);
        detail = j && j.error ? (j.error.message || String(j.error)) : '';
      } catch (_) {
        detail = String(text).slice(0, 200);
      }
      return { ok: false, latencyMs, status: response.status, error: `HTTP ${response.status}${detail ? ' — ' + detail : ''}` };
    }
    let sample = '';
    try {
      const j = JSON.parse(text);
      sample = (j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
    } catch (_) { /* a non-JSON 200 still counts as reachable */ }
    return { ok: true, latencyMs, sample: String(sample).slice(0, 80) };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: timedOut ? `timed out after ${Math.round(timeoutMs / 1000)}s` : ((err && err.message) || 'request failed'),
    };
  }
}

module.exports = { probeChatCompletion };
