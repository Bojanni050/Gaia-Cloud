'use strict';

/**
 * Gaia's voice channel — text-to-speech via Mistral Voxtral
 * (e.g. voxtral-mini-tts-2603), a `POST {baseUrl}/audio/speech` endpoint
 * that returns synthesized audio as base64 JSON.
 *
 * This is a presentation/output capability, not a cognitive one — the same
 * posture as src/speech/mimoTts.js, of which this module is a sibling.
 * It sits strictly *after* the Gaia text response Response Engine already
 * produced — see server.js's `/speech` route, the only place this module
 * is ever called from:
 *
 *   direct generation -> Response Engine -> text
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
 *   - Call Hermes, the native generator, IntentIQ, or ReasonIQ.
 *   - Touch the Response Engine.
 * It has no import of and no reference to any of those — a boundary
 * asserted directly in test/mistralTts.test.js, not just described here.
 *
 * Request/response contract (confirmed against Mistral's current docs,
 * 2026-10 — https://docs.mistral.ai/api/endpoint/audio/speech):
 *
 *   POST {baseUrl}/audio/speech
 *   { model, input: <text to speak>, voice_id?, response_format }
 *
 *   -> { audio_data: <base64 audio> }
 *
 * Unlike MiMo's voicedesign variant there is no voice-design prompt here:
 * the voice is a saved `voice_id` (see GET /v1/audio/voices) or Mistral's
 * own default when none is configured. `voice_id` is therefore optional —
 * an unset GAIA_TTS_VOICE_ID still speaks, just not in Gaia's chosen
 * voice.
 *
 * Streaming: Mistral's SSE mode (`stream: true`) is implemented as
 * `stream()`: each `speech.audio.delta` event carries a base64 fragment of
 * raw float32 LE samples (`response_format: 'pcm'`), which this module
 * converts to the PCM16LE that the rest of Gaia speaks. That is also the
 * whole reason it exists — a long reply used to be one request that only
 * came back after a minute of silence, and the level of that one long clip
 * drifted; chunk by chunk it starts in under a second.
 */

const { sseData, parseStreamPayload } = require('./sse');

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_STREAM_TIMEOUT_MS = 120000;

/**
 * What `stream()` yields: PCM16LE at 24 kHz mono — the same shape MiMo's
 * stream produces and what server.js's `/speech/stream` headers already
 * announce (`X-Gaia-Sample-Rate`/`X-Gaia-Channels`), so the desktop needs no
 * special case for whichever voice is behind it.
 *
 * Mistral's `pcm` is raw *float32* LE at Voxtral's native 24 kHz mono (the
 * same rate as the WAV clips it returns), hence the conversion below.
 */
const STREAM_FORMAT = 'pcm16';
const STREAM_SAMPLE_RATE = 24000;
const STREAM_CHANNELS = 1;

/**
 * Mistral's default audio encoding for this client — compressed, suitable
 * for most playback, and the only format every `<audio>`/native-Audio
 * path on the desktop is guaranteed to sniff correctly even before the
 * mime-type propagation work. Overridable per deployment via
 * GAIA_TTS_FORMAT (shared with MiMo's client).
 */
const DEFAULT_FORMAT = 'mp3';

const VALID_FORMATS = new Set(['mp3', 'wav', 'pcm', 'flac', 'opus']);

/**
 * Languages Voxtral speaks (Mistral docs, 2026-10) — advertised to
 * clients via GET /speech/info so the desktop knows whether a
 * non-English reply is worth speaking. English is always present; Dutch
 * is what lifts the desktop's English-only speech gate.
 */
const LANGUAGES = ['en', 'fr', 'es', 'pt', 'it', 'nl', 'de', 'hi', 'ar'];

/**
 * @param {string} [format]
 * @returns {string} the format when Mistral supports it, mp3 otherwise —
 *   never passes an encoding Mistral would reject with a 4xx.
 */
function normalizeFormat(format) {
  return VALID_FORMATS.has(format) ? format : DEFAULT_FORMAT;
}

