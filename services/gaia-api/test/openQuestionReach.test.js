'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  readReachPolicy,
  conversationSource,
  fromQuestionRow,
  canRaise,
  fromConversation,
  pickOpenQuestion,
  renderOpenQuestionRaise,
  DEFAULT_RETRY_DAYS,
  DEFAULT_MAX_RAISES,
} = require('../src/reasoning/openQuestionReach');

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days) => new Date(Date.now() - days * DAY_MS).toISOString();

function question(overrides = {}) {
  return {
    id: 'q-1',
    statement: 'Weet Bo al of de distributie via een label moet lopen?',
    kind: 'open_question',
    questionShape: 'yes_no',
    questionOptions: [],
    sources: [],
    raisedCount: 0,
    raisedAt: null,
    answeredAt: null,
    ...overrides,
  };
}

// --- the policy ---------------------------------------------------------------

test('policy: the retry term and the hard maximum come from the environment', () => {
  assert.deepEqual(readReachPolicy({}), { retryDays: DEFAULT_RETRY_DAYS, maxRaises: DEFAULT_MAX_RAISES });
  assert.equal(DEFAULT_RETRY_DAYS, 7);
  assert.equal(DEFAULT_MAX_RAISES, 3);
  assert.deepEqual(readReachPolicy({ GAIA_OPEN_QUESTION_RETRY_DAYS: '2', GAIA_OPEN_QUESTION_MAX: '5' }), { retryDays: 2, maxRaises: 5 });
  // Nonsense falls back rather than inventing a policy.
  assert.deepEqual(readReachPolicy({ GAIA_OPEN_QUESTION_RETRY_DAYS: 'veel', GAIA_OPEN_QUESTION_MAX: '0' }), { retryDays: DEFAULT_RETRY_DAYS, maxRaises: DEFAULT_MAX_RAISES });
});

// --- the store row ------------------------------------------------------------

test('row: a Cognition row becomes the shape the decision reads', () => {
  const q = fromQuestionRow({
    id: 'q-9',
    statement: 'Iets',
    kind: 'open_question',
    question_shape: 'choice',
    question_options: ['a', 'b'],
    sources: ['conversation:c-3'],
    raised_count: 2,
    raised_at: '2026-10-01T00:00:00.000Z',
    answered_at: null,
  });
  assert.equal(q.id, 'q-9');
  assert.equal(q.questionShape, 'choice');
  assert.deepEqual(q.questionOptions, ['a', 'b']);
  assert.deepEqual(q.sources, ['conversation:c-3']);
  assert.equal(q.raisedCount, 2);
  assert.equal(q.raisedAt, '2026-10-01T00:00:00.000Z');
  assert.equal(q.answeredAt, null);
  // A bare row degrades to sane defaults instead of throwing.
  const bare = fromQuestionRow({ id: 'q-10', statement: 'x' });
  assert.equal(bare.raisedCount, 0);
  assert.equal(bare.raisedAt, null);
  assert.deepEqual(bare.sources, []);
});

// --- the gate -----------------------------------------------------------------

test('gate: never twice in a row, never more than three times, never once answered', () => {
  const policy = { retryDays: 7, maxRaises: 3 };
  // Never raised: allowed.
  assert.equal(canRaise(question(), policy, Date.now()), true);
  // Answered: the person already closed it.
  assert.equal(canRaise(question({ answeredAt: daysAgo(1) }), policy, Date.now()), false);
  // Raised yesterday: too soon.
  assert.equal(canRaise(question({ raisedCount: 1, raisedAt: daysAgo(1) }), policy, Date.now()), false);
  // Raised eight days ago: allowed again.
  assert.equal(canRaise(question({ raisedCount: 1, raisedAt: daysAgo(8) }), policy, Date.now()), true);
  // Three times is the hard maximum, however long ago.
  assert.equal(canRaise(question({ raisedCount: 3, raisedAt: daysAgo(90) }), policy, Date.now()), false);
  // A missing timestamp on a previously raised question counts as a raise, not
  // as a free pass.
  assert.equal(canRaise(question({ raisedCount: 1, raisedAt: null }), policy, Date.now()), false);
});

// --- picking ------------------------------------------------------------------

test('pick: one question at most, its own conversation first, and elsewhere only when it is about the same thing', () => {
  const policy = { retryDays: 7, maxRaises: 3 };
  const elsewhere = question({
    id: 'q-a',
    statement: 'Weet Bo al of de distributie via een label moet lopen?',
    sources: ['conversation:c-other'],
  });
  const here = question({ id: 'q-b', statement: 'B', sources: [conversationSource('c-1')] });

  // Its own conversation wins, even when the other one happens to be about the
  // same thing.
  const picked = pickOpenQuestion([elsewhere, here], {
    conversationId: 'c-1', policy, now: Date.now(), turnText: 'distributie via een label',
  });
  assert.equal(picked.id, 'q-b');

  // From another conversation it may come back only when it is about what is
  // being talked about right now: a new conversation about the same subject,
  // never a question out of the blue.
  assert.equal(pickOpenQuestion([elsewhere], {
    conversationId: 'c-2', policy, now: Date.now(), turnText: 'Ik zit te denken over de distributie naar Spotify.',
  }).id, 'q-a');
  assert.equal(pickOpenQuestion([elsewhere], {
    conversationId: 'c-2', policy, now: Date.now(), turnText: 'Morgen ga ik de keuken schilderen.',
  }), null);

  // A question without provenance — anything kept before provenance existed —
  // is never raised by this path, however close its wording. It stays visible
  // and answerable in the begrip panel.
  assert.equal(pickOpenQuestion([question({ statement: 'distributie via een label', sources: [] })], {
    conversationId: 'c-2', policy, now: Date.now(), turnText: 'distributie via een label',
  }), null);

  // Nothing allowed means nothing is said.
  assert.equal(pickOpenQuestion([question({ answeredAt: daysAgo(1) })], { conversationId: 'c-1', policy, now: Date.now() }), null);
  assert.equal(pickOpenQuestion([], { conversationId: 'c-1', policy, now: Date.now() }), null);
  assert.equal(pickOpenQuestion(null, { conversationId: 'c-1', policy, now: Date.now() }), null);
});

test('pick: the provenance marker is the one the retention writes', () => {
  assert.equal(conversationSource('c-9'), 'conversation:c-9');
  assert.equal(fromConversation(question({ sources: ['conversation:c-9'] }), 'c-9'), true);
  assert.equal(fromConversation(question({ sources: ['conversation:other'] }), 'c-9'), false);
  assert.equal(fromConversation(question(), 'c-9'), false);
});

// --- the words she gets -------------------------------------------------------

test('render: the block lets her raise it once, in her own words', () => {
  const text = renderOpenQuestionRaise(question());
  assert.match(text, /eigen vraag/);
  assert.match(text, /Weet Bo al of de distributie via een label moet lopen\?/);
  assert.match(text, /ja\/nee/);
  assert.match(text, /één keer/);
});

test('render: it names the answers a choice question expects', () => {
  const text = renderOpenQuestionRaise(question({ questionShape: 'choice', questionOptions: ['label', 'zelf', 'nog niet'] }));
  assert.match(text, /label/);
  assert.match(text, /zelf/);
  assert.match(text, /nog niet/);
});
