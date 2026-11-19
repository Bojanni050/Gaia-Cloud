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
 *
 * UPDATE 2026-11-19: everything below describes what the split does while
 * `GAIA_TTS_SEGMENT` is on. It is off by default now — a single unsegmented
 * request of 65 s measured −0.3 dB (voxtral-mini-tts-2603) and −1.0 dB
 * (voxtral-mini-tts-3-0) from the first to the last 4 s window, so the
 * provider no longer fades. With it off, `stream()` is one request and
 * `synthesize()` is one clip in the configured format, always.
 *
 * Streaming alone did not cure the drift: the same 36 s reply measured
 * −6.8 dB from start to end as a stream, against −16.6 dB as one clip.
 * `stream()` therefore asks for one *paragraph* at a time (see
 * `splitForSynthesis`), because a fresh request starts at full level again.
 * A first attempt cut the text per two sentences; the level was flat but the
 * reply hiccupped and its sentences ran into each other, because every seam
 * is a place where the voice starts over and where no pause was ever put.
 * Paragraphs are the boundaries a speaker pauses at anyway, so a reply of a
 * paragraph or two — nearly all of them — is still one request, and where two
 * requests do meet, a short silence stands in for the breath.
 *
 * Measured against the provider directly (one request per text): 1.9 s of
 * audio drifts 0 dB, 8 s and 16 s show no downward trend at all. The fade is
 * a property of long requests only (36 s and up), which is where the split
 * earns its keep.
 *
 * Two consequences of that split, both here rather than in a client:
 *
 *   - `synthesize()` (POST /speech, one complete clip) used to send a whole
 *     reply as one request — the −16.6 dB path, untouched by the split. A
 *     reply that needs more than one segment is now spoken segment by segment
 *     and returned as one WAV; a reply of one segment is still one mp3, byte
 *     for byte as before.
 *   - What is left of the drift is a *difference between* segments, so each
 *     segment after the first is brought back to the level the reply's own
 *     opening measured (`matchSegmentGain`, one constant gain, ±12 dB, on by
 *     default and switchable with GAIA_TTS_LEVEL_MATCH). The first segment is
 *     never touched: it must start speaking before it has finished arriving,
 *     and it is the reference the rest is matched to.
 */

