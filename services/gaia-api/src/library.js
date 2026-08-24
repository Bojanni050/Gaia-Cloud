'use strict';

/**
 * File library — server-side storage for files uploaded from any Gaia
 * client. Lives in Gaia Cloud, not on any client (architecture.md: no
 * client holds canonical state) — same posture as the ReasonIQ admin
 * config store (reasoningModelStore.js), but for file blobs instead of a
 * single JSON record.
 *
 * Storage and browsing is the core of this file; resolveAttachmentsForPrompt
 * (below) additionally turns an attached file into text a turn can use as
 * context — verbatim for text files, via ocrResolver.js's vision model
 * for images — but only when a turn explicitly names the file's id
 * (principles.md's "Source First": a file becomes a source of truth when
 * reached for, never automatically).
 *
 * PATCH: Native Vision Support
 * When modelSupportsVision is true, images are returned as multimodal
 * attachment objects with raw bytes, NOT converted to OCR text.
 * This allows the main LLM to receive the image directly.
 *
 * One directory per file: `<libraryDir>/<id>/meta.json` + `.../blob`.
 * Deliberately not a single shared index — every operation touches only
 * its own file's directory, so there's no shared-index file to corrupt
 * under concurrent writes.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { resolveImageText, isImageMime } = require('./ocrResolver');

function resolveLibraryDir(env = process.env) {
  if (env.LIBRARY_PATH) return env.LIBRARY_PATH;
  const devPath = path.resolve(__dirname, '../data/library');
  const containerPath = '/app/data/library';
  return fs.existsSync('/app') ? containerPath : devPath;
}

class LibraryFileNotFoundError extends Error {
  constructor(id) {
    super(`library file not found: ${id}`);
    this.name = 'LibraryFileNotFoundError';
  }
}

/**
 * @param {{ libraryDir?: string }} [options]
 */
function createLibraryStore(options = {}) {
  const libraryDir = options.libraryDir || resolveLibraryDir();

  function fileDir(id) {
    return path.join(libraryDir, id);
  }
  function metaPath(id) {
    return path.join(fileDir(id), 'meta.json');
  }
  function blobPath(id) {
    return path.join(fileDir(id), 'blob');
  }

  /**
   * @param {Buffer} buffer
   * @param {{ filename: string, mimeType: string }} info
   * @returns {{ id: string, filename: string, mimeType: string, size: number, uploadedAt: string }}
   */
  function saveFile(buffer, { filename, mimeType }) {
    const id = crypto.randomUUID();
    fs.mkdirSync(fileDir(id), { recursive: true });
    fs.writeFileSync(blobPath(id), buffer);
    const meta = {
      id,
      filename: filename || 'upload',
      mimeType: mimeType || 'application/octet-stream',
      size: buffer.length,
      uploadedAt: new Date().toISOString(),
    };
    fs.writeFileSync(metaPath(id), JSON.stringify(meta, null, 2), 'utf-8');
    return meta;
  }

  /** @returns {Array<{id, filename, mimeType, size, uploadedAt}>} newest first */
  function listFiles() {
    if (!fs.existsSync(libraryDir)) return [];
    const entries = fs.readdirSync(libraryDir, { withFileTypes: true }).filter((e) => e.isDirectory());
    const files = [];
    for (const entry of entries) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath(entry.name), 'utf-8'));
        files.push(meta);
      } catch (_) {
        // A directory without a readable meta.json is not a valid library
        // entry (e.g. an interrupted write) — skip it rather than fail the
        // whole listing.
      }
    }
    files.sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : -1));
    return files;
  }

  /** @returns {{ meta: object, buffer: Buffer }} @throws {LibraryFileNotFoundError} */
  function getFile(id) {
    if (!fs.existsSync(metaPath(id))) throw new LibraryFileNotFoundError(id);
    const meta = JSON.parse(fs.readFileSync(metaPath(id), 'utf-8'));
    const buffer = fs.readFileSync(blobPath(id));
    return { meta, buffer };
  }

  /** @throws {LibraryFileNotFoundError} */
  function deleteFile(id) {
    if (!fs.existsSync(fileDir(id))) throw new LibraryFileNotFoundError(id);
    fs.rmSync(fileDir(id), { recursive: true, force: true });
  }

  return { saveFile, listFiles, getFile, deleteFile, libraryDir };
}

// mime types resolved as UTF-8 text and inlined as conversational context
// verbatim. Images go through ocrResolver.js's vision-model step instead
// (see resolveAttachmentsForPrompt). Everything else (PDFs, other
// binaries) is stored and referenced but not read — no extraction
// pipeline for those yet, and pretending otherwise would mean silently
// sending garbled bytes to Hermes as if they were prose.
const TEXT_MIME_PREFIXES = ['text/'];
const TEXT_MIME_EXACT = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/x-yaml',
  'application/yaml',
]);
const MAX_ATTACHMENT_CHARS = 8000;

