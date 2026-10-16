'use strict';

/**
 * Document text extraction — turns an attached PDF or Word (.docx) file into plain text BEFORE
 * anything reaches performTurn or Logos, the same posture as ocrResolver.js for images: Logos
 * reasons over what it is given and never reads a raw attachment itself.
 *
 * Deliberately narrow: only formats whose text can be read exactly (a PDF's text layer, a docx's
 * paragraphs). It never guesses. A scanned PDF has no text layer, so it yields `null` — the caller
 * then reports honestly that the file could not be read, rather than inventing content.
 *
 * Never throws: an encrypted, corrupt or oversized file degrades to `null`, never breaks the turn.
 */

const PDF_MIME = 'application/pdf';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** More pages than this are not read: the prompt would be truncated long before, and parsing costs time. */
const MAX_PDF_PAGES = 200;

function extensionOf(filename) {
  return String(filename || '').toLowerCase().split('.').pop();
}

function mimeBase(mimeType) {
  return String(mimeType || '').toLowerCase().split(';')[0].trim();
}

/** @returns {'pdf'|'docx'|null} */
function documentKind(mimeType, filename) {
  const mime = mimeBase(mimeType);
  const ext = extensionOf(filename);
  if (mime === PDF_MIME || ext === 'pdf') return 'pdf';
  if (mime === DOCX_MIME || ext === 'docx') return 'docx';
  return null;
}

function isDocumentMime(mimeType, filename) {
  return documentKind(mimeType, filename) !== null;
}

async function extractPdfText(buffer) {
  // Loaded on demand: pdf-parse pulls in pdf.js, which the rest of the server never needs.
  const { PDFParse } = require('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const result = await parser.getText({ first: MAX_PDF_PAGES });
    return typeof result.text === 'string' ? result.text : '';
  } finally {
    await parser.destroy().catch(() => {});
  }
}

async function extractDocxText(buffer) {
  const mammoth = require('mammoth');
  const result = await mammoth.extractRawText({ buffer });
  return typeof result.value === 'string' ? result.value : '';
}

/**
 * @param {Buffer} buffer
 * @param {string} mimeType
 * @param {string} filename
 * @returns {Promise<string|null>} the text, or null when the file is not a supported document or has no readable text
 */
async function extractDocumentText(buffer, mimeType, filename) {
  const kind = documentKind(mimeType, filename);
  if (!kind) return null;
  try {
    const raw = kind === 'pdf' ? await extractPdfText(buffer) : await extractDocxText(buffer);
    // pdf.js separates pages with a "-- n of m --" marker line; keep the page breaks, drop the noise.
    const text = raw
      .replace(/^-- \d+ of \d+ --$/gm, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return text === '' ? null : text;
  } catch (error) {
    console.error(`[gaia:documents] could not read ${kind} (${error && error.name ? error.name : 'error'})`);
    return null;
  }
}

module.exports = { extractDocumentText, isDocumentMime, documentKind, MAX_PDF_PAGES };
