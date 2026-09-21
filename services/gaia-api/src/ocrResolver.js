'use strict';

/**
 * OCR/vision resolution — turns image bytes into text BEFORE anything
 * reaches performTurn or ReasonIQ.
 *
 * Deliberately not ReasonIQ's job: ReasonIQ reasons over what it's given
 * — it must never retrieve, fetch, or transform a raw attachment itself
 * (its own v0.1 brief, §3: never "retrieve from Hindsight" or otherwise
 * act as a fetcher; reading an image is the same category of violation).
 * All information has to be available *before* anything hits ReasonIQ,
 * so this lives beside library.js's other attachment resolution, and
 * runs as a step ahead of the turn, not inside Logos.
 *
 * Uses the same OpenRouter account as ReasonIQ's reasoning model
 * (logos/reasoningModelClient.js) — same provider/baseUrl/apiKey — but a
 * separately choosable model id (`/admin`'s "Vision model" field,
 * resolveVisionModelConfig), since a good reasoning model and a good
 * vision model aren't always the same model. Falls back to ReasonIQ's own
 * model when no vision-specific one has been set. If the resolved model
 * isn't multimodal, or isn't configured at all, this degrades to "could
 * not be read" — the same honest fallback library.js already used for
 * every image before this file existed. Never throws into the turn.
 */

const { createReasoningModelClient } = require('./logos/reasoningModelClient');
const { resolveVisionModelConfig } = require('./logos/reasoningModelConfigResolver');
const { createReasoningModelStore } = require('./logos/reasoningModelStore');
const { createProviderStore } = require('./providerStore');

const IMAGE_MIME_PREFIX = 'image/';

const OCR_SYSTEM_PROMPT = [
  'You transcribe and describe images for a text-only system that cannot see them itself.',
  'If the image contains readable text, transcribe it exactly, preserving structure where it matters.',
  'Otherwise, describe what the image shows — concisely and factually, no speculation beyond what is visibly there.',
  'Respond with plain text only. No markdown, no preamble, no commentary about being an AI.',
].join(' ');

// A vision description is an inference about pixels, not a verbatim
// record the way a text file's own bytes are — this prefix travels with
// the extracted text everywhere it's used, so it's never presented
// indistinguishably from ground truth (soul.md: "she never pretends
// certainty").
const VISION_DISCLAIMER = '[AI-generated description of this image — may be inaccurate, not a verbatim transcript]';

function isImageMime(mimeType) {
  return String(mimeType || '').toLowerCase().startsWith(IMAGE_MIME_PREFIX);
}

/**
 * @param {Buffer} buffer
 * @param {string} mimeType
 * @param {{ model?: { chat: Function, isConfigured?: Function } }} [options]
 * @returns {Promise<string|null>} disclaimer-prefixed extracted text, or null if unavailable
 */
async function resolveImageText(buffer, mimeType, options = {}) {
  const model = options.model || createReasoningModelClient(resolveVisionModelConfig({ store: createReasoningModelStore(), providerStore: createProviderStore() }));

  if (typeof model.isConfigured === 'function' && !model.isConfigured()) {
    return null;
  }

  const dataUrl = `data:${mimeType};base64,${buffer.toString('base64')}`;
  const messages = [
    { role: 'system', content: OCR_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Transcribe or describe this image.' },
        { type: 'image_url', image_url: { url: dataUrl } },
      ],
    },
  ];

  let text;
  try {
    // responseFormat: null — this is a freeform-text request, not
    // ReasonIQ's structured-JSON one; forcing json_object here would be
    // both semantically wrong and, on some providers, incompatible with
    // an image_url content block.
    text = await model.chat(messages, { responseFormat: null });
  } catch (_) {
    return null;
  }

  if (typeof text !== 'string' || !text.trim()) return null;
  return `${VISION_DISCLAIMER}\n\n${text.trim()}`;
}

module.exports = { resolveImageText, isImageMime, OCR_SYSTEM_PROMPT, VISION_DISCLAIMER };
