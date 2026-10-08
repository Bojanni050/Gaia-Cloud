'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { PREFIX, toSourceRef, isFoundationRef, ingestObjectId } = require('../src/foundationRef');

test('toSourceRef builds the canonical foundation:<uuid> reference', () => {
  assert.equal(toSourceRef('abc-123'), 'foundation:abc-123');
  assert.equal(PREFIX, 'foundation:');
});

test('toSourceRef tolerates Foundation\'s episode id shape (ingest:<uuid>)', () => {
  assert.equal(toSourceRef('ingest:abc-123'), 'foundation:abc-123');
});

test('toSourceRef returns an empty string when there is no id', () => {
  assert.equal(toSourceRef(null), '');
  assert.equal(toSourceRef(undefined), '');
  assert.equal(toSourceRef('   '), '');
  assert.equal(toSourceRef('ingest:'), '');
});

test('isFoundationRef is strict about the canonical form', () => {
  assert.equal(isFoundationRef('foundation:abc'), true);
  assert.equal(isFoundationRef('foundation:'), false);
  assert.equal(isFoundationRef('chronicle:abc'), false);
  assert.equal(isFoundationRef(null), false);
});

test('ingestObjectId returns the bare uuid Foundation\'s /api/ingest-logs/:id expects', () => {
  assert.equal(ingestObjectId('foundation:abc-123'), 'abc-123');
  // the whole point: the episode layer's "ingest:" prefix must not survive
  assert.equal(ingestObjectId('foundation:ingest:abc-123'), 'abc-123');
});

test('ingestObjectId still resolves legacy chronicle: rows (pre-migration)', () => {
  assert.equal(ingestObjectId('chronicle:abc-123'), 'abc-123');
  assert.equal(ingestObjectId('chronicle:ingest:abc-123'), 'abc-123');
});

test('ingestObjectId rejects a non-reference or an empty reference', () => {
  assert.equal(ingestObjectId('abc-123'), null);
  assert.equal(ingestObjectId('foundation:'), null);
  assert.equal(ingestObjectId('chronicle:'), null);
  assert.equal(ingestObjectId(null), null);
  assert.equal(ingestObjectId(42), null);
});

test('the round trip is stable: toSourceRef -> ingestObjectId leaves the uuid untouched', () => {
  for (const raw of ['abc', 'ingest:abc', '  ingest:abc  ']) {
    assert.equal(ingestObjectId(toSourceRef(raw)), 'abc');
  }
});