const { sseData, parseStreamPayload } = require('./sse');
const { flag } = require('../flags');

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
 *   levelMatch?: boolean,
 *   segment?: boolean,
 *   env?: Record<string, string|undefined>,
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
  // Per-segment level matching (see `matchSegmentGain`): a switch, not a
  // constant, because it changes what is heard and a deployment may want the
  // provider's own dynamics back without a code change.
  const levelMatch = options.levelMatch !== undefined
    ? Boolean(options.levelMatch)
    : flag(options.env || process.env, 'GAIA_TTS_LEVEL_MATCH', { default: true });
  // Segmentation itself (see `splitForSynthesis`): a switch too, and off by
  // default. It exists because one long Mistral request used to lose level as
  // it went (−16.6 dB over 36 s, measured 2026-11-16); on 2026-11-19 the same
  // kind of request measured −0.3 dB (2603) and −1.0 dB (3-0) over 65 s, so
  // the split no longer earns its seams. It stays rather than goes: if the
  // provider's drift ever comes back, `GAIA_TTS_SEGMENT=on` is the whole fix.
  // Level matching only has something to do while this is on.
  const segment = options.segment !== undefined
    ? Boolean(options.segment)
    : flag(options.env || process.env, 'GAIA_TTS_SEGMENT', { default: false });

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
   * an already-finalized Gaia reply (see server.js's `/speech` route) — this
   * module has no say in what text reaches it. Mistral moderates TTS input
   * server-side: rejected text surfaces here as a generic error, never the
   * moderation verdict.
   *
   * A reply that fits in one segment (nearly all of them) is one request for
   * one mp3 clip, exactly as before. A longer one is spoken the way the
   * streaming route speaks it — a request per segment, each starting at full
   * level, because a single long request is where the level sinks (−16.6 dB
   * over 36 s, measured) — and comes back as one WAV (`audio/wav`), since PCM
   * is the only thing that concatenates without a seam or an encoder's
   * padding. That is the one visible difference: a long reply on this route
   * is a WAV, a short one is still an mp3.
   *
   * @param {string} text
   * @param {{ voiceId?: string }} [callOptions]
   * @returns {Promise<{ audio: Buffer, mimeType: string }>}
   */
  async function synthesize(text, { voiceId } = {}) {
    if (segment && splitForSynthesis(text).length > 1) {
      const chunks = [];
      for await (const chunk of stream(text, { voiceId })) chunks.push(chunk);
      return { audio: wrapPcm16Wav(chunks), mimeType: mimeTypeFor('wav') };
    }

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
   * One provider request for one segment, yielded as it arrives. No ceiling
   * of its own: the caller owns the signal that covers the whole reply.
   */
  async function* streamSegment(segment, signal, voiceId) {
    const body = {
      model,
      input: segment,
      response_format: 'pcm',
      stream: true,
    };
    const effectiveVoiceId = voiceId || defaultVoiceId;
    if (effectiveVoiceId) body.voice_id = effectiveVoiceId;

    const response = await openStream(body, signal);

    // Float32 fragments are cut wherever the provider cuts them, so a
    // sample may straddle two events; the converter carries the leftover
    // bytes into the next chunk instead of dropping half a sample.
    const pcm = createPcmFloat32ToS16();
    // What came back, for the operator log when nothing audible did. A
    // segment that returns 200 with no audio used to be indistinguishable
    // from an empty one: the log said "no audio" and not what the provider
    // had actually sent, which is exactly the question you cannot answer
    // from outside. The client still sees nothing but the calm wording.
    let events = 0;
    let audioEvents = 0;
    let firstSilentType = null;
    try {
      for await (const payload of sseData(response.body)) {
        const event = parseStreamPayload(payload);
        if (!event) continue;
        events += 1;
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
        if (!encoded) {
          if (firstSilentType === null) firstSilentType = typeof event.type === 'string' ? event.type.slice(0, 40) : 'untyped';
          continue;
        }
        const chunk = pcm.push(Buffer.from(encoded, 'base64'));
        if (chunk.length === 0) continue;
        audioEvents += 1;
        yield chunk;
      }
      if (audioEvents === 0) {
        console.error(`[gaia:tts] segment carried no audio at ${baseUrl}: ${events} event(s), first silent type ${firstSilentType || 'none'}`);
      }
    } catch (error) {
      // A calm error already says why; anything else is the transport
      // breaking under a reply that may already be playing elsewhere.
      if (error && typeof error.message === 'string' && error.message.startsWith('speech synthesis')) throw error;
      console.error(`[gaia:tts] stream broke at ${baseUrl}: ${error && error.message}`);
      throw new Error(signal && signal.aborted ? 'speech synthesis was cancelled' : 'speech synthesis was interrupted');
    }
  }

  /**
   * Streams speech for `text`: an async generator of raw PCM16LE chunks at
   * 24 kHz mono (`STREAM_SAMPLE_RATE`/`STREAM_CHANNELS`) in the order they
   * arrive, so a caller can start speaking before the reply is finished.
   *
   * `text` is spoken in segments rather than as one provider request: within
   * a single long synthesis the voice loses level as it goes — measured
   * against the live account at −16.6 dB over a 36 s clip, and still −6.8 dB
   * when that same clip is streamed. Each shorter request starts at full
   * level again.
   *
   * A segment is a paragraph, because that is where a reader pauses anyway;
   * nearly every reply is one request (see `splitForSynthesis`). Where two
   * requests do meet, the provider's own padding at either end is trimmed
   * back to a sliver and one deliberate pause stands in for the breath, so
   * the seam sounds like a paragraph break and not like a gap. The next
   * request is started while the current one is still playing — waiting for
   * it to finish cost a whole provider round trip (1.4 s) of nothing.
   *
   * What the split cannot remove is a level difference *between* segments, so
   * each segment after the first is scaled by one constant gain back to the
   * level the first one measured (`matchSegmentGain`, `GAIA_TTS_LEVEL_MATCH`).
   * The first segment is never touched — it is both the reference and the one
   * that must start speaking before it has fully arrived — and a later segment
   * is measured whole before it is spoken, which costs nothing because it was
   * already being fetched while the previous one played.
   *
   * The same calm-error posture as `synthesize()`: every failure surfaces
   * as one generic message, with the provider, its URL and any key kept in
   * the operator log only. `signal` lets the caller hang the whole provider
   * request up (a client that stopped listening mid-reply).
   *
   * @param {string} text
   * @param {{ signal?: AbortSignal, voiceId?: string }} [options]
   * @returns {AsyncGenerator<Buffer, void, void>}
   */
  async function* stream(text, { signal, voiceId } = {}) {
    // The caller's signal and the timeout cover the *whole* reply, not just
    // one request: a listener that goes away mid-reply must stop the
    // provider from synthesizing the sentences nobody will hear.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), streamTimeoutMs);
    const relay = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', relay, { once: true });
    }

    try {
      let yielded = false;
      // With segmentation off the whole reply is one segment: one provider
      // request, and the paths below that only exist for a second segment
      // (the pause, the prefetch, the level match) never run.
      const segments = segment ? splitForSynthesis(text) : (String(text ?? '').trim() ? [text] : []);
      const start = (index) => (index < segments.length
        ? bufferSegment(streamSegment(segments[index], controller.signal, voiceId))
        : null);
      let current = start(0);
      let next = start(1);
      // The reply's own opening sets the level everything after it is brought
      // back to (see `matchSegmentGain`); null means there is nothing to match
      // against — too little speech to measure, or a single segment.
      let referenceRms = null;
      for (let index = 0; index < segments.length; index += 1) {
        // A paragraph break is a pause the speaker takes; two requests back to
        // back would put her next word on the last syllable of the one before.
        if (index > 0) yield segmentGap();
        const trimmer = createPcmTrimmer();
        const meter = createPcmMeter();
        if (index === 0 || !levelMatch || referenceRms === null) {
          // Streamed as it arrives: the first segment must start speaking
          // before the provider has finished it, and every later one has
          // nothing to be matched against.
          for await (const chunk of current) {
            const trimmed = trimmer.push(chunk);
            if (trimmed.length === 0) continue;
            meter.push(trimmed);
            yielded = true;
            yield trimmed;
          }
          const tail = trimmer.flush();
          if (tail.length > 0) {
            meter.push(tail);
            yielded = true;
            yield tail;
          }
        } else {
          // A whole segment is a few hundred kB and is already being fetched
          // ahead, so measuring all of it before speaking it costs no provider
          // round trip: it stays silent until the segment before it has
          // finished playing, which is its turn anyway. One constant gain over
          // the whole segment — never a per-chunk one, which would pump.
          const spoken = [];
          for await (const chunk of current) {
            const trimmed = trimmer.push(chunk);
            if (trimmed.length > 0) spoken.push(trimmed);
          }
          const tail = trimmer.flush();
          if (tail.length > 0) spoken.push(tail);
          for (const piece of spoken) meter.push(piece);
          const gain = matchSegmentGain(referenceRms, meter);
          // Joined only now, because the fade has to land on the very last
          // samples of the segment, wherever the chunk boundaries happened to be.
          const matched = fadeOutPcm(applyPcmGain(Buffer.concat(spoken), gain));
          if (matched.length > 0) {
            yielded = true;
            yield matched;
          }
        }
        if (index === 0 && meter.isMeasurable()) referenceRms = meter.rms();
        current = next;
        next = start(index + 2);
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
 * The longest text one provider request may speak: a long paragraph, roughly
 * twelve seconds of audio. Anything longer is cut, because one long request is
 * exactly where the level sinks; anything shorter is left whole, because every
 * extra request is a seam.
 */
const SEGMENT_MAX_CHARS = 600;

/**
 * Silence where two requests meet, in milliseconds. A single synthesis put a
 * breath at a paragraph break; two requests back to back do not, so this is
 * that breath. With the trimmed slivers at either side (see `createPcmTrimmer`)
 * a seam comes out at roughly the 0.8 s a reader takes between paragraphs —
 * measured on a live reply, an internal pause at a sentence end was 0.9 s.
 */
const SEGMENT_GAP_MS = 600;

/** The silence above, as PCM16LE mono — two bytes a sample. */
function segmentGap() {
  return Buffer.alloc(Math.round((STREAM_SAMPLE_RATE * SEGMENT_GAP_MS) / 1000) * 2);
}

/**
 * What counts as silence in a segment: |sample| below this (of 32768) is
 * padding, not speech. −60 dBFS, quieter than a breath and far below a word.
 */
const SILENCE_FLOOR = 64;

/**
 * How much of the provider's own leading and trailing silence a segment keeps,
 * in ms. It pads both ends of every request (measured: about 0.8 s at each
 * side), so concatenating two of them produced a two-second hole at the seam.
 */
const LEAD_KEEP_MS = 60;
const TAIL_KEEP_MS = 150;

/**
 * Trims a segment's padding without touching what is inside it: a pause in the
 * middle of a segment is the speaker's, and is passed on in full. Only the
 * silence before the first word and after the last one is cut back to a
 * sliver, so that the deliberate gap between two requests is the only pause at
 * a seam.
 *
 * Stateful across chunks; `flush()` ends one segment.
 *
 * @returns {{ push: (bytes: Buffer) => Buffer, flush: () => Buffer }}
 */
function createPcmTrimmer() {
  const leadKeep = Math.round((STREAM_SAMPLE_RATE * LEAD_KEEP_MS) / 1000);
  const tailKeep = Math.round((STREAM_SAMPLE_RATE * TAIL_KEEP_MS) / 1000);
  let started = false;
  let held = []; // quiet samples since the last loud one, as int16 values

  const render = (samples) => {
    const out = Buffer.allocUnsafe(samples.length * 2);
    for (let i = 0; i < samples.length; i += 1) out.writeInt16LE(samples[i], i * 2);
    return out;
  };

  return {
    push(bytes) {
      const out = [];
      const count = Math.floor(bytes.length / 2);
      for (let index = 0; index < count; index += 1) {
        const sample = bytes.readInt16LE(index * 2);
        const quiet = Math.abs(sample) < SILENCE_FLOOR;
        if (!started) {
          if (quiet) {
            // Keep a sliver in front of the first word, drop the rest.
            held.push(sample);
            if (held.length > leadKeep) held.shift();
            continue;
          }
          started = true;
          out.push(...held, sample);
          held = [];
          continue;
        }
        if (quiet) {
          held.push(sample);
          continue;
        }
        // Speech again: a pause inside the segment, kept as it was.
        out.push(...held, sample);
        held = [];
      }
      return render(out);
    },
    flush() {
      const keep = held.length > tailKeep ? held.slice(held.length - tailKeep) : held;
      const tail = started ? render(keep) : Buffer.alloc(0);
      started = false;
      held = [];
      return tail;
    },
  };
}

/**
 * Measures how loud a segment actually *speaks*: RMS over the samples above
 * `SILENCE_FLOOR`, normalised to −1..1. Padding and breaths are therefore not
 * part of the measurement, and a long pause at the end of a paragraph cannot
 * make a loud segment look quiet.
 *
 * Stateful across chunks; `rms()` may be asked at any point.
 *
 * @returns {{ push: (bytes: Buffer) => void, rms: () => number|null, isMeasurable: () => boolean }}
 */
function createPcmMeter() {
  let sumSquares = 0;
  let count = 0;
  let peak = 0;
  return {
    push(bytes) {
      const samples = Math.floor(bytes.length / 2);
      for (let index = 0; index < samples; index += 1) {
        const magnitude = Math.abs(bytes.readInt16LE(index * 2));
        if (magnitude < SILENCE_FLOOR) continue;
        sumSquares += magnitude * magnitude;
        count += 1;
        if (magnitude > peak) peak = magnitude;
      }
    },
    rms() {
      return count > 0 ? Math.sqrt(sumSquares / count) / 32768 : null;
    },
    /** The loudest sample seen, normalised to 0..1 (0 when nothing was spoken). */
    peak() {
      return peak / 32768;
    },
    isMeasurable() {
      return count >= LEVEL_MIN_SPEECH_SAMPLES;
    },
  };
}

/**
 * The least speech a segment must carry before its level means anything:
 * 100 ms. Below it the measurement is noise, and the segment is passed through
 * untouched rather than guessed at — which is also what keeps a tiny fixture
 * sounding like the fixture.
 */
const LEVEL_MIN_SPEECH_SAMPLES = Math.round(STREAM_SAMPLE_RATE * 0.1);

/**
 * How far matching may move a segment, either way. A seam that needs more than
 * 12 dB is not a level problem any more; pushing further only amplifies the
 * provider's noise floor instead of making the reply right.
 */
const LEVEL_GAIN_CEILING_DB = 12;
const LEVEL_GAIN_FLOOR_DB = -12;

/**
 * The one constant gain that brings a segment back to `referenceRms` — the
 * level the reply's own opening measured — clamped to ±12 dB. Returns 1 (no
 * change) whenever either side is unmeasurable: that is what lets a single
 * segment, a silent one, or a deployment with `GAIA_TTS_LEVEL_MATCH=off` come
 * out exactly as the provider sent it.
 *
 * One gain for a whole segment, never one per chunk: a per-chunk gain would
 * chase every syllable and pump, which is worse than the drift it cures.
 *
 * @param {number|null} referenceRms
 * @param {{ isMeasurable: () => boolean, rms: () => number|null }} meter
 * @returns {number} a linear gain
 */
function matchSegmentGain(referenceRms, meter) {
  if (!(referenceRms > 0) || !meter.isMeasurable()) return 1;
  const measured = meter.rms();
  if (!(measured > 0)) return 1;
  const ceiling = 10 ** (LEVEL_GAIN_CEILING_DB / 20);
  const floor = 10 ** (LEVEL_GAIN_FLOOR_DB / 20);
  const wanted = Math.min(ceiling, Math.max(floor, referenceRms / measured));
  // A boost is held back by the segment's own loudest sample: a short closing
  // sentence has a low RMS but can still carry one loud syllable, and lifting
  // that past full scale clips it into a click. Only ever a limit on a boost —
  // a cut is never turned into a lift, and never below 1 on account of a peak.
  if (wanted > 1) {
    const peak = typeof meter.peak === 'function' ? meter.peak() : 0;
    if (peak > 0) return Math.min(wanted, Math.max(1, LEVEL_PEAK_CEILING / peak));
  }
  return wanted;
}

/**
 * The loudest a matched sample may become, as a fraction of full scale:
 * about −0.4 dBFS, so a boost lands just under the rail instead of on it.
 */
const LEVEL_PEAK_CEILING = 0.95;

/**
 * How long a matched segment is faded out at its end, in ms. A provider may end
 * a request while the waveform is still moving; a cut there is a step, and a
 * step is a click. Short enough to be inaudible as a fade, long enough to be a
 * ramp. Capped at a fiftieth of the segment, so a tiny one is not eaten by it.
 */
const SEGMENT_FADE_OUT_MS = 5;

/**
 * Ramps the last few milliseconds of PCM16LE down to zero. Returns a copy; the
 * input is not touched.
 *
 * @param {Buffer} bytes
 * @returns {Buffer}
 */
function fadeOutPcm(bytes) {
  const samples = Math.floor(bytes.length / 2);
  const wanted = Math.round((STREAM_SAMPLE_RATE * SEGMENT_FADE_OUT_MS) / 1000);
  const length = Math.min(wanted, Math.floor(samples / 50));
  if (length < 2) return bytes;
  const out = Buffer.from(bytes);
  for (let step = 0; step < length; step += 1) {
    const index = samples - length + step;
    // (length - 1 - step) / (length - 1): 1 at the start of the ramp, 0 on the last sample.
    const factor = (length - 1 - step) / (length - 1);
    out.writeInt16LE(Math.round(out.readInt16LE(index * 2) * factor), index * 2);
  }
  return out;
}

/**
 * Applies one constant gain to PCM16LE, clamping rather than wrapping.
 *
 * @param {Buffer} bytes
 * @param {number} gain linear, 1 = untouched
 * @returns {Buffer}
 */
function applyPcmGain(bytes, gain) {
  if (!(gain > 0) || gain === 1) return bytes;
  const samples = Math.floor(bytes.length / 2);
  const out = Buffer.allocUnsafe(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    const scaled = Math.round(bytes.readInt16LE(index * 2) * gain);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, scaled)), index * 2);
  }
  return out;
}

/**
 * Wraps PCM16LE chunks in one canonical 44-byte RIFF/WAVE header, at the
 * stream's own format (24 kHz mono, 16 bit). This is what lets a long reply on
 * `POST /speech` come back as *one* playable file after being spoken in
 * several requests: PCM concatenates sample-exactly, an encoder's output does
 * not (every clip carries its own padding).
 *
 * @param {Buffer[]} chunks
 * @returns {Buffer}
 */
function wrapPcm16Wav(chunks) {
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(44);
  const blockAlign = STREAM_CHANNELS * 2;
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + body.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // PCM fmt chunk length
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(STREAM_CHANNELS, 22);
  header.writeUInt32LE(STREAM_SAMPLE_RATE, 24);
  header.writeUInt32LE(STREAM_SAMPLE_RATE * blockAlign, 28); // byte rate
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(body.length, 40);
  return Buffer.concat([header, body]);
}

/**
 * Starts reading `iterator` now and queues what it yields, so a caller can
 * consume it later without the provider's first byte arriving late. One
 * segment is buffered at a time (a few hundred kB), which is what makes the
 * next request's round trip invisible: it happens while the current one plays.
 *
 * @param {AsyncIterable<Buffer>} iterator
 * @returns {AsyncIterable<Buffer>}
 */
function bufferSegment(iterator) {
  const queue = [];
  let finished = false;
  let failure = null;
  let wake = null;
  const wakeUp = () => {
    if (!wake) return;
    const resolve = wake;
    wake = null;
    resolve();
  };
  (async () => {
    try {
      for await (const chunk of iterator) {
        queue.push(chunk);
        wakeUp();
      }
    } catch (error) {
      failure = error;
    }
    finished = true;
    wakeUp();
  })();

  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          for (;;) {
            if (queue.length > 0) return { value: queue.shift(), done: false };
            if (failure) throw failure;
            if (finished) return { value: undefined, done: true };
            // eslint-disable-next-line no-await-in-loop
            await new Promise((resolve) => { wake = resolve; });
          }
        },
      };
    },
  };
}

