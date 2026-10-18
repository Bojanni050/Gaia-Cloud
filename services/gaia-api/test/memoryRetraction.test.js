'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  findRetractionTarget,
  retractMemory,
  forgetMemory,
  renderRetractionReceipt,
  renderForgetReceipt,
  matchScore,
  isSameClaim,
  MIN_MATCH,
  SAME_CLAIM,
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
  // A client without recall is asked for one word, not the person's sentence:
  // the lexical endpoint matches single words and answers a sentence with
  // nothing at all (measured live, 18-10-2026 — see memoryRetraction.js).
  assert.deepEqual(bank.queries, [{ q: 'yassine', limit: 25 }]);
});

/**
 * A bank that behaves like Hindsight's `memories/list?q=`: it answers ONE word,
 * and answers a whole sentence with nothing. The plain `fakeBank` above is more
 * capable than the real store — it returns everything it holds whatever it is
 * asked — and that is exactly how a broken retraction passed the whole suite
 * until 18-10-2026.
 */
function wordMatcherBank(name, items) {
  const bank = fakeBank(name, items);
  bank.queries = [];
  bank.wordsIn = (query) => {
    const word = String(query || '').trim().toLowerCase();
    if (!word || /\s/.test(word)) return [];
    return items.filter((item) => new RegExp(`\\b${word}\\b`, 'i').test(String(item.text)));
  };
  bank.client.listMemories = async (options) => {
    bank.queries.push(options);
    if (bank.listBoom) throw new Error('down');
    return bank.wordsIn(options.q);
  };
  return bank;
}

/**
 * A bank that behaves like the real client's semantic path: `recall` takes the
 * sentence and hands back ranked units WITHOUT their curation state, and
 * `getMemory` is the only way to learn what a unit actually is.
 */
