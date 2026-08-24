'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLibraryStore, resolveAttachmentsForPrompt, isTextMime, LibraryFileNotFoundError } = require('../src/library');

function tempStore() {
  const libraryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-library-'));
  return createLibraryStore({ libraryDir });
}

test('saveFile persists a blob and metadata, and returns the metadata', () => {
  const store = tempStore();
  const meta = store.saveFile(Buffer.from('hello world'), { filename: 'notes.txt', mimeType: 'text/plain' });
  assert.ok(meta.id);
  assert.equal(meta.filename, 'notes.txt');
  assert.equal(meta.mimeType, 'text/plain');
  assert.equal(meta.size, 11);
  assert.ok(meta.uploadedAt);
});

test('getFile returns the exact bytes and metadata that were saved', () => {
  const store = tempStore();
  const content = Buffer.from('the quick brown fox');
  const saved = store.saveFile(content, { filename: 'fox.txt', mimeType: 'text/plain' });
  const { meta, buffer } = store.getFile(saved.id);
  assert.deepEqual(meta, saved);
  assert.ok(buffer.equals(content));
});

test('getFile throws LibraryFileNotFoundError for an unknown id', () => {
  const store = tempStore();
  assert.throws(() => store.getFile('does-not-exist'), LibraryFileNotFoundError);
});

test('listFiles returns all saved files, newest first', () => {
  const store = tempStore();
  const a = store.saveFile(Buffer.from('a'), { filename: 'a.txt', mimeType: 'text/plain' });
  // Force a distinguishable timestamp ordering without relying on real time gaps.
  const bMeta = { ...store.saveFile(Buffer.from('b'), { filename: 'b.txt', mimeType: 'text/plain' }) };

  const files = store.listFiles();
  assert.equal(files.length, 2);
  assert.ok(files.some((f) => f.id === a.id));
  assert.ok(files.some((f) => f.id === bMeta.id));
});

test('listFiles returns an empty array when nothing has been saved (directory not yet created)', () => {
  const libraryDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-library-')), 'not-created-yet');
  const store = createLibraryStore({ libraryDir });
  assert.deepEqual(store.listFiles(), []);
});

test('listFiles skips a directory with no readable meta.json rather than failing the whole listing', () => {
  const store = tempStore();
  const good = store.saveFile(Buffer.from('ok'), { filename: 'ok.txt', mimeType: 'text/plain' });
  fs.mkdirSync(path.join(store.libraryDir, 'corrupted'));

  const files = store.listFiles();
  assert.equal(files.length, 1);
  assert.equal(files[0].id, good.id);
});

test('deleteFile removes the file entirely', () => {
  const store = tempStore();
  const saved = store.saveFile(Buffer.from('gone soon'), { filename: 'x.txt', mimeType: 'text/plain' });
  store.deleteFile(saved.id);
  assert.throws(() => store.getFile(saved.id), LibraryFileNotFoundError);
  assert.deepEqual(store.listFiles(), []);
});

test('deleteFile throws LibraryFileNotFoundError for an unknown id', () => {
  const store = tempStore();
  assert.throws(() => store.deleteFile('does-not-exist'), LibraryFileNotFoundError);
});

test('saveFile falls back to safe defaults for missing filename/mimeType', () => {
  const store = tempStore();
  const meta = store.saveFile(Buffer.from('x'), {});
  assert.equal(meta.filename, 'upload');
  assert.equal(meta.mimeType, 'application/octet-stream');
});

// --- isTextMime / resolveAttachmentsForPrompt (attach-to-chat context) ---

test('isTextMime recognizes text/* and common structured-text types', () => {
  assert.equal(isTextMime('text/plain'), true);
  assert.equal(isTextMime('text/markdown'), true);
  assert.equal(isTextMime('application/json'), true);
  assert.equal(isTextMime('application/x-yaml'), true);
  assert.equal(isTextMime('image/png'), false);
  assert.equal(isTextMime('application/pdf'), false);
  assert.equal(isTextMime(''), false);
});

test('resolveAttachmentsForPrompt returns [] for no ids, without touching the store', async () => {
  const store = tempStore();
  assert.deepEqual(await resolveAttachmentsForPrompt(store, []), []);
  assert.deepEqual(await resolveAttachmentsForPrompt(store, undefined), []);
});

test('resolveAttachmentsForPrompt inlines text-file content', async () => {
  const store = tempStore();
  const saved = store.saveFile(Buffer.from('the meeting is at 3pm'), { filename: 'notes.txt', mimeType: 'text/plain' });
  const [attachment] = await resolveAttachmentsForPrompt(store, [saved.id]);
  assert.equal(attachment.filename, 'notes.txt');
  assert.equal(attachment.content, 'the meeting is at 3pm');
});

test('resolveAttachmentsForPrompt reports a non-text, non-image file without content', async () => {
  const store = tempStore();
  const saved = store.saveFile(Buffer.from('%PDF-1.4'), { filename: 'doc.pdf', mimeType: 'application/pdf' });
  const [attachment] = await resolveAttachmentsForPrompt(store, [saved.id]);
  assert.equal(attachment.filename, 'doc.pdf');
  assert.equal(attachment.content, null);
});