/**
 * Reads TTS configuration from environment variables. `format` falls back
 * per this module's own default (mp3), not MiMo's (wav): GAIA_TTS_FORMAT
 * is shared, but each client owns its default.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ baseUrl: string, model: string, authToken: string, format: string, voiceId: string }}
 */
function readTtsConfig(env = process.env) {
  return {
    baseUrl: env.GAIA_TTS_BASE_URL || '',
    model: env.GAIA_TTS_MODEL || '',
    authToken: env.GAIA_TTS_AUTH_TOKEN || '',
    format: normalizeFormat(env.GAIA_TTS_FORMAT),
    voiceId: env.GAIA_TTS_VOICE_ID || '',
  };
}

/**
 * @param {{ baseUrl: string, model: string }} config
 * @returns {boolean}
 */
function isConfigured(config) {
  return Boolean(config.baseUrl && config.model);
}

// `pcm` is deliberately unmapped: raw float32 LE samples, documented by
// Mistral as streaming-oriented — not playable as a blob. It falls back
// to application/octet-stream rather than a lie.
const AUDIO_MIME_TYPES = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  opus: 'audio/opus',
};

/** @param {string} format @returns {string} */
function mimeTypeFor(format) {
  return AUDIO_MIME_TYPES[format] || 'application/octet-stream';
}

/**
 * Creates Gaia's Mistral TTS client.
 *
 * @param {{
 *   baseUrl: string,
 *   model: string,
 *   authToken?: string,
 *   voiceId?: string,
 *   format?: string,
 *   fetchImpl?: Function,
 *   timeoutMs?: number,
 * }} options
 * @returns {{ synthesize: (text: string, options?: { voiceId?: string }) => Promise<{ audio: Buffer, mimeType: string }> }}
 */
