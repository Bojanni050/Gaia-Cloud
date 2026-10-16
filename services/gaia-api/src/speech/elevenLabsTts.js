'use strict';

/**
 * Gaia's voice channel — text-to-speech via ElevenLabs
 * (`POST {baseUrl}/text-to-speech/{voice_id}`, which answers with the audio bytes).
 *
 * A presentation/output capability, the same posture as src/speech/mimoTts.js and
 * src/speech/mistralTts.js, of which this module is a sibling: it sits strictly *after*
 * the Gaia text response and is only ever called from server.js's `/speech` route.
 * It does not decide whether Gaia speaks, alter text, or touch Hermes, the native
 * generator, IntentIQ/ReasonIQ or the Response Engine.
 *
 * Request/response contract (ElevenLabs API reference, 2026-10):
 *
 *   POST {baseUrl}/text-to-speech/{voice_id}?output_format=mp3_44100_128
 *   xi-api-key: <key>
 *   { text, model_id }
 *
 *   -> binary audio (audio/mpeg for mp3_*)
 *
 * Unlike Mistral there is no default voice: ElevenLabs needs a voice id in the path, so an
 * unset GAIA_TTS_VOICE_ID / admin voice id is a configuration error, not a fallback.
 *
 * Streaming: ElevenLabs also has /stream; V1 only implements `synthesize()` (non-streaming),
 * the same boundary the sibling modules keep.
 */

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_BASE_URL = 'https://api.elevenlabs.io/v1';
const DEFAULT_OUTPUT_FORMAT = 'mp3_44100_128';
/** Gaia's chosen voice — used when no voice id is configured. */
const DEFAULT_VOICE_ID = 'kLhAstPcnnPxqzk6gS5i';

/**
 * Accepts either the API base (`.../v1`) or a full text-to-speech URL
 * (`.../v1/text-to-speech/<voice_id>`), returning the base and the voice id it carried, if any.
 */