function isTextMime(mimeType) {
  const mt = String(mimeType || '').toLowerCase();
  return TEXT_MIME_PREFIXES.some((prefix) => mt.startsWith(prefix)) || TEXT_MIME_EXACT.has(mt);
}

function truncate(content) {
  if (content.length <= MAX_ATTACHMENT_CHARS) return content;
  return `${content.slice(0, MAX_ATTACHMENT_CHARS)}\n[truncated — file is longer than ${MAX_ATTACHMENT_CHARS} characters]`;
}

/**
 * Resolves a turn's attached file ids into `{ filename, content }` pairs
 * ready to be rendered into a prompt (see turn.js's renderAttachmentContext)
 * — this is the step that runs *before* performTurn/ReasonIQ ever see the
 * turn, exactly once, so everything downstream just receives text. Text
 * files resolve verbatim; images go through ocrResolver.js's vision-model
 * step (disclaimer-prefixed — a description is an inference, not a
 * transcript); anything else resolves to `content: null` — the caller
 * still learns the file was attached, just not what's in it. Never
 * throws: a missing/unreadable file, or a failed OCR call, is skipped or
 * degrades to null — never breaks the turn (same discipline as
 * memory.js's recall/reflect).
 *
 * PATCH: Native Vision Support
 * When options.modelSupportsVision is true, images are returned as
 * multimodal attachment objects with raw bytes for direct LLM consumption:
 *   { filename, content: null, imageBytes: Buffer, imageMimeType: string }
 *
 * When options.modelSupportsVision is false or undefined, existing OCR
 * behavior is retained as fallback.
 *
 * @param {ReturnType<createLibraryStore>} store
 * @param {string[]} ids
 * @param {{ ocrModel?: object, modelSupportsVision?: boolean }} [options] test seam for ocrResolver.js's model client
 * @returns {Promise<Array<{ filename: string, content: string|null, imageBytes?: Buffer, imageMimeType?: string }>>}
 */
async function resolveAttachmentsForPrompt(store, ids, options = {}) {
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const results = [];
  for (const id of ids) {
    let resolved;
    try {
      resolved = store.getFile(id);
    } catch (_) {
      // Missing/unreadable attachment — skip silently, never break the turn.
      continue;
    }
    const { meta, buffer } = resolved;

    if (isTextMime(meta.mimeType)) {
      results.push({ filename: meta.filename, content: truncate(buffer.toString('utf-8')) });
    } else if (isImageMime(meta.mimeType)) {
      // PATCH: Native vision path — return raw bytes for multimodal input
      if (options.modelSupportsVision === true) {
        // Diagnostic logging (temporary)
        console.log(JSON.stringify({
          kind: 'attachment.resolution',
          attachmentDetected: true,
          imageMimeType: meta.mimeType,
          imageBytesAvailable: buffer.length > 0,
          modelSupportsVision: true,
          visionPathSelected: true,
          ocrFallbackSelected: false,
          filename: meta.filename,
        }));

        results.push({
          filename: meta.filename,
          content: null,
          imageBytes: buffer,
          imageMimeType: meta.mimeType,
        });
      } else {
        // Existing OCR fallback path for non-vision models
        // eslint-disable-next-line no-await-in-loop
        const described = await resolveImageText(buffer, meta.mimeType, { model: options.ocrModel });

        // Diagnostic logging (temporary)
        console.log(JSON.stringify({
          kind: 'attachment.resolution',
          attachmentDetected: true,
          imageMimeType: meta.mimeType,
          imageBytesAvailable: buffer.length > 0,
          modelSupportsVision: options.modelSupportsVision === false ? false : 'unknown',
          visionPathSelected: false,
          ocrFallbackSelected: true,
          ocrResultAvailable: described !== null,
          filename: meta.filename,
        }));

        results.push({ filename: meta.filename, content: described ? truncate(described) : null });
      }
    } else {
      results.push({ filename: meta.filename, content: null });
    }
  }
  return results;
}

/**
 * Separates resolved attachments into text-only and multimodal categories.
 * Text attachments go through the existing text context mechanism.
 * Multimodal attachments (images) remain structured data for LLM assembly.
 *
 * @param {Array<{ filename: string, content: string|null, imageBytes?: Buffer, imageMimeType?: string }>} attachments
 * @returns {{ textAttachments: Array, multimodalAttachments: Array }}
 */
function categorizeAttachments(attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return { textAttachments: [], multimodalAttachments: [] };
  }

  const textAttachments = [];
  const multimodalAttachments = [];

  for (const att of attachments) {
    if (att.imageBytes && att.imageMimeType) {
      multimodalAttachments.push(att);
    } else {
      textAttachments.push(att);
    }
  }

  return { textAttachments, multimodalAttachments };
}

module.exports = {
  createLibraryStore,
  resolveLibraryDir,
  resolveAttachmentsForPrompt,
  categorizeAttachments,
  isTextMime,
  isImageMime,
  LibraryFileNotFoundError,
};
