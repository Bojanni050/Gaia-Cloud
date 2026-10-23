'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isSocialTurn } = require('../src/logos/socialFilter');

test('greetings, thanks and acknowledgements are social', () => {
  for (const text of ['hoi', 'Hallo!', 'goedemorgen', 'dank je wel', 'bedankt', 'oké', 'prima', 'ja precies', 'nee hoor', 'haha', 'doei', 'tot morgen']) {
    assert.equal(isSocialTurn(text), true, text);
  }
});

test('a greeting that opens a very short line is still social', () => {
  assert.equal(isSocialTurn('hoi, alles goed?'), true);
  assert.equal(isSocialTurn('hey, hoe is het?'), true);
});

test('a greeting that opens a real request is a conversation', () => {
  assert.equal(isSocialTurn('hoi, kun je naar de planning kijken?'), false);
  assert.equal(isSocialTurn('hallo, ik zit vast met de migratie van de cognition-service'), false);
});

test('a short but meaningful remark is no longer treated as noise', () => {
  assert.equal(isSocialTurn('de planning loopt vast'), false);
  assert.equal(isSocialTurn('nee, dat klopt niet'), false);
});

test('an empty message has nothing to observe', () => {
  assert.equal(isSocialTurn(''), true);
  assert.equal(isSocialTurn('   '), true);
  assert.equal(isSocialTurn(null), true);
});
