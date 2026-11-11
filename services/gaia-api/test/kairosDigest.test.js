'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  zonedDayBounds,
  localDateString,
  localHour,
  previousDate,
  hasLiteralQuote,
  selectDigestEpisodes,
  buildDigestUserPrompt,
  validateDigest,
  collectApps,
  createDigestWriter,
  createDigestScheduler,
} = require('../src/kairos/digest');

const TZ = 'Europe/Amsterdam';

function episode(overrides = {}) {
  return {
    id: 'kei_1',
    start_time: '2026-11-06T08:00:00.000Z',
    title: 'Offerte versturen',
    summary: `Bojan stuurde een offerte naar Bas. ${'x'.repeat(200)}`,
    primary_app: 'Outlook',
    involved_apps: ['Outlook'],
    ...overrides,
  };
}

test('zonedDayBounds() is exact in winter and summer time', () => {
  assert.deepEqual(zonedDayBounds('2026-11-06', TZ), {
    start: '2026-11-05T23:00:00.000Z',
    end: '2026-11-06T23:00:00.000Z',
  });
  assert.deepEqual(zonedDayBounds('2026-07-01', TZ), {
    start: '2026-06-30T22:00:00.000Z',
    end: '2026-07-01T22:00:00.000Z',
  });
});

test('zonedDayBounds() survives both DST edges', () => {
  // 29 March 2026: 23:00 -> 00:00 local is 23 hours; 25 October 2026: 25 hours.
  const spring = zonedDayBounds('2026-03-29', TZ);
  assert.equal(new Date(spring.end) - new Date(spring.start), 23 * 3600 * 1000);
  const autumn = zonedDayBounds('2026-10-25', TZ);
  assert.equal(new Date(autumn.end) - new Date(autumn.start), 25 * 3600 * 1000);
});

test('zonedDayBounds() refuses a date that does not exist', () => {
  assert.throws(() => zonedDayBounds('2026-02-31', TZ), /real YYYY-MM-DD/);
  assert.throws(() => zonedDayBounds('06-11-2026', TZ), /real YYYY-MM-DD/);
});

test('localDateString() and localHour() read the calendar in the zone', () => {
  const lateUtc = new Date('2026-11-06T23:30:00.000Z'); // 00:30 in Amsterdam
  assert.equal(localDateString(lateUtc, TZ), '2026-11-07');
  assert.equal(localHour(lateUtc, TZ), 0);
  assert.equal(previousDate('2026-11-07'), '2026-11-06');
  assert.equal(previousDate('2026-03-01'), '2026-02-28');
});

test('hasLiteralQuote() recognises both quote styles', () => {
  assert.equal(hasLiteralQuote('Hij zei "ik ben er om 6 uur".'), true);
  assert.equal(hasLiteralQuote('Hij zei “ik ben er om 6 uur”.'), true);
  assert.equal(hasLiteralQuote('Een gewone zin zonder citaat.'), false);
});

test('selectDigestEpisodes() drops short cards without a quote, keeps the rest in time order', () => {
  const kept = [
    episode({ id: 'b', start_time: '2026-11-06T12:00:00.000Z' }),
    episode({ id: 'a', start_time: '2026-11-06T08:00:00.000Z' }),
  ];
  const dropped = [
    episode({ id: 'ui', summary: 'Dashboard snelkoppeling geopend en daarna gesloten.', title: '' }),
    episode({ id: 'short', summary: 'Iets met een venster.' }),
  ];
  const selected = selectDigestEpisodes([kept[0], dropped[0], kept[1], dropped[1]]);
  assert.deepEqual(selected.map((e) => e.id), ['a', 'b']);
});

test('selectDigestEpisodes() keeps a short card that quotes something', () => {
  const quoted = episode({ id: 'q', summary: 'Mail van Fons: "je wachtwoord is verlopen".' });
  assert.deepEqual(selectDigestEpisodes([quoted]).map((e) => e.id), ['q']);
});

