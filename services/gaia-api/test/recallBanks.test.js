const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SERVER = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
const TURN = fs.readFileSync(path.join(__dirname, '..', 'src', 'turn.js'), 'utf8');

// Bo's rule, 18-10-2026: "van de 9 moeten er 9 uit de bojan bank komen". The
// nine lines a turn may read belong to his own bank; her own bank joins only
// when the turn asks about her, and the derived bank takes no lines of its own.
// These are source guards because the rule lives in the wiring itself — a
// silent widening back to three banks would be invisible in any unit under it.
test('the passive recall reads Bo\'s own bank, and only that bank', () => {
  assert.match(SERVER, /const hindsightPassive = createCrossBankRecallClient\(hindsightApp\);/);
});

test('her own bank joins on a turn that asks about her, next to his', () => {
  assert.match(SERVER, /const hindsightSelf = hindsightOwn/);
  assert.match(SERVER, /createCrossBankRecallClient\(hindsightApp, hindsightOwn\)/);
});

test('the derived bank no longer fills recall lines of its own', () => {
  assert.ok(!/hindsightPassive = createCrossBankRecallClient\([^)]*hindsightLogos/.test(SERVER));
  assert.ok(!/hindsightSelf = createCrossBankRecallClient\([^)]*hindsightLogos/.test(SERVER));
});

test('the turn picks the narrow client, and falls back for callers without one', () => {
  assert.match(TURN, /shape\.asksAboutHer \? \(recallHindsightSelf \|\| hindsight\) : \(recallHindsight \|\| hindsight\)/);
});

test('both turn entry points carry the two clients', () => {
  const passive = SERVER.split('hindsightPassive,').length - 1;
  assert.ok(passive >= 2, `hindsightPassive handed over ${passive} time(s)`);
  const self = SERVER.split('hindsightSelf,').length - 1;
  assert.ok(self >= 2, `hindsightSelf handed over ${self} time(s)`);
});
