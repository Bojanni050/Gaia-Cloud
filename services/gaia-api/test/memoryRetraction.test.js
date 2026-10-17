'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  findRetractionTarget,
  retractMemory,
  renderRetractionReceipt,
  matchScore,
  MIN_MATCH,
} = require('../src/reasoning/memoryRetraction');

/**
 * A bank client with just the three verbs retraction uses, recording what was
 * asked of it. `listMemories` returns the caller's items; each of the three can
 * be made to fail independently, because the module promises that one failing
 * step never blocks the others.
 */
function fakeBank(name, items) {
  const bank = {
    name,
    items,
    patched: [],
    kept: [],
    queries: [],
    client: {
      async listMemories(options) {
        bank.queries.push(options);
        if (bank.listBoom) throw new Error('down');
        return bank.items;
      },
      async patchMemoryState(id, state, reason) {
        if (bank.patchBoom) throw new Error('down');
        bank.patched.push({ id, state, reason });
      },
      async retainSync(payload) {
        if (bank.keepBoom) throw new Error('down');
        bank.kept.push(payload);
      },
    },
  };
  return bank;
}

function validItem(id, text, extra = {}) {
  return { id, text, state: 'valid', ...extra };
}

test('matchScore: containment is a full match, overlap is a fraction, nothing is zero', () => {
  assert.equal(matchScore('Yassine is een vriend', 'Yassine is een vriend van je'), 1);
  assert.equal(matchScore('yassine is EEN VRIEND', 'Yassine is een vriend van je'), 1);
  assert.equal(matchScore('Yassine vriend', 'Yassine is een vriend van je'), 1);
  assert.equal(matchScore('Yassine schaakt graag', 'Yassine is een vriend van je'), 1 / 3);
  assert.equal(matchScore('Yassine', ''), 0);
  assert.equal(matchScore('', 'Yassine is een vriend'), 0);
  assert.equal(matchScore('iets heel anders', 'Yassine is een vriend'), 0);
});

test('findRetractionTarget skips what is already invalidated, and what does not match', async () => {
  const bank = fakeBank('bojan', [
    validItem('f-old', 'Yassine is een vriend van je', { state: 'invalidated' }),
    validItem('f-other', 'Bo drinkt graag koffie in de ochtend'),
  ]);

  const found = await findRetractionTarget([bank], 'Yassine is een vriend van je');

  assert.equal(found.status, 'not_found');
  assert.deepEqual(found.candidates, []);
  // The query is the person's own words — the bank does the searching.
  assert.deepEqual(bank.queries, [{ q: 'Yassine is een vriend van je', limit: 25 }]);
});

test('findRetractionTarget refuses to guess between two equally good matches', async () => {
  const first = fakeBank('bojan', [validItem('f1', 'Yassine is een vriend van je')]);
  const second = fakeBank('gaia-logos', [validItem('f2', 'Yassine is een vriend van je')]);

  const found = await findRetractionTarget([first, second], 'Yassine is een vriend van je');

  assert.equal(found.status, 'ambiguous');
  assert.equal(found.candidates.length, 2);
  assert.deepEqual(found.candidates.map((c) => c.bank), ['bojan', 'gaia-logos']);
});

test('findRetractionTarget carries the winning bank, so the caller knows where to patch', async () => {
  const shared = fakeBank('bojan', [validItem('f1', 'Bo werkt aan Gaia')]);
  const own = fakeBank('gaia', [validItem('f2', 'Iets heel anders over koffie')]);

  const found = await findRetractionTarget([shared, own], 'Bo werkt aan Gaia');

  assert.equal(found.status, 'found');
  assert.equal(found.target.bank, 'bojan');
  assert.equal(found.target.id, 'f1');
  assert.equal(found.target.score, 1);
});

test('a bank that is down drops only its slice', async () => {
  const broken = fakeBank('gaia-logos', []);
  broken.listBoom = true;
  const shared = fakeBank('bojan', [validItem('f1', 'Bo werkt aan Gaia')]);

  const found = await findRetractionTarget([broken, shared], 'Bo werkt aan Gaia');

  assert.equal(found.status, 'found');
  assert.equal(found.target.id, 'f1');
});

