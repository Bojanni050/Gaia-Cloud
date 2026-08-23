'use strict';

/**
 * Gaia's voice channel — text-to-speech via Xiaomi's MiMo TTS
 * (mimo-v2.5-tts-voicedesign), an OpenAI-compatible `/chat/completions`
 * endpoint that returns synthesized audio instead of text.
 *
 * This is a presentation/output capability, not a cognitive one. It sits
 * strictly *after* the Gaia text response Response Engine already produced
 * — see server.js's `/speech` route, the only place this module is ever
 * called from:
 *
 *   Decision Engine -> native/capability/tool -> Response Engine -> text
 *                                                                     |
 *                                                                     v
 *                                                                   TTS
 *                                                                     |
 *                                                                     v
 *                                                                   audio
 *
 * What this module does NOT do (and must never be asked to do):
 *   - Decide whether/when Gaia should speak.
 *   - Generate or alter response text.
 *   - Call Hermes, the native generator, IntentIQ, ReasonIQ, or the
 *     Decision Engine/Orchestrator.
 *   - Touch the Response Engine.
 * It has no import of and no reference to any of those — a boundary
 * asserted directly in test/mimoTts.test.js, not just described here.
 *
 * Request/response contract (confirmed against Xiaomi's current docs,
 * 2026-08 — https://mimo.mi.com/docs/en-US/quick-start/usage-guide/audio/speech-synthesis-v2.5):
 *
 *   POST {baseUrl}/chat/completions
 *   { model, messages: [
 *       { role: 'user', content: <voice description> },
 *       { role: 'assistant', content: <text to speak> },
 *     ], audio: { format: 'wav' } }
 *
 *   -> { choices: [{ message: { audio: { data: <base64 audio> } } }] }
 *
 * The `user` message is *not* spoken — it is mimo-v2.5-tts-voicedesign's
 * voice-design prompt (a textual description of the voice to generate, a
 * required parameter for this particular model variant). The `assistant`
 * message is the only text actually synthesized. Mixing these up would
 * make Gaia narrate her own voice description instead of her answer.
 *
 * Streaming: mimo-v2.5-tts-voicedesign's streaming mode is currently
 * documented as "downgraded to compatibility mode" (returns the full
 * result once, after inference completes) — no real latency win over
 * non-streaming today. V1 therefore only implements `synthesize()`
 * (non-streaming). The interface is still shaped so a `stream(text,
 * options)` sibling — for mimo-v2.5-tts's plain (non-voicedesign) variant,
 * which does support real low-latency streaming — can be added later
 * without redesigning this module or its caller, the same way
 * hermesClient.js/gaiaGenerator.js each expose both `chat`/`generate` and
 * `stream` behind one client shape.
 */

const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Gaia's default voice — calm, intelligent, warm but restrained. Not an
 * impersonation of any existing voice; only these qualities are used as a
 * textual description, per mimo-v2.5-tts-voicedesign's voice-design
 * contract (a prompt, not a preset/sample selection).
 */
const DEFAULT_VOICE_DESCRIPTION = [
  'Calm, intelligent adult female voice with a warm and naturally engaging presence.',
  'Clear, relaxed and confident, with a gentle sense of liveliness.',
  'Medium pitch, natural conversational pacing and expressive but restrained intonation.',
  'She sounds attentive, curious and genuinely present.',
  'A subtle smile can occasionally be heard in the voice.',
  'Warmth and empathy should feel natural rather than sentimental.',
  'Use light, natural breaths and brief pauses between thoughts.',
  'Avoid sounding dramatic, solemn, melancholic or overly serious.',
  'The overall impression is calm, intelligent, approachable and quietly alive.',
].join(' ');

/**
 * Reads TTS configuration from environment variables.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ baseUrl: string, model: string, authToken: string, format: string, voiceDescription: string }}
 */
function readTtsConfig(env = process.env) {
  return {
    baseUrl: env.GAIA_TTS_BASE_URL || '',
    model: env.GAIA_TTS_MODEL || '',
    authToken: env.GAIA_TTS_AUTH_TOKEN || '',
    format: env.GAIA_TTS_FORMAT || 'wav',
    voiceDescription: env.GAIA_TTS_VOICE_DESCRIPTION || DEFAULT_VOICE_DESCRIPTION,
  };
}

