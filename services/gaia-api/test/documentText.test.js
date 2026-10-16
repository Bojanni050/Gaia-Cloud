'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { extractDocumentText, isDocumentMime, documentKind } = require('../src/documentText');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name));

test('documentKind decides on mime type or extension (clients often send a useless type)', () => {
  assert.equal(documentKind('application/pdf', 'x'), 'pdf');
  assert.equal(documentKind('application/octet-stream', 'Report.PDF'), 'pdf');
  assert.equal(documentKind('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'x'), 'docx');
  assert.equal(documentKind('', 'notes.docx'), 'docx');
  assert.equal(documentKind('text/plain', 'notes.txt'), null);
  assert.equal(isDocumentMime('image/png', 'a.png'), false);
});

test('extracts the text layer of a PDF, without page markers', async () => {
  const text = await extractDocumentText(fixture('sample.pdf'), 'application/pdf', 'sample.pdf');
  assert.equal(text, 'Factuur 2026 totaal 1250 euro');
});

test('extracts paragraphs from a docx', async () => {
  const text = await extractDocumentText(fixture('sample.docx'), '', 'sample.docx');
  assert.equal(text, 'Kwartaalrapport Gaia\n\nDe omzet is gestegen met 12 procent.');
});

test('returns null — never throws — for a PDF without text, corrupt input and other formats', async () => {
  assert.equal(await extractDocumentText(fixture('blank.pdf'), 'application/pdf', 'blank.pdf'), null);
  assert.equal(await extractDocumentText(Buffer.from('not a pdf'), 'application/pdf', 'x.pdf'), null);
  assert.equal(await extractDocumentText(Buffer.from('not a zip'), '', 'x.docx'), null);
  assert.equal(await extractDocumentText(Buffer.from('hello'), 'text/plain', 'x.txt'), null);
});