test('retractMemory invalidates the memory in the bank that holds it, and says which one', async () => {
  const shared = fakeBank('bojan', [validItem('f1', 'Yassine is een vriend van je')]);

  const receipt = await retractMemory({ banks: [shared], home: shared, quote: 'Yassine is een vriend van je' });

  assert.equal(receipt.status, 'retracted');
  assert.deepEqual(receipt.retracted, { bank: 'bojan', id: 'f1', text: 'Yassine is een vriend van je', invalidated: true });
  assert.deepEqual(shared.patched, [{
    id: 'f1',
    state: 'invalidated',
    reason: 'the person said this is not correct',
  }]);
  assert.equal(receipt.source, null);
  assert.equal(receipt.kept, null);

  const text = renderRetractionReceipt(receipt);
  assert.match(text, /^Taken back: "Yassine is een vriend van je"$/m);
});

test('a memory that came from a hypothesis retires the statement too — the source is what would resurrect it', async () => {
  const shared = fakeBank('bojan', [validItem('f1', 'Yassine is een vriend van je', {
    metadata: { gaia_hypothesis_id: 'a9eeb399', gaia_hypothesis_version: '1', gaia_hypothesis_status: 'confirmed' },
    tags: ['gaia:hypothesis', 'gaia:confirmed_fact'],
  })]);
  const rejected = [];
  const mirrored = [];
  const cognition = {
    async rejectHypothesis(id, options) {
      rejected.push({ id, options });
      return { id, status: 'rejected', statement: 'Yassine is een vriend van je' };
    },
  };
  const sync = { async syncHypothesis(record) { mirrored.push(record); } };

  const receipt = await retractMemory({ banks: [shared], home: shared, cognition, sync, quote: 'Yassine is een vriend van je' });

  assert.deepEqual(rejected, [{
    id: 'a9eeb399',
    options: { reason: 'the person said this is not correct', verwerpBron: 'mens' },
  }]);
  assert.deepEqual(mirrored.map((record) => record.id), ['a9eeb399']);
  assert.deepEqual(receipt.source, { kind: 'hypothesis', id: 'a9eeb399', status: 'rejected' });
  assert.match(renderRetractionReceipt(receipt), /The statement it came from is rejected too, so it cannot come back\./);
});

test('metadata that arrives as a JSON string is read the same way', async () => {
  const shared = fakeBank('bojan', [validItem('f1', 'Yassine is een vriend van je', {
    metadata: JSON.stringify({ gaia_hypothesis_id: 'a9eeb399' }),
  })]);
  const rejected = [];
  const cognition = { async rejectHypothesis(id) { rejected.push(id); return { id, status: 'rejected' }; } };

  const receipt = await retractMemory({ banks: [shared], cognition, quote: 'Yassine is een vriend van je' });

  assert.deepEqual(rejected, ['a9eeb399']);
  assert.equal(receipt.source.status, 'rejected');
});

test('without a Cognition client, the memory still goes and the gap is reported honestly', async () => {
  const shared = fakeBank('bojan', [validItem('f1', 'Yassine is een vriend van je', {
    metadata: { gaia_hypothesis_id: 'a9eeb399' },
  })]);

  const receipt = await retractMemory({ banks: [shared], quote: 'Yassine is een vriend van je' });

  assert.equal(receipt.retracted.invalidated, true);
  assert.deepEqual(receipt.source, { kind: 'hypothesis', id: 'a9eeb399', status: 'unavailable' });
  assert.match(renderRetractionReceipt(receipt), /not reachable right now — it may come back\./);
});

test('the person\'s own correction is kept as theirs, tagged and traceable to what it replaced', async () => {
  const shared = fakeBank('bojan', [validItem('f1', 'Yassine is een vriend van je')]);
  const now = Date.parse('2026-10-17T18:42:00Z');

  const receipt = await retractMemory({
    banks: [shared],
    home: shared,
    quote: 'Yassine is een vriend van je',
    correction: '  Yassine is een collega, geen vriend  ',
    now,
  });

  assert.deepEqual(shared.patched[0].reason, 'the person corrected this: Yassine is een collega, geen vriend');
  assert.equal(shared.kept.length, 1);
  assert.equal(shared.kept[0].content, 'Yassine is een collega, geen vriend');
  assert.equal(shared.kept[0].context, 'corrected in conversation');
  assert.deepEqual(shared.kept[0].tags, ['gaia:confirmed_fact', 'gaia:correction']);
  assert.equal(shared.kept[0].metadata.gaia_corrected_from, 'f1');
  assert.equal(shared.kept[0].metadata.gaia_corrected_bank, 'bojan');
  assert.equal(shared.kept[0].metadata.gaia_corrected_at, '2026-10-17T18:42:00.000Z');
  assert.deepEqual(receipt.kept, { bank: 'bojan', text: 'Yassine is een collega, geen vriend' });
  assert.match(renderRetractionReceipt(receipt), /Kept instead: "Yassine is een collega, geen vriend"/);
});

