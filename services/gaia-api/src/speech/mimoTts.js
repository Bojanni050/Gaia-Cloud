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
 * The `user` message is *not* spoken — for mimo-v2.5-tts-voicedesign it is
 * the voice-design prompt (a textual description of the voice to generate,
 * a required parameter for this particular model variant). The `assistant`
 * message is the only text actually synthesized. Mixing these up would
 * make Gaia narrate her own voice description instead of her answer. With
 * a built-in voice (`audio.voice`) there is no designed voice to describe,
 * so that `user` message is dropped entirely.
 *
 * Two ways to give Gaia a voice, both on this same endpoint:
 *
 *   - **Voice design** (model `mimo-v2.5-tts-voicedesign`, the original
 *     path): the voice *is* the `user` message, a written description. No
 *     `audio.voice` is sent — this variant has no built-in voices and
 *     rejects one.
 *   - **Built-in voice** (model `mimo-v2.5-tts`): a named voice from
 *     Xiaomi's own library via `audio.voice` (`BUILT_IN_VOICES`), no
 *     description needed. This is what makes real streaming possible, and
 *     with a built-in voice the `user` message becomes optional style
 *     guidance rather than the voice itself — this module sends none, so
 *     the voice stays exactly the one that was chosen. A saved/configured
 *     voice id is what selects this mode (see `createMimoTts`'s `voice`).
 *
 * Streaming: only `mimo-v2.5-tts` streams in real time. The voicedesign and
 * voiceclone variants are documented as "downgraded to compatibility mode"
 * (one full result, after inference completes), so `stream()` on those is
 * still correct but buys no latency. `stream(text)` is therefore a sibling
 * of `synthesize(text)`, not a replacement: the same client offers both,
 * the same way hermesClient.js/gaiaGenerator.js each expose `chat`/
 * `generate` and `stream` behind one shape.
 *
 *   POST {baseUrl}/chat/completions   { ..., stream: true }
 *   -> text/event-stream, each `data:` line a JSON chunk of
 *      { choices: [{ delta: { audio: { data: <base64 PCM16LE> } } }] }
 *
 * Streaming is PCM16 at 24 kHz mono (Xiaomi's contract, and the only format
 * the docs say can be spliced into a whole clip) — `stream()`'s options
 * format is therefore not configurable, unlike `synthesize()`'s.
 */

const DEFAULT_TIMEOUT_MS = 30000;
/**
 * A streaming reply keeps one request open for as long as Gaia speaks, so
 * the whole-request ceiling is looser than the non-streaming one — it is a
 * cap, not an idle timeout (one long reply is a normal thing).
 */
const DEFAULT_STREAM_TIMEOUT_MS = 120000;

/** Fixed by Xiaomi's streaming contract — PCM16LE, mono, 24 kHz. */
const STREAM_FORMAT = 'pcm16';
const STREAM_SAMPLE_RATE = 24000;
const STREAM_CHANNELS = 1;

/**
 * Languages mimo-v2.5-tts-voicedesign pronounces (Xiaomi's docs, 2026-08)
 * — advertised to clients via GET /speech/info so the desktop knows a
 * Dutch reply would come back mispronounced rather than rejected.
 */
const LANGUAGES = ['zh', 'en'];

/**
 * Xiaomi's own voice library (mimo-v2.5-tts only, Xiaomi's docs 2026-10).
 * `mimo_default` is whatever the deployed cluster calls its default (冰糖 on
 * the China cluster, Mia elsewhere), so it is offered with both languages a
 * built-in voice can be.
 */
const BUILT_IN_VOICES = [
  { id: 'mimo_default', name: 'MiMo default', languages: ['zh', 'en'] },
  { id: '冰糖', name: 'Bingtang', languages: ['zh'] },
  { id: '茉莉', name: 'Moli', languages: ['zh'] },
  { id: '苏打', name: 'Soda', languages: ['zh'] },
  { id: '白桦', name: 'Birch', languages: ['zh'] },
  { id: 'Mia', name: 'Mia', languages: ['en'] },
  { id: 'Chloe', name: 'Chloe', languages: ['en'] },
  { id: 'Milo', name: 'Milo', languages: ['en'] },
  { id: 'Dean', name: 'Dean', languages: ['en'] },
];

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
 * @returns {{ baseUrl: string, model: string, authToken: string, format: string, voiceDescription: string, voiceId: string }}
 */
function readTtsConfig(env = process.env) {
  return {
    baseUrl: env.GAIA_TTS_BASE_URL || '',
    model: env.GAIA_TTS_MODEL || '',
    authToken: env.GAIA_TTS_AUTH_TOKEN || '',
    format: env.GAIA_TTS_FORMAT || 'wav',
    voiceDescription: env.GAIA_TTS_VOICE_DESCRIPTION || DEFAULT_VOICE_DESCRIPTION,
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

const AUDIO_MIME_TYPES = { wav: 'audio/wav', pcm16: 'audio/L16' };

/** @param {string} format @returns {string} */
function mimeTypeFor(format) {
  return AUDIO_MIME_TYPES[format] || 'application/octet-stream';
}

/**
 * Creates Gaia's TTS client.
 *
 * `voiceId` is a built-in voice id from {@link BUILT_IN_VOICES} (or any id
 * Xiaomi adds). Setting it means "speak with this named voice", which
 * switches the request away from voice design (see this file's header). It
 * is the same field every other TTS provider's stored config uses, so a
 * resolved provider config can be handed straight to this function; the
 * client hands it back out as `voice`.
 *
 * @param {{
 *   baseUrl: string,
 *   model: string,
 *   authToken?: string,
 *   format?: string,
 *   voiceId?: string,
 *   voice?: string,
 *   voiceDescription?: string,
 *   fetchImpl?: Function,
 *   timeoutMs?: number,
 *   streamTimeoutMs?: number,
 * }} options
 * @returns {{
 *   synthesize: (text: string, options?: { voiceDescription?: string }) => Promise<{ audio: Buffer, mimeType: string }>,
 *   stream: (text: string, options?: { signal?: AbortSignal }) => AsyncGenerator<Buffer, void, void>,
 *   voice: string,
 * }}
 */
function createMimoTts(options = {}) {
  const baseUrl = String(options.baseUrl || '').replace(/\/+$/, '');
  const model = options.model || '';
  const authToken = options.authToken || '';
  const format = options.format || 'wav';
  const voice = options.voiceId || options.voice || '';
  const defaultVoiceDescription = options.voiceDescription || DEFAULT_VOICE_DESCRIPTION;
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
   * The `audio` field: `voice` rides along only when one is configured —
   * an empty `audio.voice` is not the same request as no `audio.voice` at
   * all (the voicedesign variant would reject it), so it is never sent
   * empty.
   */
  function audioSettings(streaming) {
    const settings = { format: streaming ? STREAM_FORMAT : format };
    if (voice) settings.voice = voice;
    return settings;
  }

  /**
   * The `messages` array. Without a built-in voice, the `user` message *is*
   * the voice; with one, there is nothing to describe, so only the text to
   * speak is sent.
   */
  function messagesFor(text, voiceDescription) {
    if (voice) return [{ role: 'assistant', content: text }];
    return [
      { role: 'user', content: voiceDescription || defaultVoiceDescription },
      { role: 'assistant', content: text },
    ];
  }

  /**
   * Opens the streaming POST and reduces every early failure to the same
   * calm error: unreachable, an error status, or a response with no body to
   * read. Everything past this point is already audio.
   */
  async function openStream(body, signal) {
    let response;
    try {
      response = await fetchImpl(`${baseUrl}/chat/completions`, {
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
      messages: messagesFor(text, voiceDescription),
      audio: audioSettings(false),
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

  /**
   * Streams speech for `text`: an async generator of raw PCM16LE chunks at
   * 24 kHz mono (`STREAM_SAMPLE_RATE`/`STREAM_CHANNELS`) in the order they
   * arrive, so a caller can start speaking before the reply is finished.
   *
   * The same calm-error posture as `synthesize()`: every failure surfaces
   * as one generic message, with the provider, its URL and any key kept in
   * the operator log only. An error thrown *after* the first chunk cannot
   * take back what was already yielded — the caller decides what to do with
   * a reply that stopped mid-sentence.
   *
   * `signal` lets the caller hang the whole provider request up (a client
   * that stopped listening mid-reply); it is combined with the timeout, so
   * either one ends the stream instead of it being read to the end for
   * nobody.
   *
   * @param {string} text
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {AsyncGenerator<Buffer, void, void>}
   */
  async function* stream(text, { signal } = {}) {
    const body = {
      model,
      messages: messagesFor(text),
      audio: audioSettings(true),
      stream: true,
    };

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

      let yielded = false;
      try {
        for await (const payload of sseData(response.body)) {
          const event = parseStreamPayload(payload);
          if (!event) continue;
          if (event.error) {
            console.error(`[gaia:tts] stream error at ${baseUrl}: ${JSON.stringify(event.error).slice(0, 200)}`);
            throw new Error('speech synthesis responded with an error');
          }
          const encoded = event.choices && event.choices[0] && event.choices[0].delta && event.choices[0].delta.audio
            ? event.choices[0].delta.audio.data
            : undefined;
          if (typeof encoded !== 'string' || encoded.length === 0) continue;
          const chunk = Buffer.from(encoded, 'base64');
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

  return { synthesize, stream, voice };
}

/**
 * Reads server-sent events out of a response body (a web `ReadableStream`,
 * or anything else async-iterable over byte/string chunks) and yields each
 * `data:` payload. Everything else — blank keep-alive lines, comments,
 * other event fields — is framing, not audio, and is skipped. A final line
 * without a trailing newline still counts.
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
  LANGUAGES,
  BUILT_IN_VOICES,
  STREAM_FORMAT,
  STREAM_SAMPLE_RATE,
  STREAM_CHANNELS,
};
