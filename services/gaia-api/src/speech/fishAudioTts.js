'use strict';

/**
 * Gaia's voice channel — text-to-speech via Fish Audio
 * (`POST https://api.fish.audio/v1/tts`, which answers with the audio bytes).
 *
 * A presentation/output capability, the same posture as src/speech/elevenLabsTts.js,
 * mimoTts.js and mistralTts.js: it sits strictly *after* the Gaia text response and is only
 * called from server.js's `/speech` route. It does not decide whether Gaia speaks, alter
 * text, or touch Hermes, the native generator, IntentIQ/ReasonIQ or the Response Engine.
 *
 * Request/response contract (Fish Audio API reference, 2026-10):
 *
 *   POST {origin}/v1/tts
 *   Authorization: Bearer <key>     model: <s2.1-pro | s2.1-pro-free | s2-pro | s1>
 *   { text, reference_id?, format }
 *
 *   -> binary audio
 *
 * `model` is a request header, not a body field. `reference_id` is the voice (see
 * GET {origin}/model); without one Fish Audio uses its default voice, so a voice id is optional.
 *
 * The base URL may be given as the origin, `.../v1` or the full `.../v1/tts` endpoint; all
 * resolve to the same origin. V1 only implements `synthesize()` (non-streaming).
 */

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_ORIGIN = 'https://api.fish.audio';
const DEFAULT_FORMAT = 'mp3';
const VALID_FORMATS = new Set(['mp3', 'wav', 'opus']);

/** TTS models selectable through the `model` header (no list endpoint exists for these). */
const MODELS = [
  { id: 's2.1-pro', name: 'S2.1 Pro' },
  { id: 's2.1-pro-free', name: 'S2.1 Pro (free tier)' },
  { id: 's2-pro', name: 'S2 Pro' },
  { id: 's1', name: 'S1' },
];

/** Languages worth advertising to the desktop — Dutch is what lifts its English-only gate. */
const LANGUAGES = ['en', 'nl', 'de', 'fr', 'es', 'pt', 'it', 'pl', 'ja', 'ko', 'zh', 'ar'];

const MIME_TYPES = { mp3: 'audio/mpeg', wav: 'audio/wav', opus: 'audio/opus' };

/** @param {string} format @returns {string} */
function normalizeFormat(format) {
  return VALID_FORMATS.has(format) ? format : DEFAULT_FORMAT;
}

/** @param {string} format @returns {string} */
function mimeTypeFor(format) {
  return MIME_TYPES[format] || 'application/octet-stream';
}

/**
 * Reduces any of `https://api.fish.audio`, `.../v1` or `.../v1/tts` to the origin.
 * @param {string} [raw]
 * @returns {string}
 */
function originOf(raw) {
  const value = String(raw || DEFAULT_ORIGIN).trim().replace(/\/+$/, '');
  return value.replace(/\/v1(\/tts)?$/, '').replace(/\/tts$/, '') || DEFAULT_ORIGIN;
}

/**
 * @param {{
 *   baseUrl?: string, model: string, authToken?: string, voiceId?: string,
 *   format?: string, fetchImpl?: Function, timeoutMs?: number,
 * }} options
 * @returns {{ synthesize: (text: string, options?: { voiceId?: string }) => Promise<{ audio: Buffer, mimeType: string }> }}
 */
function createFishAudioTts(options = {}) {
  const origin = originOf(options.baseUrl);
  const model = options.model || '';
  const authToken = options.authToken || '';
  const format = normalizeFormat(options.format);
  const defaultVoiceId = options.voiceId || '';
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

  if (!model) {
    throw new Error('a model is required for speech synthesis');
  }

  const headers = { 'Content-Type': 'application/json', model };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;

  /**
   * Synthesizes speech for `text` — always an already-finalized Gaia reply.
   * @param {string} text
   * @param {{ voiceId?: string }} [callOptions]
   * @returns {Promise<{ audio: Buffer, mimeType: string }>}
   */
  async function synthesize(text, { voiceId } = {}) {
    const body = { text, format };
    const effectiveVoiceId = voiceId || defaultVoiceId;
    if (effectiveVoiceId) body.reference_id = effectiveVoiceId;

    let response;
    try {
      response = await fetchImpl(`${origin}/v1/tts`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      console.error(`[gaia:tts] unreachable at ${origin}: ${error.message}`);
      throw new Error('speech synthesis unreachable');
    }

    if (!response.ok) {
      console.error(`[gaia:tts] responded ${response.status} at ${origin}`);
      throw new Error('speech synthesis responded with an error');
    }

    let audio;
    try {
      audio = Buffer.from(await response.arrayBuffer());
    } catch (_) {
      console.error(`[gaia:tts] unreadable audio at ${origin}`);
      throw new Error('speech synthesis returned unreadable audio');
    }
    if (audio.length === 0) {
      console.error(`[gaia:tts] empty audio from ${origin}`);
      throw new Error('speech synthesis returned no audio');
    }

    return { audio, mimeType: mimeTypeFor(format) };
  }

  return { synthesize };
}

/**
 * Lists the voices in the account's own library (`GET {origin}/model?self=true`), for the
 * admin surface that lets an operator pick a voice id instead of typing one blind.
 * The public voice library is deliberately not listed — it holds far too many to pick from.
 * @param {{ baseUrl?: string, authToken?: string, fetchImpl?: Function, timeoutMs?: number }} options
 * @returns {Promise<Array<{ id: string, name: string }>>}
 */
async function listVoices(options = {}) {
  const origin = originOf(options.baseUrl);
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const headers = {};
  if (options.authToken) headers.Authorization = `Bearer ${options.authToken}`;

  const voices = [];
  const seen = new Set();
  const pageSize = 100;
  let fetched = 0;
  // Bounded: a pager that never says "no more" stops after 10 pages.
  for (let page = 1; page <= 10; page++) {
    let response;
    try {
      response = await fetchImpl(`${origin}/model?self=true&page_size=${pageSize}&page_number=${page}`, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      console.error(`[gaia:tts] unreachable at ${origin}: ${error.message}`);
      throw new Error('voice listing unreachable');
    }
    if (!response.ok) {
      console.error(`[gaia:tts] responded ${response.status} at ${origin}`);
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

    const items = data && Array.isArray(data.items) ? data.items : [];
    for (const voice of items) {
      if (!voice || typeof voice._id !== 'string' || voice._id === '' || seen.has(voice._id)) continue;
      seen.add(voice._id);
      voices.push({ id: voice._id, name: typeof voice.title === 'string' && voice.title !== '' ? voice.title : voice._id });
    }
    fetched += items.length;
    const total = data && typeof data.total === 'number' ? data.total : null;
    // Items received (not unique voices) are compared with the reported total.
    if (items.length === 0 || (total !== null ? fetched >= total : items.length < pageSize)) break;
    if (data && data.has_more === false) break;
  }
  return voices;
}

/**
 * The selectable TTS models, shaped like the other providers' model discovery.
 * @returns {Array<{ id: string, name: string, capabilities: string[] }>}
 */
function listModels() {
  return MODELS.map((m) => ({ id: m.id, name: m.name, capabilities: ['tts'] }));
}

module.exports = {
  createFishAudioTts,
  listVoices,
  listModels,
  normalizeFormat,
  mimeTypeFor,
  originOf,
  LANGUAGES,
  MODELS,
  DEFAULT_ORIGIN,
};