test('selectDigestEpisodes() falls back to the longest few when the day is all noise', () => {
  const noise = [1, 2, 3, 4, 5, 6, 7].map((n) => episode({
    id: `n${n}`,
    summary: `${'y'.repeat(70 + n)}`,
  }));
  const selected = selectDigestEpisodes(noise);
  assert.ok(selected.length > 0 && selected.length <= 5);
  assert.ok(selected.every((e) => e.summary.length >= 71));
});

test('selectDigestEpisodes() samples evenly instead of truncating a busy day', () => {
  const many = Array.from({ length: 300 }, (_, i) => episode({
    id: `e${i}`,
    start_time: new Date(Date.UTC(2026, 10, 6, 0, 0, i * 4)).toISOString(),
  }));
  const selected = selectDigestEpisodes(many, { max: 30 });
  assert.equal(selected.length, 30);
  assert.equal(selected[0].id, 'e0');
  // The last sample comes from the evening, not from the first 30 episodes.
  assert.ok(Number(selected[29].id.slice(1)) > 250);
});

test('buildDigestUserPrompt() labels each episode with local time and truncates', () => {
  const prompt = buildDigestUserPrompt('2026-11-06', [episode({ summary: 'z'.repeat(900) })], TZ);
  assert.match(prompt, /Dag: 2026-11-06/);
  assert.match(prompt, /- 09:00 \| Offerte versturen \|/); // 08:00Z = 09:00 local
  assert.ok(prompt.length < 1000);
});

test('validateDigest() accepts JSON and a fenced block, rejects the rest', () => {
  assert.deepEqual(validateDigest('{"title":"Dag","summary":"Je werkte aan Gaia."}'), {
    title: 'Dag',
    summary: 'Je werkte aan Gaia.',
  });
  assert.equal(validateDigest('```json\n{"title":"Dag","summary":"Je werkte."}\n```').summary, 'Je werkte.');
  assert.throws(() => validateDigest('geen json'), /not valid JSON/);
  assert.throws(() => validateDigest('{"title":"Dag"}'), /non-empty 'summary'/);
});

test('validateDigest() keeps paragraph breaks but not runs of them', () => {
  // The panel renders newlines literally, so a model that clears its throat
  // between paragraphs must not leave a column of white space in the card.
  const { summary } = validateDigest(JSON.stringify({
    title: 'Dag',
    summary: '  Je begon met de Castborg-rollout.\n\n\n\nDaarna de back-up.  ',
  }));
  assert.equal(summary, 'Je begon met de Castborg-rollout.\n\nDaarna de back-up.');
});

test('collectApps() counts and caps by frequency', () => {
  const apps = collectApps([
    episode({ involved_apps: ['msedge', 'explorer'] }),
    episode({ involved_apps: ['msedge'] }),
    episode({ involved_apps: [], primary_app: 'whatsapp' }),
  ]);
  assert.deepEqual(apps, ['msedge', 'explorer', 'whatsapp']);
});

function fakeCognition({ episodes = [episode()], existing = null, pages } = {}) {
  const calls = { list: [], created: [] };
  return {
    calls,
    async listKairosEpisodes(query) {
      calls.list.push(query);
      if (pages) return pages(query);
      return { data: episodes, pagination: { page: 1, limit: 100, has_more: false } };
    },
    async findKairosDigest() { return existing; },
    async createKairosDigest(record) {
      calls.created.push(record);
      return { id: `kdi_gaia_${record.digest_date}`, ...record, episode_count: record.episode_ids.length };
    },
  };
}

function modelResponse(payload) {
  return {
    ok: true,
    status: 200,
    async json() {
      return { choices: [{ message: { content: JSON.stringify(payload) } }] };
    },
  };
}

const config = () => ({ baseUrl: 'https://model.test/v1', model: 'akash/gpt-oss-120b', apiKey: 'k' });

test('writer skips an existing digest without spending a token', async () => {
  const cognition = fakeCognition({ existing: { digest_date: '2026-11-06' } });
  let fetched = 0;
  const writer = createDigestWriter({
    cognition,
    resolveConfig: config,
    fetchImpl: async () => { fetched += 1; },
    logger: { info() {}, warn() {} },
  });
  const result = await writer.generate({ date: '2026-11-06' });
  assert.equal(result.skipped, 'exists');
  assert.equal(fetched, 0);
  assert.equal(cognition.calls.list.length, 0);
});

