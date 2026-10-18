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
const { extractDocumentText, isDocumentMime } = require('./documentText');

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

  // In-memory copy of every file's meta.json, so listing doesn't re-read and
  // re-parse each one per call. Built lazily on first use and kept current by
  // saveFile/deleteFile; this store is the only writer of libraryDir.
  let metaIndex = null;

  function loadMetaIndex() {
    if (metaIndex) return metaIndex;
    const index = new Map();
    if (fs.existsSync(libraryDir)) {
      for (const entry of fs.readdirSync(libraryDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        try {
          index.set(entry.name, JSON.parse(fs.readFileSync(metaPath(entry.name), 'utf-8')));
        } catch (_) {
          // A directory without a readable meta.json is not a valid library
          // entry (e.g. an interrupted write) — skip it rather than fail the
          // whole listing.
        }
      }
    }
    metaIndex = index;
    return metaIndex;
  }

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
    if (metaIndex) metaIndex.set(id, meta);
    return { ...meta };
  }

  /** @returns {Array<{id, filename, mimeType, size, uploadedAt}>} newest first */
  function listFiles() {
    // Copies, so a caller can't mutate the cached metas.
    const files = [...loadMetaIndex().values()].map((meta) => ({ ...meta }));
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
    if (metaIndex) metaIndex.delete(id);
  }

  return { saveFile, listFiles, getFile, deleteFile, libraryDir };
}

// mime types resolved as UTF-8 text and inlined as conversational context
// verbatim. Images go through ocrResolver.js's vision-model step instead,
// and PDFs / Word (.docx) files through documentText.js's text extraction
// (see resolveAttachmentsForPrompt). Everything else (other binaries) is
// stored and referenced but not read — pretending otherwise would mean
// silently sending garbled bytes to the model as if they were prose.
const TEXT_MIME_PREFIXES = ['text/'];
const TEXT_MIME_EXACT = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/x-yaml',
  'application/yaml',
]);
// Enough for a long document, small enough not to crowd out the conversation itself.
const MAX_ATTACHMENT_CHARS = 30000;

// Clients often report a useless mime type for plain-text formats: "" or
// application/octet-stream (Windows has no registered type for .md/.log/.yml),
// "application/json; charset=utf-8", or a spreadsheet type for .csv. So the
// declared type is only trusted when it is specific; otherwise the extension,
// and finally the bytes themselves, decide.
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'json', 'jsonl', 'ndjson', 'csv', 'tsv', 'log', 'xml',
  'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'html', 'htm', 'css',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rs', 'go', 'java', 'c', 'h',
  'cpp', 'cs', 'sh', 'ps1', 'bat', 'sql', 'rtf', 'srt', 'vtt',
]);
const GENERIC_MIMES = new Set(['', 'application/octet-stream', 'binary/octet-stream']);

function looksLikeText(buffer) {
  if (!buffer || buffer.length === 0) return false;
  const sample = buffer.subarray(0, 4096);
  if (sample.includes(0)) return false;
  return !sample.toString('utf-8').includes('�');
}

function isTextMime(mimeType, filename, buffer) {
  const mt = String(mimeType || '').toLowerCase().split(';')[0].trim();
  if (TEXT_MIME_PREFIXES.some((prefix) => mt.startsWith(prefix))
    || TEXT_MIME_EXACT.has(mt) || mt.endsWith('+json') || mt.endsWith('+xml')) {
    return true;
  }
  if (isImageMime(mt) || mt === 'application/pdf') return false;
  const ext = String(filename || '').toLowerCase().split('.').pop();
  if (TEXT_EXTENSIONS.has(ext)) return true;
  return GENERIC_MIMES.has(mt) && looksLikeText(buffer);
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
 * transcript); PDFs and Word files resolve to their extracted text
 * (documentText.js); anything else resolves to `content: null` — the caller
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
  
  // Diagnostic logging (temporary)
  console.log(JSON.stringify({
    kind: 'attachment.resolution.debug',
    inputIds: ids,
    optionsModelSupportsVision: options.modelSupportsVision,
    optionsKeys: Object.keys(options),
  }));
  
  for (const id of ids) {
    let resolved;
    try {
      resolved = store.getFile(id);
    } catch (_) {
      // Missing/unreadable attachment — skip silently, never break the turn.
      continue;
    }
    const { meta, buffer } = resolved;

    // Diagnostic logging (temporary)
    console.log(JSON.stringify({
      kind: 'attachment.resolution.file',
      id,
      filename: meta.filename,
      mimeType: meta.mimeType,
      bufferSize: buffer.length,
      isText: isTextMime(meta.mimeType, meta.filename, buffer),
      isImage: isImageMime(meta.mimeType),
      modelSupportsVision: options.modelSupportsVision,
    }));

    if (isTextMime(meta.mimeType, meta.filename, buffer)) {
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
          imageBytesLength: buffer.length,
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
    } else if (isDocumentMime(meta.mimeType, meta.filename)) {
      // PDF / Word: the text is read exactly; a scanned PDF (no text layer) or an unreadable file is null.
      // eslint-disable-next-line no-await-in-loop
      const text = await extractDocumentText(buffer, meta.mimeType, meta.filename);
      results.push({ filename: meta.filename, content: text ? truncate(text) : null });
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