test('resolveAttachmentsForPrompt resolves an image via OCR when a vision model is available', async () => {
  const store = tempStore();
  const saved = store.saveFile(Buffer.from([0x89, 0x50, 0x4e, 0x47]), { filename: 'photo.png', mimeType: 'image/png' });
  const ocrModel = { chat: async () => 'a whiteboard with a project timeline', isConfigured: () => true };

  const [attachment] = await resolveAttachmentsForPrompt(store, [saved.id], { ocrModel });
  assert.equal(attachment.filename, 'photo.png');
  assert.match(attachment.content, /whiteboard with a project timeline/);
  assert.match(attachment.content, /AI-generated description/); // the vision disclaimer travels with it
});

test('resolveAttachmentsForPrompt reports an image without content when no vision model is configured', async () => {
  const store = tempStore();
  const saved = store.saveFile(Buffer.from([0x89, 0x50, 0x4e, 0x47]), { filename: 'photo.png', mimeType: 'image/png' });
  const ocrModel = { chat: async () => { throw new Error('must not be called'); }, isConfigured: () => false };

  const [attachment] = await resolveAttachmentsForPrompt(store, [saved.id], { ocrModel });
  assert.equal(attachment.content, null);
});

test('resolveAttachmentsForPrompt truncates content beyond the character cap', async () => {
  const store = tempStore();
  const huge = 'x'.repeat(9000);
  const saved = store.saveFile(Buffer.from(huge), { filename: 'big.txt', mimeType: 'text/plain' });
  const [attachment] = await resolveAttachmentsForPrompt(store, [saved.id]);
  assert.ok(attachment.content.length < huge.length);
  assert.match(attachment.content, /truncated/);
});

test('resolveAttachmentsForPrompt silently skips a missing id rather than throwing', async () => {
  const store = tempStore();
  assert.deepEqual(await resolveAttachmentsForPrompt(store, ['does-not-exist']), []);
});

// === PATCH: Native Vision — Multimodal Attachment Resolution ==============

test('resolveAttachmentsForPrompt returns raw image bytes when modelSupportsVision is true', async () => {
  const store = tempStore();
  const tinyPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG header
  const saved = store.saveFile(tinyPng, { filename: 'photo.png', mimeType: 'image/png' });

  const [attachment] = await resolveAttachmentsForPrompt(store, [saved.id], { modelSupportsVision: true });
  
  // Should have imageBytes and imageMimeType, not OCR text content
  assert.ok(attachment.imageBytes, 'should have imageBytes');
  assert.ok(Buffer.isBuffer(attachment.imageBytes), 'imageBytes should be a Buffer');
  assert.equal(attachment.imageMimeType, 'image/png');
  assert.equal(attachment.content, null, 'content should be null for native vision path');
  assert.equal(attachment.filename, 'photo.png');
});

test('resolveAttachmentsForPrompt uses OCR fallback when modelSupportsVision is false', async () => {
  const store = tempStore();
  const tinyPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const saved = store.saveFile(tinyPng, { filename: 'photo.png', mimeType: 'image/png' });
  
  // OCR model that returns a description
  const ocrModel = { 
    chat: async () => 'A red pixel', 
    isConfigured: () => true 
  };

  const [attachment] = await resolveAttachmentsForPrompt(store, [saved.id], { 
    modelSupportsVision: false, 
    ocrModel 
  });
  
  // Should use OCR path - content is text description
  assert.ok(attachment.content, 'should have text content from OCR');
  assert.ok(attachment.content.includes('A red pixel'), 'content should contain OCR description');
  assert.equal(attachment.imageBytes, undefined, 'should not have imageBytes when using OCR');
});

test('resolveAttachmentsForPrompt uses OCR fallback when modelSupportsVision is unknown', async () => {
  const store = tempStore();
  const tinyPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const saved = store.saveFile(tinyPng, { filename: 'photo.png', mimeType: 'image/png' });
  
  const ocrModel = { 
    chat: async () => 'Description', 
    isConfigured: () => true 
  };

  // modelSupportsVision not provided (undefined = unknown)
  const [attachment] = await resolveAttachmentsForPrompt(store, [saved.id], { ocrModel });
  
  // Should fall back to OCR (safe default)
  assert.ok(attachment.content, 'should have content from OCR fallback');
});

test('categorizeAttachments separates text and multimodal attachments', async () => {
  const { categorizeAttachments } = require('../src/library');
  
  const attachments = [
    { filename: 'notes.txt', content: 'Text content' },
    { filename: 'photo.png', content: null, imageBytes: Buffer.from('fake'), imageMimeType: 'image/png' },
    { filename: 'readme.md', content: '# Hello' },
    { filename: 'image.jpg', content: null, imageBytes: Buffer.from('fake'), imageMimeType: 'image/jpeg' },
  ];

  const { textAttachments, multimodalAttachments } = categorizeAttachments(attachments);
  
  assert.equal(textAttachments.length, 2);
  assert.equal(textAttachments[0].filename, 'notes.txt');
  assert.equal(textAttachments[1].filename, 'readme.md');
  
  assert.equal(multimodalAttachments.length, 2);
  assert.equal(multimodalAttachments[0].filename, 'photo.png');
  assert.equal(multimodalAttachments[1].filename, 'image.jpg');
});
