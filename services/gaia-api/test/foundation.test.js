'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  deriveIntent,
  selectDocuments,
  buildSystemPrompt,
  loadFoundationDocuments,
} = require('../src/foundation');

test('deriveIntent classifies technical, gaia and plain conversation turns', () => {
  assert.deepEqual(deriveIntent([{ role: 'user', content: 'help me deploy this database' }]), { type: 'technical' });
  assert.deepEqual(deriveIntent([{ role: 'user', content: 'who are you, really?' }]), { type: 'gaia' });
  assert.deepEqual(deriveIntent([{ role: 'user', content: 'how is your day going' }]), { type: 'conversation' });
  assert.deepEqual(deriveIntent([]), { type: 'conversation' });
});

test('selectDocuments matches each rule branch, falling back to the base three', () => {
  assert.deepEqual(selectDocuments({ type: 'technical' }), ['soul.md', 'principles.md', 'lexicon.md', 'identity.md']);
  assert.deepEqual(selectDocuments({ type: 'gaia' }), ['soul.md', 'principles.md', 'lexicon.md', 'identity.md']);
  assert.deepEqual(selectDocuments({ type: 'conversation' }), ['soul.md', 'principles.md', 'lexicon.md']);
  assert.deepEqual(selectDocuments({ type: 'unknown' }), ['soul.md', 'principles.md', 'lexicon.md']);
});

test('the archive documents are never sent with a turn', () => {
  // architecture.md (~33 kB) and evolution.md (~131 kB) are the reference, not the
  // prompt: they carry code-level detail and engineering history that a live turn
  // never needs, and until 2026-11-11 they rode along on every technical and
  // gaia-shaped turn respectively. identity.md is what replaced them.
  for (const type of ['technical', 'gaia', 'conversation', 'unknown']) {
    const selected = selectDocuments({ type });
    assert.ok(!selected.includes('architecture.md'), `${type} must not carry the full architecture`);
    assert.ok(!selected.includes('evolution.md'), `${type} must not carry the frozen history`);
    assert.ok(!selected.includes('identity.md') || type !== 'conversation', 'plain conversation stays on the base three');
  }
});

test('buildSystemPrompt joins selected documents with the exact separator, skipping missing ones', () => {
  const documents = { 'soul.md': 'SOUL', 'principles.md': 'PRINCIPLES', 'lexicon.md': 'LEXICON' };
  const prompt = buildSystemPrompt(documents, [{ role: 'user', content: 'how is your day' }]);
  assert.equal(prompt, 'SOUL\n\n---\n\nPRINCIPLES\n\n---\n\nLEXICON');
});

test('buildSystemPrompt skips a document missing from the artifact rather than crashing', () => {
  const documents = { 'soul.md': 'SOUL', 'lexicon.md': 'LEXICON' }; // principles.md missing
  const prompt = buildSystemPrompt(documents, [{ role: 'user', content: 'how is your day' }]);
  assert.equal(prompt, 'SOUL\n\n---\n\nLEXICON');
});

test('loadFoundationDocuments reads FOUNDATION_ARTIFACT_PATH and refuses malformed/missing artifacts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-foundation-'));
  const artifactPath = path.join(dir, 'foundation-artifact.json');
  const previous = process.env.FOUNDATION_ARTIFACT_PATH;
  try {
    fs.writeFileSync(artifactPath, JSON.stringify({ documents: { 'soul.md': 'SOUL' } }));
    process.env.FOUNDATION_ARTIFACT_PATH = artifactPath;
    assert.deepEqual(loadFoundationDocuments(), { 'soul.md': 'SOUL' });

    fs.writeFileSync(artifactPath, 'not json');
    assert.throws(() => loadFoundationDocuments(), /not valid JSON/);

    fs.writeFileSync(artifactPath, JSON.stringify({ nope: true }));
    assert.throws(() => loadFoundationDocuments(), /documents/);
  } finally {
    if (previous === undefined) delete process.env.FOUNDATION_ARTIFACT_PATH;
    else process.env.FOUNDATION_ARTIFACT_PATH = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