test('writer writes no row on a day without episodes', async () => {
  const cognition = fakeCognition({ episodes: [] });
  let fetched = 0;
  const writer = createDigestWriter({
    cognition,
    resolveConfig: config,
    fetchImpl: async () => { fetched += 1; },
    logger: { info() {}, warn() {} },
  });
  const result = await writer.generate({ date: '2026-11-09' });
  assert.equal(result.skipped, 'no-episodes');
  assert.equal(fetched, 0);
  assert.equal(cognition.calls.created.length, 0);
});

test('writer leaves a day under the floor empty instead of dressing up two cards', async () => {
  const cognition = fakeCognition({
    episodes: [episode({ id: 'e1' }), episode({ id: 'e2' }), episode({ id: 'e3' })],
  });
  let fetched = 0;
  const writer = createDigestWriter({
    cognition,
    resolveConfig: config,
    fetchImpl: async () => { fetched += 1; return modelResponse({ title: 't', summary: 's' }); },
    logger: { info() {}, warn() {} },
  });
  const result = await writer.generate({ date: '2026-11-10' });
  assert.equal(result.skipped, 'too-few-episodes');
  assert.equal(result.episodeCount, 3);
  assert.equal(fetched, 0);
  assert.equal(cognition.calls.created.length, 0);
  assert.equal(writer.minEpisodes, 5);
});

test('a forced re-write may go under the episode floor', async () => {
  const cognition = fakeCognition({ episodes: [episode({ id: 'e1' }), episode({ id: 'e2' })] });
  const writer = createDigestWriter({
    cognition,
    resolveConfig: config,
    fetchImpl: async () => modelResponse({ title: 't', summary: 's' }),
    logger: { info() {}, warn() {} },
  });
  const result = await writer.generate({ date: '2026-11-10', force: true });
  assert.equal(result.skipped, undefined);
  assert.equal(cognition.calls.created.length, 1);
});

test('writer refuses a day that has not closed yet unless forced', async () => {
  const cognition = fakeCognition();
  let fetched = 0;
  const writer = createDigestWriter({
    cognition,
    resolveConfig: config,
    fetchImpl: async () => { fetched += 1; return modelResponse({ title: 't', summary: 's' }); },
    logger: { info() {}, warn() {} },
  });
  const result = await writer.generate({ date: '2999-01-01' });
  assert.equal(result.skipped, 'day-not-closed');
  assert.equal(fetched, 0);
});

test('writer asks for exactly the closed day and stores the overview', async () => {
  const emitted = [];
  const cognition = fakeCognition();
  const writer = createDigestWriter({
    cognition,
    resolveConfig: config,
    minEpisodes: 1,
    emit: (d) => emitted.push(d),
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(url, 'https://model.test/v1/chat/completions');
      assert.equal(body.model, 'akash/gpt-oss-120b');
      assert.match(body.messages[0].content, /Kairos Dagredacteur/);
      return modelResponse({ title: 'Gaia en een wachtwoord', summary: 'Je werkte aan Gaia.' });
    },
    logger: { info() {}, warn() {} },
  });

  const result = await writer.generate({ date: '2026-11-06' });
  assert.equal(cognition.calls.list[0].since, '2026-11-05T23:00:00.000Z');
  assert.equal(cognition.calls.list[0].until, '2026-11-06T23:00:00.000Z');
  assert.equal(cognition.calls.created[0].digest_date, '2026-11-06');
  assert.equal(cognition.calls.created[0].title, 'Gaia en een wachtwoord');
  assert.deepEqual(cognition.calls.created[0].episode_ids, ['kei_1']);
  assert.deepEqual(cognition.calls.created[0].apps, ['Outlook']);
  assert.equal(cognition.calls.created[0].model, 'akash/gpt-oss-120b');
  assert.equal(result.digest.episode_count, 1);
  assert.equal(emitted.length, 1);
});

