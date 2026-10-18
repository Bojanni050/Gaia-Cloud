'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readTurn, logTurnShape } = require('../src/turnShape');
const { shouldRecall, MEMORY_POLICY } = require('../src/memoryPolicy');
const { shouldAttemptPatternRetrieval } = require('../src/reasoning/patternAwareness');

// The corpus is the whole point of this file: for every one of these strings
// `readTurn` must say exactly what the live gates say today. That equality is
// what makes plan step 4 (moving the consumers onto the verdict) a mechanical
// change instead of a behavioural one.
const CORPUS = [
  '',
  '   ',
  'ok',
  'Ok.',
  'THANKS!',
  'why',
  'hi',
  'night',
  "you're welcome",
  'What theme should I use tonight?',
  'Ik ga zo slapen.',
  'Wat weet jij over Yassin?',
  'Oké, en wat weet je dan van Luca?',
  'Als het goed is, staat er wel wat in je geheugen.',
  'Kun je wel bij het geheugen?',
  'Herinner je je nog wat we zagen?',
  'What do you know about the migration plan?',
  'wat was er in juni ook alweer?',
  'weet je nog dat we dat besloten hadden?',
  'je zei eerder dat de server opnieuw startte',
  'ik vertelde je vorige week over dat besluit',
  'wat zei ik ook alweer over de migratie?',
  'wat staat er vastgelegd in foundation?',
  'wat we vorige maand besloten hebben',
  'doe even research naar de nieuwe database met bronnen',
  'de configuratie van de deployment klopt niet',
  'kun je dat uitleggen?',
  'nou, dat is mooi',
];

test('readTurn states the live recall gate for every shape', () => {
  for (const text of CORPUS) {
    assert.equal(
      readTurn(text).wantsRecall,
      shouldRecall(text),
      `recall gate disagrees for: ${JSON.stringify(text)}`
    );
  }
});

test('readTurn states the live pattern gate for every shape', () => {
  for (const text of CORPUS) {
    assert.equal(
      readTurn(text).topical,
      shouldAttemptPatternRetrieval(text, null),
      `pattern gate disagrees for: ${JSON.stringify(text)}`
    );
  }
});

test('stap 4: handing the shape down changes no gate answer', () => {
  // The live turn now reads the question once and passes that verdict to every
  // gate instead of letting each gate scan the text again. This is the guard
  // that the shortcut is exact: same answer, one reading.
  for (const text of CORPUS) {
    const shape = readTurn(text);
    assert.equal(
      shouldRecall(text, { shape }),
      shouldRecall(text),
      `recall gate differs when the shape is handed down: ${JSON.stringify(text)}`
    );
    assert.equal(
      shouldAttemptPatternRetrieval(text, null, shape),
      shouldAttemptPatternRetrieval(text, null),
      `pattern gate differs when the shape is handed down: ${JSON.stringify(text)}`
    );
  }
});

test('the 18-10-2026 memory questions open the gate and name their cue', () => {
  const questions = [
    'Wat weet jij over Yassin?',
    'Oké, en wat weet je dan van Luca?',
    'Als het goed is, staat er wel wat in je geheugen.',
    'Kun je wel bij het geheugen?',
    'Herinner je je nog wat we zagen?',
    'What do you know about the migration plan?',
  ];
  for (const text of questions) {
    const shape = readTurn(text);
    assert.equal(shape.wantsRecall, true, `gate shut for: ${JSON.stringify(text)}`);
    assert.equal(shape.trivial, false, `read as trivial: ${JSON.stringify(text)}`);
    assert.ok(shape.matched.includes('pastReference'), `cue not named for: ${JSON.stringify(text)}`);
  }
});

test('fillers and very short turns stay shut at every gate', () => {
  for (const text of ['ok', 'Ok.', 'THANKS!', 'why', 'hi', 'night']) {
    const shape = readTurn(text);
    assert.equal(shape.trivial, true, `not trivial: ${JSON.stringify(text)}`);
    assert.equal(shape.reflectable, false, `reflectable: ${JSON.stringify(text)}`);
    assert.equal(shape.wantsRecall, false, `recall open: ${JSON.stringify(text)}`);
    assert.equal(shape.topical, false, `topical: ${JSON.stringify(text)}`);
    assert.deepEqual(shape.matched, [], `matched something: ${JSON.stringify(text)}`);
  }
});

test('nothing said is stated as empty', () => {
  for (const text of ['', '   ', null, undefined]) {
    const shape = readTurn(text);
    assert.equal(shape.empty, true);
    assert.equal(shape.trivial, true);
    assert.equal(shape.wantsRecall, false);
    assert.equal(shape.topical, false);
    assert.equal(shape.reflectable, false);
  }
});

test('a substantive sentence is reflectable even when no gate opens', () => {
  const shape = readTurn('nou, dat is mooi');
  assert.equal(shape.reflectable, true);
  assert.equal(shape.wantsRecall, false);
});

test('the archive and Foundation shapes are named apart', () => {
  const archive = readTurn('wat zei ik ook alweer over de migratie?');
  assert.equal(archive.looksInArchive, true);
  assert.equal(archive.looksInRecords, false);

  const records = readTurn('wat staat er vastgelegd in foundation?');
  assert.equal(records.looksInRecords, true);

  const plain = readTurn('de configuratie van de deployment klopt niet');
  assert.equal(plain.looksInArchive, false);
  assert.equal(plain.looksInRecords, false);
});

test('routing skill shapes are reported, and only when they match', () => {
  const research = readTurn('doe even research naar de nieuwe database met bronnen');
  assert.deepEqual(research.skillTasks, ['grounded-citations']);
  assert.ok(research.matched.includes('skillTasks'));

  assert.deepEqual(readTurn('we praten over het weer').skillTasks, []);
});

test('logTurnShape writes one content-free line', () => {
  const lines = [];
  const shape = readTurn('Wat weet jij over Yassin?');
  const record = logTurnShape({ ...shape, traceId: 'trace-9', queryLength: 22 }, (line) => lines.push(line));

  assert.equal(lines.length, 1);
  assert.deepEqual(record, JSON.parse(lines[0]));
  assert.equal(record.kind, 'turn.shape');
  assert.equal(record.traceId, 'trace-9');
  assert.equal(record.wantsRecall, true);
  assert.equal(record.queryLength, 22);
  assert.equal(record.skillTasks.length, 0);
  // Never the user's text, never the words that matched.
  assert.equal(lines[0].includes('Yassin'), false);
  assert.equal(lines[0].includes('geheugen'), false);
});

test('logTurnShape defaults its counts instead of throwing', () => {
  const lines = [];
  const record = logTurnShape(readTurn('ok'), (line) => lines.push(line));
  assert.equal(record.traceId, null);
  assert.equal(record.queryLength, 0);
  assert.deepEqual(record.skillTasks, []);
  assert.deepEqual(record.matched, []);
});

test('the recall floor used by readTurn is the policy floor', () => {
  assert.equal(MEMORY_POLICY.minRecallLength, 12);
  const eleven = 'a'.repeat(MEMORY_POLICY.minRecallLength - 1);
  const twelve = 'a'.repeat(MEMORY_POLICY.minRecallLength);
  assert.equal(readTurn(eleven).trivial, true);
  assert.equal(readTurn(twelve).trivial, false);
});