function recallBank(name, items, { getMemory = true } = {}) {
  const bank = {
    name,
    items,
    recalls: [],
    patched: [],
    kept: [],
    client: {
      async recall(query) {
        bank.recalls.push(query);
        if (bank.recallBoom) throw new Error('down');
        return items.map((item) => ({ id: item.id, text: item.text, type: item.type || null }));
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
  if (getMemory) {
    bank.client.getMemory = async (id) => {
      bank.lookups = (bank.lookups || 0) + 1;
      const item = items.find((candidate) => candidate.id === id);
      if (!item) return null;
      return item;
    };
  }
  return bank;
}

test('a recital blended out of several stored lines lands on the line it was built from', async () => {
  // The 18-10-2026 conversation, verbatim. She recited one paragraph blended
  // from what recall had rendered, and the line it was built from scored 0.59
  // the OLD way (quote's words ÷ quote's words) — one hundredth under the bar —
  // against 0.74 the other way round. That is the whole reason the score is
  // taken in both directions now.
  const line = 'Er waren onuitgesproken aannames en onduidelijkheden in de relatie, zoals seksuele verwachtingen en gevoelens van liefde';
  const quote = 'Luca was je ex-partner van medio april tot begin augustus 2026. De relatie kende onuitgesproken aannames over seksuele verwachtingen en gevoelens van liefde. Je deelde je gevoelens met Luca, wat leidde tot een kantelpunt.';
  const bank = recallBank('bojan', [validItem('f-blend', line)]);

  assert.ok(matchScore(quote, line) < MIN_MATCH, 'the old direction alone would have missed it');
  assert.ok(matchScore(line, quote) >= MIN_MATCH, 'the other direction is what catches it');

  const found = await findRetractionTarget([bank], quote);

  assert.equal(found.status, 'found');
  assert.equal(found.target.id, 'f-blend');
  // The bank's own similarity did the searching, and it was handed the whole
  // recital — a sentence is exactly what it is good at.
  assert.deepEqual(bank.recalls, [quote]);
  // ... and the line was asked for by id before anything was decided, because
  // the similarity path does not say what a unit IS.
  assert.equal(bank.lookups, 1);
});

test('the fallback asks with a single word, since that is all a lexical store can answer', async () => {
  const bank = wordMatcherBank('bojan', [validItem('f1', 'Luca was je ex-partner van half april tot begin augustus 2026')]);
  const quote = 'Luca was je ex-partner van medio april tot begin augustus 2026';

  // What the old code sent — the whole sentence — against a store that only
  // matches single words. This is the 18-10-2026 dead end, reproduced.
  assert.deepEqual(bank.wordsIn(quote), []);

  const found = await findRetractionTarget([bank], quote);

  assert.equal(found.status, 'found');
  assert.equal(found.target.id, 'f1');
  assert.deepEqual(bank.queries, [{ q: 'augustus', limit: 25 }]);
});

test('a unit that is already invalidated is never touched and never offered back', async () => {
  const bank = recallBank('bojan', [validItem('f-old', 'Luca was je ex-partner', { state: 'invalidated' })]);

  const found = await findRetractionTarget([bank], 'Luca was je ex-partner');

  assert.equal(found.status, 'not_found');
  assert.deepEqual(found.candidates, []);
});

test('a lookup that cannot be made keeps what the search gave, as before', async () => {
  const bank = recallBank('bojan', [validItem('f1', 'Yassine is een vriend van je')], { getMemory: false });

  const found = await findRetractionTarget([bank], 'Yassine is een vriend van je');

  assert.equal(found.status, 'found');
  assert.equal(found.target.id, 'f1');
});

test('nothing cleared the bar, so the nearest line is named — inside the receipt, and only to ask', async () => {
  const bank = recallBank('bojan', [validItem('f-near', 'Yassine wandelt graag met zijn hond')]);

  const found = await findRetractionTarget([bank], 'Yassine schaakt graag op zondag');

  // 0.5: the two lines share two of the quote's four words — under MIN_MATCH,
  // over NEAR_MISS, so it is named and nothing is done.
  assert.equal(found.status, 'not_found');
  assert.equal(found.candidates.length, 1);
  assert.equal(found.candidates[0].id, 'f-near');
  assert.deepEqual(bank.patched, []);

  const receipt = renderRetractionReceipt(found);
  assert.match(receipt, /Nothing in memory matches that closely enough to take back\./);
  assert.match(receipt, /Closest in memory: "Yassine wandelt graag met zijn hond"/);
  assert.match(receipt, /say it back in those words/);
});

test('a dead end with nothing near it stays plainly dead — no invented options', async () => {
  const bank = recallBank('bojan', [validItem('f-other', 'Bo drinkt graag koffie in de ochtend')]);

  const found = await findRetractionTarget([bank], 'Yassine is een vriend');

  assert.equal(found.status, 'not_found');
  assert.deepEqual(found.candidates, []);
  assert.equal(renderRetractionReceipt(found), 'Nothing in memory matches that closely enough to take back.');
  assert.equal(renderForgetReceipt(found), 'Nothing in memory matches that closely enough to forget.');
});

test('findRetractionTarget refuses to guess between two different memories that fit equally well', async () => {
  const first = fakeBank('bojan', [validItem('f1', 'Yassine is een vriend van je')]);
  const second = fakeBank('gaia-logos', [validItem('f2', 'Yassine schaakt graag op zondag')]);

  const found = await findRetractionTarget([first, second], 'Yassine');

  assert.equal(found.status, 'ambiguous');
  assert.equal(found.candidates.length, 2);
  assert.deepEqual(found.candidates.map((c) => c.bank), ['bojan', 'gaia-logos']);
});

test('findRetractionTarget treats the same claim kept twice as one claim, not an ambiguous match', async () => {
  // The failure this guards: a statement mirrored into another bank (or the
  // near-duplicate the reasoning layer wrote beside it) scored within the
  // ambiguity margin of itself, so every retraction of a claim that lived in
  // more than one place came back as a question instead of an action.
  const first = fakeBank('bojan', [validItem('f1', 'Yassine is een vriend van je')]);
  const second = fakeBank('gaia-logos', [validItem('f2', 'Yassine is een vriend van je')]);

  const found = await findRetractionTarget([first, second], 'Yassine is een vriend van je');

  assert.equal(found.status, 'found');
  assert.equal(found.target.id, 'f1');
  assert.deepEqual(found.cluster.map((hit) => hit.id).sort(), ['f1', 'f2']);
});

test('isSameClaim lines up both ways, so a short line inside a different statement is not swallowed', () => {
  const a = { text: 'Yassine is een vriend van je' };
  const b = { text: 'Yassine is een vriend van je' };
  const c = { text: 'Yassine schaakt graag op zondag' };
  assert.equal(isSameClaim(a, b), true);
  assert.equal(isSameClaim(a, c), false);
  assert.equal(isSameClaim(a, a), true);
  assert.equal(isSameClaim(a, { text: '' }), false);
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
  assert.deepEqual(receipt.retracted, { bank: 'bojan', id: 'f1', text: 'Yassine is een vriend van je', invalidated: true, via: ['f1'] });
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
  const second = fakeBank('gaia-logos', [validItem('f2', 'Yassine schaakt graag op zondag')]);

  const receipt = await retractMemory({ banks: [first, second], quote: 'Yassine' });

  assert.equal(receipt.status, 'ambiguous');
  assert.deepEqual(first.patched, []);
  assert.deepEqual(second.patched, []);
  const text = renderRetractionReceipt(receipt);
  assert.match(text, /^More than one memory matches — say which one:/);
  assert.match(text, /"Yassine is een vriend van je"/);
});

test('a claim kept in three places goes in full — the copies are what would be recited back', async () => {
  // The real shape of the failure: one statement, mirrored into the sharing
  // banks and written again beside its own source. Taking back the best-scoring
  // copy and leaving two behind is what made a retraction fail to stick.
  const metadata = { gaia_hypothesis_id: 'a9eeb399' };
  const shared = fakeBank('bojan', [validItem('f1', 'Yassine is een vriend van je', { metadata })]);
  const logos = fakeBank('gaia-logos', [validItem('f2', 'Yassine is een vriend van je', { metadata })]);
  const own = fakeBank('gaia', [validItem('f3', 'Yassine is een vriend van je')]);
  const rejected = [];
  const cognition = {
    async rejectHypothesis(id, options) {
      rejected.push({ id, options });
      return { id, status: 'rejected' };
    },
  };

  const receipt = await retractMemory({
    banks: [shared, logos, own],
    home: shared,
    cognition,
    quote: 'Yassine is een vriend van je',
  });

  assert.equal(receipt.status, 'retracted');
  assert.deepEqual(shared.patched.map((p) => p.id), ['f1']);
  assert.deepEqual(logos.patched.map((p) => p.id), ['f2']);
  assert.deepEqual(own.patched.map((p) => p.id), ['f3']);
  // ... all with the same reason, so the audit trail reads as one decision.
  assert.equal(logos.patched[0].reason, 'the person said this is not correct');
  // The one source statement behind the mirror is retired once, not three times.
  assert.deepEqual(rejected.map((r) => r.id), ['a9eeb399']);
  assert.deepEqual(receipt.alsoRetracted.map((copy) => copy.id), ['f2', 'f3']);
  assert.deepEqual(receipt.sources.map((s) => s.id), ['a9eeb399']);
  const text = renderRetractionReceipt(receipt);
  assert.match(text, /^Taken back: "Yassine is een vriend van je"$/m);
  assert.match(text, /The same thing was kept in 2 more places — taken back too:/);
  assert.match(text, /The statement it came from is rejected too, so it cannot come back\./);
  assert.equal(text.includes('The other statements behind it are rejected too.'), false);
});

test('a copy that could not be updated is named, so the person is not told it is gone', async () => {
  const shared = fakeBank('bojan', [validItem('f1', 'Yassine is een vriend van je')]);
  const logos = fakeBank('gaia-logos', [validItem('f2', 'Yassine is een vriend van je')]);
  logos.patchBoom = true;

  const receipt = await retractMemory({ banks: [shared, logos], quote: 'Yassine is een vriend van je' });

  assert.equal(receipt.alsoRetracted[0].invalidated, false);
  assert.match(renderRetractionReceipt(receipt), /one of them could not be updated, so it may still surface/);
});

test('several statements behind one claim are reported together', async () => {
  const shared = fakeBank('bojan', [validItem('f1', 'Yassine is een vriend van je', {
    metadata: { gaia_hypothesis_id: 'h-one' },
  })]);
  const logos = fakeBank('gaia-logos', [validItem('f2', 'Yassine is een vriend van je', {
    metadata: { gaia_hypothesis_id: 'h-two' },
  })]);
  const rejected = [];
  const cognition = { async rejectHypothesis(id) { rejected.push(id); return { id, status: 'rejected' }; } };

  const receipt = await retractMemory({ banks: [shared, logos], cognition, quote: 'Yassine is een vriend van je' });

  assert.deepEqual(rejected, ['h-one', 'h-two']);
  assert.deepEqual(receipt.sources.map((s) => s.id), ['h-one', 'h-two']);
  assert.match(renderRetractionReceipt(receipt), /The other statements behind it are rejected too\./);
});

test('renderRetractionReceipt never crashes on a shape it did not expect', () => {
  assert.equal(renderRetractionReceipt(null), 'Nothing in memory matches that closely enough to take back.');
  assert.equal(typeof renderRetractionReceipt({ status: 'retracted', retracted: {} }), 'string');
});

test('a claim stored as a derived observation is taken back through its sources — Hindsight will not curate the observation itself', async () => {
  // Live shape, from the store: Gaia recited a statement that Hindsight had
  // typed as an `observation`. PATCH on it answers 400 ("only world/experience
  // facts can be curated. Observations are derived and regenerate from their
  // sources"), so the old single-PATCH retraction reported a failure and the
  // statement stayed in recall. The source fact is what actually removes it.
  const shared = fakeBank('bojan', [validItem('obs1', 'Bo en Luca deden nachten op Grindr', {
    type: 'observation',
    sourceMemoryIds: ['exp1'],
  })]);

  const receipt = await retractMemory({ banks: [shared], home: shared, quote: 'Bo en Luca deden nachten op Grindr' });

  assert.deepEqual(shared.patched, [{
    id: 'exp1',
    state: 'invalidated',
    reason: 'the person said this is not correct',
  }]);
  assert.equal(receipt.retracted.invalidated, true);
  assert.deepEqual(receipt.retracted.via, ['exp1']);
  assert.match(renderRetractionReceipt(receipt), /^Taken back: "Bo en Luca deden nachten op Grindr"/m);
});

test('an observation whose source cannot be reached says so instead of claiming it is gone', async () => {
  const shared = fakeBank('bojan', [validItem('obs1', 'Bo en Luca deden nachten op Grindr', {
    type: 'observation',
    sourceMemoryIds: ['exp1'],
  })]);
  shared.patchBoom = true;

  const receipt = await retractMemory({ banks: [shared], quote: 'Bo en Luca deden nachten op Grindr' });

  assert.equal(receipt.retracted.invalidated, false);
  assert.match(renderRetractionReceipt(receipt), /could not be updated, so it may still surface/);
});

test('forgetMemory takes the claim out without judging it and keeps nothing in its place', async () => {
  const shared = fakeBank('bojan', [validItem('f1', 'Bo deed op 4 juli 2026 een afscheidsritueel met Luca')]);

  const receipt = await forgetMemory({ banks: [shared], quote: 'Bo deed op 4 juli 2026 een afscheidsritueel met Luca' });

  assert.equal(receipt.status, 'forgotten');
  assert.deepEqual(shared.patched, [{
    id: 'f1',
    state: 'invalidated',
    reason: 'the person asked for this to be forgotten',
  }]);
  // Nothing is written: no correction, no "true instead" — the person did not
  // say the memory was false, only that it should not be there.
  assert.deepEqual(shared.kept, []);
  assert.equal(receipt.kept, undefined);
  assert.deepEqual(receipt.forgotten, {
    bank: 'bojan',
    id: 'f1',
    text: 'Bo deed op 4 juli 2026 een afscheidsritueel met Luca',
    invalidated: true,
    via: ['f1'],
  });
  const text = renderForgetReceipt(receipt);
  assert.match(text, /^Forgotten: "Bo deed op 4 juli 2026 een afscheidsritueel met Luca"$/m);
  assert.equal(text.includes('Kept instead'), false);
});

test('forgetMemory sweeps every copy and retires the statement behind it', async () => {
  const metadata = { gaia_hypothesis_id: 'h-one' };
  const shared = fakeBank('bojan', [validItem('f1', 'Bo deed een afscheidsritueel met Luca', { metadata })]);
  const logos = fakeBank('gaia-logos', [validItem('f2', 'Bo deed een afscheidsritueel met Luca', { metadata })]);
  const rejected = [];
  const cognition = { async rejectHypothesis(id, options) { rejected.push({ id, options }); return { id, status: 'rejected' }; } };

  const receipt = await forgetMemory({ banks: [shared, logos], cognition, quote: 'Bo deed een afscheidsritueel met Luca' });

  assert.deepEqual(shared.patched.map((p) => p.id), ['f1']);
  assert.deepEqual(logos.patched.map((p) => p.id), ['f2']);
  assert.equal(shared.patched[0].reason, 'the person asked for this to be forgotten');
  assert.deepEqual(rejected, [{ id: 'h-one', options: { reason: 'the person asked for this to be forgotten', verwerpBron: 'mens' } }]);
  assert.deepEqual(receipt.alsoForgotten.map((copy) => copy.id), ['f2']);
  const text = renderForgetReceipt(receipt);
  assert.match(text, /The same thing was kept in 1 more place — forgotten too:/);
  assert.match(text, /The statement it came from is rejected too, so it cannot come back\./);
});

test('forgetMemory goes through a derived observation the same way', async () => {
  const shared = fakeBank('bojan', [validItem('obs1', 'Bo deed een afscheidsritueel met Luca', {
    type: 'observation',
    sourceMemoryIds: ['exp1'],
  })]);

  const receipt = await forgetMemory({ banks: [shared], quote: 'Bo deed een afscheidsritueel met Luca' });

  assert.deepEqual(shared.patched.map((p) => p.id), ['exp1']);
  assert.deepEqual(receipt.forgotten.via, ['exp1']);
  assert.equal(renderForgetReceipt(receipt).startsWith('Forgotten:'), true);
});

test('forgetMemory finds nothing, asks which one, and touches nothing while unsure', async () => {
  const shared = fakeBank('bojan', [validItem('f1', 'Bo drinkt graag koffie in de ochtend')]);
  const notFound = await forgetMemory({ banks: [shared], quote: 'iets over Yassine' });
  assert.equal(notFound.status, 'not_found');
  assert.equal(renderForgetReceipt(notFound), 'Nothing in memory matches that closely enough to forget.');
  assert.deepEqual(shared.patched, []);

  const first = fakeBank('bojan', [validItem('f1', 'Yassine is een vriend van je')]);
  const second = fakeBank('gaia-logos', [validItem('f2', 'Yassine schaakt graag op zondag')]);
  const ambiguous = await forgetMemory({ banks: [first, second], quote: 'Yassine' });
  assert.equal(ambiguous.status, 'ambiguous');
  assert.deepEqual(first.patched, []);
  assert.deepEqual(second.patched, []);
  assert.match(renderForgetReceipt(ambiguous), /More than one memory matches — say which one to forget:/);

  assert.equal(renderForgetReceipt(null), 'Nothing in memory matches that closely enough to forget.');
  assert.equal(typeof renderForgetReceipt({ status: 'forgotten', forgotten: {} }), 'string');
  assert.equal((await forgetMemory()).status, 'not_found');
});