function splitBaseUrl(raw) {
  const value = String(raw || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const match = value.match(/^(.*?)\/text-to-speech(?:\/([^/?#]+))?(?:[?#].*)?$/);
  return match
    ? { baseUrl: match[1], voiceId: match[2] ? decodeURIComponent(match[2]) : '' }
    : { baseUrl: value, voiceId: '' };
}

/**
 * Languages the multilingual / flash / turbo v2.5 models speak that Gaia cares about —
 * advertised via GET /speech/info so the desktop knows a non-English reply is worth speaking.
 * Dutch is what lifts the desktop's English-only speech gate.
 */
const LANGUAGES = ['en', 'nl', 'de', 'fr', 'es', 'pt', 'it', 'pl', 'sv', 'tr', 'hi', 'ar'];

/** Output formats with a playable container (raw pcm/ulaw/alaw are not). */
const AUDIO_MIME_TYPES = [
  [/^mp3_/, 'audio/mpeg'],
  [/^opus_/, 'audio/opus'],
  [/^wav_/, 'audio/wav'],
];

/** @param {string} format @returns {string} */
function mimeTypeFor(format) {
  const hit = AUDIO_MIME_TYPES.find(([pattern]) => pattern.test(format));
  return hit ? hit[1] : 'application/octet-stream';
}

/** @param {string} [format] @returns {string} a playable output format, mp3 otherwise */
function normalizeFormat(format) {
  return typeof format === 'string' && AUDIO_MIME_TYPES.some(([pattern]) => pattern.test(format))
    ? format
    : DEFAULT_OUTPUT_FORMAT;
}

/**
 * @param {{
 *   baseUrl?: string, model: string, authToken?: string, voiceId?: string,
 *   format?: string, fetchImpl?: Function, timeoutMs?: number,
 * }} options
 * @returns {{ synthesize: (text: string, options?: { voiceId?: string }) => Promise<{ audio: Buffer, mimeType: string }> }}
 */
function createElevenLabsTts(options = {}) {
  const { baseUrl, voiceId: urlVoiceId } = splitBaseUrl(options.baseUrl);
  const model = options.model || '';
  const authToken = options.authToken || '';
  const format = normalizeFormat(options.format);
  const defaultVoiceId = options.voiceId || urlVoiceId || DEFAULT_VOICE_ID;
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

  if (!model) {
    throw new Error('a model is required for speech synthesis');
  }

  const headers = { 'Content-Type': 'application/json', Accept: mimeTypeFor(format) };
  if (authToken) headers['xi-api-key'] = authToken;

  /**
   * Synthesizes speech for `text` — always an already-finalized Gaia reply.
   * @param {string} text
   * @param {{ voiceId?: string }} [callOptions]
   * @returns {Promise<{ audio: Buffer, mimeType: string }>}
   */
  async function synthesize(text, { voiceId } = {}) {
    const effectiveVoiceId = voiceId || defaultVoiceId;
    if (!effectiveVoiceId) {
      console.error('[gaia:tts] elevenlabs needs a voice id');
      throw new Error('speech synthesis needs a voice id');
    }

    const url = `${baseUrl}/text-to-speech/${encodeURIComponent(effectiveVoiceId)}?output_format=${encodeURIComponent(format)}`;
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ text, model_id: model }),
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

    let audio;
    try {
      audio = Buffer.from(await response.arrayBuffer());
    } catch (_) {
      console.error(`[gaia:tts] unreadable audio at ${baseUrl}`);
      throw new Error('speech synthesis returned unreadable audio');
    }
    if (audio.length === 0) {
      console.error(`[gaia:tts] empty audio from ${baseUrl}`);
      throw new Error('speech synthesis returned no audio');
    }

    return { audio, mimeType: mimeTypeFor(format) };
  }

  return { synthesize };
}

/**
 * Lists the voices on the ElevenLabs account (`GET {baseUrl}/voices`), for the admin
 * surface that lets an operator pick a voice id instead of typing one blind.
 * @param {{ baseUrl?: string, authToken?: string, fetchImpl?: Function, timeoutMs?: number }} options
 * @returns {Promise<Array<{ id: string, name: string }>>}
 */
async function listVoices(options = {}) {
  const { baseUrl } = splitBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const headers = {};
  if (options.authToken) headers['xi-api-key'] = options.authToken;

  let response;
  try {
    response = await fetchImpl(`${baseUrl}/voices`, { method: 'GET', headers, signal: AbortSignal.timeout(timeoutMs) });
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

  let data;
  try {
    data = await response.json();
  } catch (_) {
    throw new Error('voice listing returned an unreadable response');
  }

  const seen = new Set();
  const voices = [];
  for (const voice of data && Array.isArray(data.voices) ? data.voices : []) {
    if (!voice || typeof voice.voice_id !== 'string' || voice.voice_id === '' || seen.has(voice.voice_id)) continue;
    seen.add(voice.voice_id);
    voices.push({ id: voice.voice_id, name: typeof voice.name === 'string' && voice.name !== '' ? voice.name : voice.voice_id });
  }
  return voices;
}

/**
 * Lists the models that can do text-to-speech (`GET {baseUrl}/models`).
 * @param {{ baseUrl?: string, apiKey?: string, fetchImpl?: Function, timeoutMs?: number }} options
 * @returns {Promise<Array<{ id: string, name: string, capabilities: string[] }>>}
 */
async function listModels(options = {}) {
  const { baseUrl } = splitBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl || fetch;
  const headers = {};
  if (options.apiKey) headers['xi-api-key'] = options.apiKey;

  let response;
  try {
    response = await fetchImpl(`${baseUrl}/models`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(options.timeoutMs || DEFAULT_TIMEOUT_MS),
    });
  } catch (_) {
    throw new Error('elevenlabs unreachable');
  }
  if (response.status === 401 || response.status === 403) throw new Error('authentication failed');
  if (!response.ok) throw new Error(`elevenlabs responded ${response.status}`);

  const data = await response.json();
  return (Array.isArray(data) ? data : [])
    .filter((m) => m && typeof m.model_id === 'string' && m.can_do_text_to_speech !== false)
    .map((m) => ({ id: m.model_id, name: m.name || m.model_id, capabilities: ['tts'] }));
}

module.exports = {
  createElevenLabsTts,
  listVoices,
  listModels,
  normalizeFormat,
  mimeTypeFor,
  LANGUAGES,
  DEFAULT_BASE_URL,
  DEFAULT_VOICE_ID,
  splitBaseUrl,
};