test('a correction with nowhere to keep it is not kept, and does not undo the retraction', async () => {
  const shared = fakeBank('bojan', [validItem('f1', 'Yassine is een vriend van je')]);
  delete shared.client.retainSync;

  const receipt = await retractMemory({ banks: [shared], quote: 'Yassine is een vriend van je', correction: 'Yassine is een collega' });

  assert.equal(receipt.retracted.invalidated, true);
  assert.equal(receipt.kept, null);
  assert.equal(renderRetractionReceipt(receipt).includes('Kept instead'), false);
});

test('each failing step is reported, never thrown — and the rest still happens', async () => {
  const shared = fakeBank('bojan', [validItem('f1', 'Yassine is een vriend van je', {
    metadata: { gaia_hypothesis_id: 'a9eeb399' },
  })]);
  shared.patchBoom = true;
  shared.keepBoom = true;
  const cognition = { async rejectHypothesis() { throw new Error('cognition down'); } };
  const sync = { async syncHypothesis() {} };

  const receipt = await retractMemory({
    banks: [shared],
    home: shared,
    cognition,
    sync,
    quote: 'Yassine is een vriend van je',
    correction: 'Yassine is een collega',
  });

  assert.equal(receipt.retracted.invalidated, false);
  assert.equal(receipt.source.status, 'unchanged');
  assert.equal(receipt.kept, null);
  const text = renderRetractionReceipt(receipt);
  assert.match(text, /the memory itself could not be updated, so it may still surface/);
  assert.match(text, /could not be rejected — it may come back\./);
});

test('a mirror that cannot be reached does not undo the rejection', async () => {
  const shared = fakeBank('bojan', [validItem('f1', 'Yassine is een vriend van je', {
    metadata: { gaia_hypothesis_id: 'a9eeb399' },
  })]);
  const cognition = { async rejectHypothesis(id) { return { id, status: 'rejected' }; } };
  const sync = { async syncHypothesis() { throw new Error('mirror down'); } };

  const receipt = await retractMemory({ banks: [shared], cognition, sync, quote: 'Yassine is een vriend van je' });

  assert.equal(receipt.source.status, 'rejected');
});

test('nothing found and nothing named are calm, and nothing is touched', async () => {
  const shared = fakeBank('bojan', [validItem('f1', 'Bo drinkt graag koffie in de ochtend')]);

  const notFound = await retractMemory({ banks: [shared], quote: 'Yassine is een vriend van je' });
  assert.equal(notFound.status, 'not_found');
  assert.equal(renderRetractionReceipt(notFound), 'Nothing in memory matches that closely enough to take back.');

  const nothing = await retractMemory({ quote: '   ' });
  assert.equal(nothing.status, 'not_found');

  const defaults = await retractMemory();
  assert.equal(defaults.status, 'not_found');

  assert.deepEqual(shared.patched, []);
  assert.equal(MIN_MATCH > 0, true);
});

test('an ambiguous match patches nothing at all — a wrong retraction is worse than none', async () => {
  const first = fakeBank('bojan', [validItem('f1', 'Yassine is een vriend van je')]);
  const second = fakeBank('gaia-logos', [validItem('f2', 'Yassine is een vriend van je')]);

  const receipt = await retractMemory({ banks: [first, second], quote: 'Yassine is een vriend van je' });

  assert.equal(receipt.status, 'ambiguous');
  assert.deepEqual(first.patched, []);
  assert.deepEqual(second.patched, []);
  const text = renderRetractionReceipt(receipt);
  assert.match(text, /^More than one memory matches — say which one:/);
  assert.match(text, /"Yassine is een vriend van je"/);
});

test('renderRetractionReceipt never crashes on a shape it did not expect', () => {
  assert.equal(renderRetractionReceipt(null), 'Nothing in memory matches that closely enough to take back.');
  assert.equal(typeof renderRetractionReceipt({ status: 'retracted', retracted: {} }), 'string');
});