/**
 * @param {{ baseUrl: string, model: string }} config
 * @returns {boolean}
 */
function isConfigured(config) {
  return Boolean(config.baseUrl && config.model);
}

const AUDIO_MIME_TYPES = { wav: 'audio/wav', pcm16: 'audio/L16' };

/** @param {string} format @returns {string} */
function mimeTypeFor(format) {
  return AUDIO_MIME_TYPES[format] || 'application/octet-stream';
}

/**
 * Creates Gaia's TTS client.
 *
 * @param {{
 *   baseUrl: string,
 *   model: string,
 *   authToken?: string,
 *   format?: string,
 *   voiceDescription?: string,
 *   fetchImpl?: Function,
 *   timeoutMs?: number,
 * }} options
 * @returns {{ synthesize: (text: string, options?: { voiceDescription?: string }) => Promise<{ audio: Buffer, mimeType: string }> }}
 */
function createMimoTts(options = {}) {
  const baseUrl = String(options.baseUrl || '').replace(/\/+$/, '');
  const model = options.model || '';
  const authToken = options.authToken || '';
  const format = options.format || 'wav';
  const defaultVoiceDescription = options.voiceDescription || DEFAULT_VOICE_DESCRIPTION;
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

  if (!baseUrl) {
    throw new Error('GAIA_TTS_BASE_URL is required for speech synthesis');
  }
  if (!model) {
    throw new Error('GAIA_TTS_MODEL is required for speech synthesis');
  }

  const headers = { 'Content-Type': 'application/json' };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;

  /**
   * Synthesizes speech for `text`. Never called with anything other than
   * an already-finalized Gaia reply (see server.js's `/speech` route) —
   * this module has no say in what text reaches it.
   * @param {string} text
   * @param {{ voiceDescription?: string }} [callOptions]
   * @returns {Promise<{ audio: Buffer, mimeType: string }>}
   */
  async function synthesize(text, { voiceDescription } = {}) {
    const body = {
      model,
      messages: [
        { role: 'user', content: voiceDescription || defaultVoiceDescription },
        { role: 'assistant', content: text },
      ],
      audio: { format },
    };

    let response;
    try {
      response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      console.error(`[gaia:tts] unreachable at ${baseUrl}: ${error.message}`);
      throw new Error('speech synthesis unreachable');
    }

    if (!response.ok) {
      console.error(`[gaia:tts] responded ${response.status} at ${baseUrl}`);
      throw new Error('speech synthesis responded with an error');
    }

    let data;
    try {
      data = await response.json();
    } catch (_) {
      console.error(`[gaia:tts] unreadable response at ${baseUrl}`);
      throw new Error('speech synthesis returned an unreadable response');
    }

    const encoded = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.audio
      ? data.choices[0].message.audio.data
      : undefined;
    if (typeof encoded !== 'string' || encoded.length === 0) {
      console.error(`[gaia:tts] no audio in response at ${baseUrl}: ${JSON.stringify(data).slice(0, 200)}`);
      throw new Error('speech synthesis returned no audio');
    }

    let audio;
    try {
      audio = Buffer.from(encoded, 'base64');
    } catch (_) {
      console.error(`[gaia:tts] unreadable audio encoding at ${baseUrl}`);
      throw new Error('speech synthesis returned unreadable audio');
    }
    if (audio.length === 0) {
      console.error(`[gaia:tts] decoded to empty audio at ${baseUrl}`);
      throw new Error('speech synthesis returned no audio');
    }

    return { audio, mimeType: mimeTypeFor(format) };
  }

  return { synthesize };
}

/**
 * Composes readTtsConfig + isConfigured + createMimoTts, mirroring
 * gaiaGenerator.js's createFromEnv — the one call server.js needs. Returns
 * `undefined` when GAIA_TTS_BASE_URL/GAIA_TTS_MODEL are unset, so callers
 * can treat "no TTS available" the same uniform way as an omitted
 * `nativeGenerator`/`tools` entry elsewhere in this codebase.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ synthesize: Function }|undefined}
 */
function createFromEnv(env = process.env) {
  const config = readTtsConfig(env);
  return isConfigured(config) ? createMimoTts(config) : undefined;
}

module.exports = {
  createMimoTts,
  readTtsConfig,
  isConfigured,
  createFromEnv,
  mimeTypeFor,
  DEFAULT_VOICE_DESCRIPTION,
};
