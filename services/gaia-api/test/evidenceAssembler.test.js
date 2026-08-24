'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  assembleEvidence,
  EVIDENCE_SOURCES,
  EVIDENCE_TYPES,
  MAX_EVIDENCE_ITEMS,
  MAX_EVIDENCE_CONTENT_CHARS,
} = require('../src/reasoning/evidenceAssembler');

test('assembler normalizes Hindsight reflections into stable-id memory evidence with relevance passthrough', () => {
  const evidence = assembleEvidence({
    reflections: [
      { text: 'Bo prefers async updates', scores: { final: 0.91 } },
      { text: 'Bo works on Gaia in the evenings', scores: { final: 0.72 } },
    ],
  });
  assert.equal(evidence.length, 2);
  assert.deepEqual(
    evidence.map((e) => e.id),
    ['hindsight-1', 'hindsight-2']
  );
  assert.equal(evidence[0].source, 'hindsight');
  assert.equal(evidence[0].type, 'memory');
  assert.equal(evidence[0].relevance, 0.91);
  assert.equal(evidence[0].content, 'Bo prefers async updates');
});

test('assembler treats uploads as high-relevance document evidence and skips images', () => {
  const evidence = assembleEvidence({
    attachments: [
      { filename: 'notes.txt', content: 'The streaming design uses a single emitter.' },
      { filename: 'photo.png', content: 'should be ignored', imageBytes: Buffer.from('x'), imageMimeType: 'image/png' },
    ],
  });
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].id, 'upload-1');
  assert.equal(evidence[0].source, 'upload');
  assert.equal(evidence[0].type, 'document');
  assert.equal(evidence[0].relevance, 0.95);
});

test('assembler sorts by relevance descending regardless of source order', () => {
  const evidence = assembleEvidence({
    reflections: [{ text: 'medium memory', scores: { final: 0.5 } }],
    attachments: [{ filename: 'a.txt', content: 'fresh upload' }],
    mentalModels: [{ summary: 'standing model', confidence: 0.6 }],
  });
  // upload 0.95 > model 0.6 > reflection 0.5
  assert.deepEqual(evidence.map((e) => e.source), ['upload', 'hindsight', 'hindsight']);
  assert.deepEqual(evidence.map((e) => e.type), ['document', 'mental_model', 'memory']);
});

test('assembler deduplicates near-identical content, keeping the first occurrence', () => {
  const evidence = assembleEvidence({
    reflections: [
      { text: 'Bo prefers async updates', scores: { final: 0.9 } },
      { text: 'Bo   prefers\nasync   updates', scores: { final: 0.85 } },
    ],
  });
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].relevance, 0.9);
});

test('assembler caps total items and truncates long content', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ text: `memory item ${i} — ${'x'.repeat(600)}`, scores: { final: 0.9 - i * 0.01 } }));
  const evidence = assembleEvidence({ reflections: many });
  assert.equal(evidence.length, MAX_EVIDENCE_ITEMS);
  for (const e of evidence) {
    assert.ok(e.content.length <= MAX_EVIDENCE_CONTENT_CHARS + 1); // + ellipsis
    assert.ok(e.relevance >= 0.7); // highest-relevance ones survived the cap
  }
});

test('assembler is honest about empty and malformed input — never throws, never invents', () => {
  assert.deepEqual(assembleEvidence({}), []);
  assert.deepEqual(assembleEvidence({ reflections: [null, {}, { text: '' }] }), []);
  assert.deepEqual(assembleEvidence(null), []);
  const weird = assembleEvidence({
    reflections: [{ text: 'ok but no scores' }],
    mentalModels: [{ text: 'model via .text fallback' }],
  });
  // Sorted by relevance: the model's default 0.6 outranks the reflection's 0.5.
  assert.equal(weird[0].id, 'model-1');
  assert.equal(weird[0].relevance, 0.6); // mental-model default
  assert.equal(weird[1].id, 'hindsight-1');
  assert.equal(weird[1].relevance, 0.5); // missing score -> honest neutral default
});

test('vocabulary: sources and types are frozen and match the brief', () => {
  assert.deepEqual([...EVIDENCE_SOURCES], ['hindsight', 'conversation', 'upload', 'tool']);
  assert.deepEqual([...EVIDENCE_TYPES], ['memory', 'mental_model', 'conversation', 'document', 'tool_result']);
});

test('boundary: evidenceAssembler never imports Hindsight, Hermes, web, or the Decision Engine', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/reasoning/evidenceAssembler.js'), 'utf-8');
  for (const forbidden of ['hindsightClient', 'hermesClient', 'braveSearch', 'decisionEngine', 'orchestrator', 'reasonIQ']) {
    assert.ok(!source.includes(forbidden), `evidenceAssembler references ${forbidden}`);
  }
});

// === Hypothesis Persistence 0.1: native provenance via sourceRef ===========

test("0.1 provenance: Hindsight reflections carry their NATIVE fact id in sourceRef", () => {
  const evidence = assembleEvidence({
    reflections: [
      { id: "hs_fact_abc", text: "Bo prefers async updates", scores: { final: 0.9 } },
      { text: "no id supplied", scores: { final: 0.5 } },
    ],
  });
  assert.equal(evidence[0].sourceRef, "hs_fact_abc");
  assert.equal(evidence[0].id, "hindsight-1"); // local id unchanged for consumers
  assert.equal(evidence[1].sourceRef, null); // honest null when absent
});

test("0.1 provenance: non-Hindsight sources have an explicit null sourceRef", () => {
  const evidence = assembleEvidence({
    attachments: [{ filename: "a.txt", content: "uploaded" }],
    mentalModels: [{ id: "mm-9", summary: "standing" }],
    toolResults: [{ content: "tool out" }],
  });
  for (const e of evidence) assert.equal(e.sourceRef, null);
});