test('writer pages through a busy day', async () => {
  const cognition = fakeCognition({
    pages: (query) => (query.page === 1
      ? { data: [episode({ id: 'e1' })], pagination: { page: 1, limit: 100, has_more: true } }
      : { data: [episode({ id: 'e2' })], pagination: { page: 2, limit: 100, has_more: false } }),
  });
  const writer = createDigestWriter({
    cognition,
    resolveConfig: config,
    minEpisodes: 1,
    fetchImpl: async () => modelResponse({ title: 't', summary: 's' }),
    logger: { info() {}, warn() {} },
  });
  await writer.generate({ date: '2026-11-06' });
  assert.equal(cognition.calls.list.length, 2);
  assert.deepEqual(cognition.calls.created[0].episode_ids, ['e1', 'e2']);
});

test('writer fails loudly when the model is unreachable', async () => {
  const cognition = fakeCognition();
  const writer = createDigestWriter({
    cognition,
    resolveConfig: config,
    minEpisodes: 1,
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    logger: { info() {}, warn() {} },
  });
  await assert.rejects(() => writer.generate({ date: '2026-11-06' }), /model unreachable/);
  assert.equal(cognition.calls.created.length, 0);
});

test('writer throws when no Kairos model is configured', async () => {
  const cognition = fakeCognition();
  const writer = createDigestWriter({
    cognition,
    resolveConfig: () => null,
    minEpisodes: 1,
    logger: { info() {}, warn() {} },
  });
  await assert.rejects(() => writer.generate({ date: '2026-11-06' }), /no model configured/);
});

test('scheduler waits for the configured hour', async () => {
  const generated = [];
  const sched = createDigestScheduler({
    writer: { async generate(opts) { generated.push(opts); return { skipped: 'exists' }; } },
    timeZone: TZ,
    hour: 7,
    now: () => new Date('2026-11-07T05:00:00.000Z'), // 06:00 local
    logger: { info() {}, warn() {} },
    setTimer: () => ({ unref() {} }),
    clearTimer: () => {},
  });
  const result = await sched.tick();
  assert.equal(result.skipped, 'too-early');
  assert.equal(generated.length, 0);
});

test('scheduler generates yesterday once the hour has passed', async () => {
  const generated = [];
  const sched = createDigestScheduler({
    writer: { async generate(opts) { generated.push(opts); return { skipped: 'exists' }; } },
    timeZone: TZ,
    hour: 7,
    now: () => new Date('2026-11-07T07:30:00.000Z'), // 08:30 local
    logger: { info() {}, warn() {} },
    setTimer: () => ({ unref() {} }),
    clearTimer: () => {},
  });
  await sched.tick();
  assert.deepEqual(generated, [{ date: '2026-11-06' }]);
});

test('scheduler logs a too-thin day once, not on every tick', async () => {
  const lines = [];
  const sched = createDigestScheduler({
    writer: {
      minEpisodes: 5,
      async generate() { return { skipped: 'too-few-episodes', date: '2026-11-10', episodeCount: 3 }; },
    },
    timeZone: TZ,
    hour: 7,
    now: () => new Date('2026-11-11T09:00:00.000Z'), // 10:00 local
    logger: { info: (line) => lines.push(line), warn() {} },
    setTimer: () => ({ unref() {} }),
    clearTimer: () => {},
  });
  await sched.tick();
  await sched.tick();
  assert.equal(lines.filter((l) => l.includes('only 3 episode')).length, 1);
});

test('scheduler logs an empty day once, not on every tick', async () => {
  const lines = [];
  const sched = createDigestScheduler({
    writer: { async generate() { return { skipped: 'no-episodes', date: '2026-11-09' }; } },
    timeZone: TZ,
    hour: 7,
    now: () => new Date('2026-11-10T09:00:00.000Z'),
    logger: { info: (line) => lines.push(line), warn() {} },
    setTimer: () => ({ unref() {} }),
    clearTimer: () => {},
  });
  await sched.tick();
  await sched.tick();
  assert.equal(lines.filter((l) => l.includes('no episodes')).length, 1);
});
