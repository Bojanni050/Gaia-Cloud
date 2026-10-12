'use strict';

/**
 * logLlmCall — the shared llm.call log seam. A logging call must never crash
 * its caller: an injectable sink is written to when it is a function, and a
 * non-function (e.g. a console-like object passed through a loose `logger`)
 * falls back to console.log.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { logLlmCall } = require('../src/logos/llmCallLog');

const ENTRY = { system: 'logos', provider: 'edenai', model: 'x', purpose: 'kairos.synthesis', ok: true };

test('writes the record to a function sink', () => {
  const lines = [];
  const record = logLlmCall(ENTRY, (line) => lines.push(line));
  assert.equal(record.kind, 'llm.call');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).model, 'x');
});

test('a non-function sink does not throw and still returns the record', () => {
  // Exactly the Kairos bug: the runtime passed `console` (an object) where a
  // line-logger was expected.
  const original = console.log;
  const lines = [];
  console.log = (line) => lines.push(line);
  try {
    const record = logLlmCall(ENTRY, console);
    assert.equal(record.kind, 'llm.call');
    assert.equal(lines.length, 1, 'falls back to console.log');
  } finally {
    console.log = original;
  }
});

test('no sink falls back to console.log', () => {
  const original = console.log;
  let count = 0;
  console.log = () => { count += 1; };
  try {
    logLlmCall(ENTRY);
    assert.equal(count, 1);
  } finally {
    console.log = original;
  }
});