/**
 * Where one sentence ends. Terminators are only `.` `!` `?` and `…` followed by
 * whitespace or the end of the text, with guards for what merely looks like
 * one: decimals and version numbers (`3.14`, `v2.0`), initials and known
 * abbreviations (`J. Smith`, `Dr.`, `bijv.`), and numbered list markers
 * (`1. First`).
 */
const SENTENCE_END = /[.!?…]+["'”’»)\]*_`]*(?=\s|$)/gu;

const ABBREVIATIONS = new Set([
  'bijv', 'bijz', 'bv', 'ca', 'dhr', 'dr', 'ds', 'e.g', 'enz', 'etc', 'i.e',
  'jr', 'mevr', 'mr', 'nr', 'prof', 'sr', 'st', 'vs', 'zgn',
]);

// A chain of single letters with dots: `U.S`, `J.R.R`.
const INITIALISM = /^(?:\p{L}\.)+\p{L}?$/u;

/**
 * Whether the terminator starting at `index` really ends a sentence.
 * `text` is the whole string; `index` points at the first `.`/`!`/`?`/`…`.
 */
function endsSentence(text, index) {
  const before = text.slice(0, index);
  const word = before.match(/(\p{L}[\p{L}.]*|\d+)$/u);
  if (!word) return true;
  const token = word[1];
  // A single letter is an initial: "J. Smith", not the end of a sentence.
  if (/^\p{L}$/u.test(token)) return false;
  // A number directly after the start of a line is a list marker ("1. Eerst"),
  // while a year or count inside a sentence ("in 2020.") is a real ending.
  if (/^\d+$/u.test(token)) {
    const lineStart = before.lastIndexOf('\n') + 1;
    return !/^\s*$/u.test(before.slice(lineStart, before.length - token.length));
  }
  return !(ABBREVIATIONS.has(token.toLowerCase()) || INITIALISM.test(token));
}

/** The sentences of `text`, in order, each with its closing punctuation. */
function sentences(text) {
  const value = String(text ?? '').trim();
  if (!value) return [];
  const pattern = new RegExp(SENTENCE_END.source, 'gu');
  const found = [];
  let start = 0;
  let match;
  while ((match = pattern.exec(value)) !== null) {
    if (!endsSentence(value, match.index)) continue;
    const end = match.index + match[0].length;
    const sentence = value.slice(start, end).trim();
    if (sentence) found.push(sentence);
    start = end;
  }
  const rest = value.slice(start).trim();
  if (rest) found.push(rest);
  return found;
}

/** Greedy packing of `parts` into pieces of at most `SEGMENT_MAX_CHARS`. */
function packParts(parts) {
  const out = [];
  let current = '';
  for (const part of parts) {
    if (current && current.length + 1 + part.length > SEGMENT_MAX_CHARS) {
      out.push(current);
      current = '';
    }
    current = current ? `${current} ${part}` : part;
  }
  if (current) out.push(current);
  return out;
}

/**
 * A sentence that is longer than one request may speak, cut where a speaker
 * would breathe (a comma, semicolon, colon or dash) and otherwise between
 * words. Nothing is dropped: the pieces keep their own punctuation.
 */
function splitLongSentence(sentence) {
  if (sentence.length <= SEGMENT_MAX_CHARS) return [sentence];
  const out = [];
  for (const clause of sentence.split(/(?<=[,;:—–])\s+/u)) {
    if (clause.length <= SEGMENT_MAX_CHARS) {
      out.push(clause);
      continue;
    }
    const words = clause.split(/\s+/u);
    let current = '';
    for (const word of words) {
      if (current && current.length + 1 + word.length > SEGMENT_MAX_CHARS) {
        out.push(current);
        current = '';
      }
      current = current ? `${current} ${word}` : word;
    }
    if (current) out.push(current);
  }
  return packParts(out);
}

/**
 * The paragraphs of `text`, whitespace normalised. A blank line is the only
 * break a reader hears as a pause; a single newline is a line wrap in a list
 * or a quote and speaks on.
 */
function paragraphs(text) {
  return String(text ?? '')
    .split(/\n\s*\n+/u)
    .map((paragraph) => paragraph.replace(/\s+/gu, ' ').trim())
    .filter(Boolean);
}

/**
 * The pieces `stream()` asks the provider for, in speaking order: one per
 * paragraph, and only a paragraph longer than `SEGMENT_MAX_CHARS` is cut
 * further (at its sentence ends), so no single request runs long enough for
 * its level to sink audibly.
 *
 * @param {string} text
 * @returns {string[]}
 */
function splitForSynthesis(text) {
  const segments = [];
  for (const paragraph of paragraphs(text)) {
    if (paragraph.length <= SEGMENT_MAX_CHARS) {
      segments.push(paragraph);
      continue;
    }
    let current = '';
    for (const sentence of sentences(paragraph)) {
      for (const piece of splitLongSentence(sentence)) {
        if (current && current.length + 1 + piece.length > SEGMENT_MAX_CHARS) {
          segments.push(current);
          current = '';
        }
        current = current ? `${current} ${piece}` : piece;
      }
    }
    if (current) segments.push(current);
  }
  return segments;
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
  // `env` goes along so the client reads its own flags from the environment it
  // was built for, not from process.env.
  return isConfigured(config) ? createMistralTts({ ...config, env }) : undefined;
}

module.exports = {
  createMistralTts,
  listVoices,
  readTtsConfig,
  isConfigured,
  createFromEnv,
  normalizeFormat,
  mimeTypeFor,
  splitForSynthesis,
  createPcmTrimmer,
  createPcmMeter,
  matchSegmentGain,
  applyPcmGain,
  fadeOutPcm,
  wrapPcm16Wav,
  LANGUAGES,
  LEVEL_MIN_SPEECH_SAMPLES,
  STREAM_FORMAT,
  STREAM_SAMPLE_RATE,
  STREAM_CHANNELS,
};
