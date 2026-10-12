'use strict';

/**
 * Gaia's listening channel — speech-to-text via Mistral Voxtral
 * (e.g. voxtral-mini-latest), a `POST {baseUrl}/audio/transcriptions`
 * multipart endpoint. The same request shape is spoken by OpenAI-compatible
 * transcription endpoints, so any provider that does can be pointed at this
 * client by base URL.
 *
 * This is an *input transport*, not a cognitive capability — the mirror
 * image of src/speech/mistralTts.js. It turns one finished utterance of
 * audio into text and hands that text back to the caller; what the text
 * means, whether Gaia answers it, and everything about identity, memory and
 * reasoning stays exactly where it was. The transcript re-enters the system
 * as an ordinary user turn through the client (Desktop), never from here:
 *
 *   microphone -> Desktop (local VAD, wake word) -> utterance
 *                                                      |
 *                                                      v
 *                                  POST /speech/transcribe -> this module
 *                                                      |
 *                                                      v
 *                                                    text  -> client sends it as a normal turn
 *
 * What this module does NOT do (and must never be asked to do):
 *   - Decide whether Gaia should answer, or respond to the text in any way.
 *   - Store audio or transcripts. Audio lives in memory for the length of
 *     one request; nothing here writes it anywhere.
 *   - Call Hermes, the native generator, IntentIQ, or ReasonIQ.
 *   - Touch the Response Engine.
 * It has no import of and no reference to any of those — a boundary
 * asserted directly in test/mistralStt.test.js, not just described here.
 *
 * Request/response contract (verified against the live endpoint in Phase 0
 * of the background-voice work, 2026-10; Dutch auto-detected without a hint):
 *
 *   POST {baseUrl}/audio/transcriptions   (multipart/form-data)
 *   fields: model, file, language? (ISO-639-1)
 *
 *   -> { text, language?, ... }
 */

const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Languages Voxtral transcribes with a hint (same set it speaks) — advertised
 * to clients via GET /speech/stt-info. Auto-detection also works without one.
 */
const LANGUAGES = ['en', 'fr', 'es', 'pt', 'it', 'nl', 'de', 'hi', 'ar'];

/** Largest utterance accepted, in bytes (about 30 s of 16 kHz mono 16-bit PCM). */
const MAX_AUDIO_BYTES = 1024 * 1024;

const FILE_EXTENSIONS = {
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/webm': 'webm',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
};

/**
 * @param {string|undefined} header a Content-Type header value
 * @returns {string} the bare audio mime type, `audio/wav` when it is missing or not audio
 */
function audioMimeType(header) {
  const bare = String(header || '').split(';')[0].trim().toLowerCase();
  return bare.startsWith('audio/') ? bare : 'audio/wav';
}

/**
 * @param {string|undefined} value a requested language hint
 * @returns {string|undefined} a lowercase 2 or 3 letter ISO code, or undefined when absent or malformed
 */
function normalizeLanguage(value) {
  const code = String(value || '').trim().toLowerCase();
  return /^[a-z]{2,3}$/.test(code) ? code : undefined;
}

/**
 * @param {{ baseUrl: string, model: string }} config
 * @returns {boolean}
 */
function isConfigured(config) {
  return Boolean(config && config.baseUrl && config.model);
}

/**
 * Creates Gaia's transcription client.
 *
 * @param {{
 *   baseUrl: string,
 *   model: string,
 *   authToken?: string,
 *   fetchImpl?: Function,
 *   timeoutMs?: number,
 * }} options
 * @returns {{ transcribe: (audio: Buffer, options?: { mimeType?: string, language?: string }) => Promise<{ text: string, language: string|null }> }}
 */
function createMistralStt(options = {}) {
  const baseUrl = String(options.baseUrl || '').replace(/\/+$/, '');
  const model = options.model || '';
  const authToken = options.authToken || '';
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

  if (!baseUrl) {
    throw new Error('GAIA_STT_BASE_URL is required for speech recognition');
  }
  if (!model) {
    throw new Error('GAIA_STT_MODEL is required for speech recognition');
  }

  const headers = {};
  if (authToken) headers.Authorization = `Bearer ${authToken}`;

  /**
   * Transcribes one utterance. Failures are calm and generic: the provider's
   * words, endpoint and key never travel past this function.
   * @param {Buffer} audio
   * @param {{ mimeType?: string, language?: string }} [callOptions]
   * @returns {Promise<{ text: string, language: string|null }>}
   */
  async function transcribe(audio, { mimeType, language } = {}) {
    const type = audioMimeType(mimeType);
    const form = new FormData();
    form.append('model', model);
    const hint = normalizeLanguage(language);
    if (hint) form.append('language', hint);
    form.append('file', new Blob([audio], { type }), `utterance.${FILE_EXTENSIONS[type] || 'wav'}`);

    let response;
    try {
      response = await fetchImpl(`${baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers, // no Content-Type: fetch sets the multipart boundary itself
        body: form,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      console.error(`[gaia:stt] unreachable at ${baseUrl}: ${error.message}`);
      throw new Error('speech recognition unreachable');
    }

    if (!response.ok) {
      console.error(`[gaia:stt] responded ${response.status} at ${baseUrl}`);
      throw new Error('speech recognition responded with an error');
    }

    let data;
    try {
      data = await response.json();
    } catch (_) {
      console.error(`[gaia:stt] unreadable response at ${baseUrl}`);
      throw new Error('speech recognition returned an unreadable response');
    }

    if (!data || typeof data.text !== 'string') {
      console.error(`[gaia:stt] no text field in response at ${baseUrl}`);
      throw new Error('speech recognition returned no text');
    }
    // Empty text is a valid answer (silence or noise), not an error.
    return {
      text: data.text.trim(),
      language: typeof data.language === 'string' && data.language ? data.language : null,
    };
  }

  return { transcribe };
}

module.exports = {
  createMistralStt,
  isConfigured,
  audioMimeType,
  normalizeLanguage,
  LANGUAGES,
  MAX_AUDIO_BYTES,
  DEFAULT_TIMEOUT_MS,
};