function createMistralTts(options = {}) {
  const baseUrl = String(options.baseUrl || '').replace(/\/+$/, '');
  const model = options.model || '';
  const authToken = options.authToken || '';
  const format = normalizeFormat(options.format);
  const defaultVoiceId = options.voiceId || '';
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const streamTimeoutMs = options.streamTimeoutMs || DEFAULT_STREAM_TIMEOUT_MS;

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
   * this module has no say in what text reaches it. Mistral moderates TTS
   * input server-side: rejected text surfaces here as a generic error,
   * never the moderation verdict.
   * @param {string} text
   * @param {{ voiceId?: string }} [callOptions]
   * @returns {Promise<{ audio: Buffer, mimeType: string }>}
   */
  async function synthesize(text, { voiceId } = {}) {
    const body = {
      model,
      input: text,
      response_format: format,
    };
    const effectiveVoiceId = voiceId || defaultVoiceId;
    if (effectiveVoiceId) body.voice_id = effectiveVoiceId;

    let response;
    try {
      response = await fetchImpl(`${baseUrl}/audio/speech`, {
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

    const encoded = data && data.audio_data;
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

  /**
   * Opens the streaming POST and reduces every early failure to the same
   * calm error: unreachable, an error status, or a response with no body to
   * read. Everything past this point is already audio.
   */
  async function openStream(body, signal) {
    let response;
    try {
      response = await fetchImpl(`${baseUrl}/audio/speech`, {
        method: 'POST',
        headers: { ...headers, Accept: 'text/event-stream' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      // Aborted means the caller gave up (listener gone, or the whole-stream
      // ceiling) — not an outage on the provider's side.
      const gaveUp = Boolean(signal && signal.aborted);
      console.error(`[gaia:tts] ${gaveUp ? 'stream gave up' : 'unreachable'} at ${baseUrl}: ${error.message}`);
      throw new Error(gaveUp ? 'speech synthesis was cancelled' : 'speech synthesis unreachable');
    }
    if (!response.ok) {
      console.error(`[gaia:tts] responded ${response.status} at ${baseUrl}`);
      throw new Error('speech synthesis responded with an error');
    }
    if (!response.body) {
      console.error(`[gaia:tts] no response body to stream at ${baseUrl}`);
      throw new Error('speech synthesis returned no audio');
    }
    return response;
  }

  /**
   * Streams speech for `text`: an async generator of raw PCM16LE chunks at
   * 24 kHz mono (`STREAM_SAMPLE_RATE`/`STREAM_CHANNELS`) in the order they
   * arrive, so a caller can start speaking before the reply is finished.
   *
   * The same calm-error posture as `synthesize()`: every failure surfaces
   * as one generic message, with the provider, its URL and any key kept in
   * the operator log only. `signal` lets the caller hang the whole provider
   * request up (a client that stopped listening mid-reply).
   *
   * @param {string} text
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {AsyncGenerator<Buffer, void, void>}
   */
  async function* stream(text, { signal } = {}) {
    const body = {
      model,
      input: text,
      response_format: 'pcm',
      stream: true,
    };
    const effectiveVoiceId = defaultVoiceId;
    if (effectiveVoiceId) body.voice_id = effectiveVoiceId;

    // The caller's signal and the timeout cover the *whole* stream, not just
    // the request: a listener that goes away mid-reply must stop the
    // provider from synthesizing the rest of a sentence nobody will hear.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), streamTimeoutMs);
    const relay = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', relay, { once: true });
    }

    try {
      const response = await openStream(body, controller.signal);

      // Float32 fragments are cut wherever the provider cuts them, so a
      // sample may straddle two events; the converter carries the leftover
      // bytes into the next chunk instead of dropping half a sample.
      const pcm = createPcmFloat32ToS16();
      let yielded = false;
      try {
        for await (const payload of sseData(response.body)) {
          const event = parseStreamPayload(payload);
          if (!event) continue;
          if (event.type === 'speech.audio.done') break;
          if (event.error) {
            console.error(`[gaia:tts] stream error at ${baseUrl}: ${JSON.stringify(event.error).slice(0, 200)}`);
            throw new Error('speech synthesis responded with an error');
          }
          // The documented shape is a flat event ({ type, audio_data });
          // the SDK's streamed form nests it under `data`. Accept both —
          // the cost of being wrong either way is silence.
          const encoded = typeof event.audio_data === 'string'
            ? event.audio_data
            : event.data && typeof event.data.audio_data === 'string' ? event.data.audio_data : undefined;
          if (!encoded) continue;
          const chunk = pcm.push(Buffer.from(encoded, 'base64'));
          if (chunk.length === 0) continue;
          yielded = true;
          yield chunk;
        }
      } catch (error) {
        // A calm error already says why; anything else is the transport
        // breaking under a reply that may already be playing elsewhere.
        if (error && typeof error.message === 'string' && error.message.startsWith('speech synthesis')) throw error;
        console.error(`[gaia:tts] stream broke at ${baseUrl}: ${error && error.message}`);
        throw new Error(controller.signal.aborted ? 'speech synthesis was cancelled' : 'speech synthesis was interrupted');
      }

      if (!yielded) {
        console.error(`[gaia:tts] stream carried no audio at ${baseUrl}`);
        throw new Error('speech synthesis returned no audio');
      }
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', relay);
    }
  }

  return { synthesize, stream };
}

/**
 * Turns Mistral's raw float32 LE fragments into the PCM16LE the rest of Gaia
 * speaks. Stateful only for the bytes of a sample split across fragments;
 * out-of-range and non-finite samples are clamped rather than allowed to
 * wrap around into a click.
 *
 * @returns {{ push: (bytes: Buffer) => Buffer, flush: () => Buffer }}
 */
function createPcmFloat32ToS16() {
  let carry = Buffer.alloc(0);
  return {
    push(bytes) {
      const all = carry.length > 0 ? Buffer.concat([carry, bytes]) : bytes;
      const usable = all.length - (all.length % 4);
      carry = usable === all.length ? Buffer.alloc(0) : Buffer.from(all.subarray(usable));
      if (usable === 0) return Buffer.alloc(0);
      const out = Buffer.allocUnsafe((usable / 4) * 2);
      for (let source = 0, target = 0; source < usable; source += 4, target += 2) {
        const sample = all.readFloatLE(source);
        const clamped = Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0;
        out.writeInt16LE(Math.round(clamped * 32767), target);
      }
      return out;
    },
  };
}

/**
 * Lists the saved voices (preset + custom) on the Mistral account, for
 * admin surfaces that let an operator pick a `voice_id` instead of typing
 * one blind (see adminRoutes.js's GET /admin/api/tts/voices).
 *
 * The endpoint is paginated (10 per page by default) — this follows
 * pages until the reported total is reached, an empty page arrives, or
 * a short page arrives, so callers always get the whole library.
 *
 * @param {{
 *   baseUrl: string,
 *   authToken?: string,
 *   fetchImpl?: Function,
 *   timeoutMs?: number,
 * }} options
 * @returns {Promise<Array<{ id: string, name: string }>>}
 */
async function listVoices(options = {}) {
  const baseUrl = String(options.baseUrl || '').replace(/\/+$/, '');
  const authToken = options.authToken || '';
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

  if (!baseUrl) {
    throw new Error('GAIA_TTS_BASE_URL is required for speech synthesis');
  }

  const headers = {};
  if (authToken) headers.Authorization = `Bearer ${authToken}`;

  async function fetchPage(offset, limit) {
    let response;
    try {
      response = await fetchImpl(`${baseUrl}/audio/voices?limit=${limit}&offset=${offset}`, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      console.error(`[gaia:tts] unreachable at ${baseUrl}: ${error.message}`);
      throw new Error('voice listing unreachable');
    }

    if (!response.ok) {
      console.error(`[gaia:tts] responded ${response.status} at ${baseUrl}`);
      const error = new Error('voice listing responded with an error');
      error.status = response.status;
      throw error;
    }

    try {
      return await response.json();
    } catch (_) {
      console.error(`[gaia:tts] unreadable response at ${baseUrl}`);
      throw new Error('voice listing returned an unreadable response');
    }
  }

  const voices = [];
  const seen = new Set();
  const limit = 100;
  let offset = 0;
  // Bounded: a misbehaving pager (total that never arrives) stops after
  // 10 pages / ~1000 voices rather than looping forever.
  for (let page = 0; page < 10; page++) {
    const data = await fetchPage(offset, limit);
    const items = data && Array.isArray(data.items) ? data.items : [];
    if (items.length === 0) break;
    for (const voice of items) {
      if (!voice || typeof voice.id !== 'string' || voice.id === '' || seen.has(voice.id)) continue;
      seen.add(voice.id);
      voices.push({ id: voice.id, name: typeof voice.name === 'string' && voice.name !== '' ? voice.name : voice.id });
    }
    offset += items.length;
    const total = data && typeof data.total === 'number' ? data.total : null;
    // The reported total leads: some servers page smaller than the
    // requested limit, so a short page alone must not stop the walk when
    // the total says there is more. Without a total, a short page is the
    // only end-of-list signal there is.
    if (total !== null) {
      if (voices.length >= total) break;
    } else if (items.length < limit) {
      break;
    }
  }
  return voices;
}

/**
 * Composes readTtsConfig + isConfigured + createMistralTts, mirroring
 * mimoTts.js's createFromEnv — the one call server.js needs. Returns
 * `undefined` when GAIA_TTS_BASE_URL/GAIA_TTS_MODEL are unset, so callers
 * can treat "no TTS available" the same uniform way as an omitted
 * `nativeGenerator`/`tools` entry elsewhere in this codebase.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ synthesize: Function }|undefined}
 */
function createFromEnv(env = process.env) {
  const config = readTtsConfig(env);
  return isConfigured(config) ? createMistralTts(config) : undefined;
}

module.exports = {
  createMistralTts,
  listVoices,
  readTtsConfig,
  isConfigured,
  createFromEnv,
  normalizeFormat,
  mimeTypeFor,
  LANGUAGES,
  STREAM_FORMAT,
  STREAM_SAMPLE_RATE,
  STREAM_CHANNELS,
};
