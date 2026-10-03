'use strict';

/**
 * Primary/backup generation failover (v3.0 live inference seam).
 *
 * The backup is a plain inference provider: used when no primary is
 * configured, or when the primary fails BEFORE visible output with a
 * timeout, network error, 429 or 5xx. Never on config errors or other
 * 4xx. Streaming failover runs only before the first visible content
 * token. Hermes is never involved.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { GenerationError } = require('../src/generation/gaiaGenerator');
const { hasGenerator, generateWithFailover, streamWithFailover, isNotConfiguredError } = require('../src/generation/generationFailover');

function retryable(status) {
  return new GenerationError(`primary ${status}`, { status, retryable: true });
}

test('hasGenerator is true only for usable generation shapes', () => {
  assert.equal(hasGenerator(null), false);
  assert.equal(hasGenerator(undefined), false);
  assert.equal(hasGenerator({}), false);
  assert.equal(hasGenerator({ generate: async () => 'x' }), true);
  assert.equal(hasGenerator({ stream: async () => 'x' }), true);
});

test('generate uses the primary when it succeeds', async () => {
  let primaryCalls = 0;
  let backupCalls = 0;
  const out = await generateWithFailover([{ role: 'user', content: 'hi' }], {
    primary: { generate: async () => { primaryCalls += 1; return 'primary reply'; } },
    backup: { generate: async () => { backupCalls += 1; return 'backup reply'; } },
  });
  assert.equal(out, 'primary reply');
  assert.equal(primaryCalls, 1);
  assert.equal(backupCalls, 0);
});

test('generate uses the backup directly when no primary is configured', async () => {
  const out = await generateWithFailover([{ role: 'user', content: 'hi' }], {
    primary: null,
    backup: { generate: async () => 'backup reply' },
  });
  assert.equal(out, 'backup reply');
});

test('generate fails over on timeout, network error, 429 and 5xx', async () => {
  for (const err of [
    new GenerationError('timed out', { retryable: true, code: 'timeout' }),
    new GenerationError('unreachable', { retryable: true, code: 'network' }),
    retryable(429),
    retryable(500),
    retryable(503),
  ]) {
    let backupCalls = 0;
    const out = await generateWithFailover([{ role: 'user', content: 'hi' }], {
      primary: { generate: async () => { throw err; } },
      backup: { generate: async () => { backupCalls += 1; return 'backup reply'; } },
    });
    assert.equal(out, 'backup reply');
    assert.equal(backupCalls, 1);
  }
});

test('generate does NOT fail over on config errors or other 4xx', async () => {
  for (const err of [
    new GenerationError('no content', { retryable: false, code: 'no_content' }),
    new GenerationError('bad request', { status: 400, retryable: false }),
    new GenerationError('forbidden', { status: 403, retryable: false }),
    new Error('plain failure'),
  ]) {
    let backupCalls = 0;
    await assert.rejects(
      generateWithFailover([{ role: 'user', content: 'hi' }], {
        primary: { generate: async () => { throw err; } },
        backup: { generate: async () => { backupCalls += 1; return 'backup reply'; } },
      }),
      (thrown) => thrown === err
    );
    assert.equal(backupCalls, 0, 'backup must not run for non-retryable failures');
  }
});

test('generate throws not_configured when neither primary nor backup exists', async () => {
  await assert.rejects(generateWithFailover([], { primary: null, backup: null }));
  try {
    await generateWithFailover([], {});
    assert.fail('must throw');
  } catch (err) {
    assert.equal(isNotConfiguredError(err), true);
  }
});

test('stream uses the backup directly when no primary is configured', async () => {
  const deltas = [];
  const out = await streamWithFailover([{ role: 'user', content: 'hi' }], {
    primary: null,
    backup: { stream: async (m, { onDelta }) => { onDelta('backup', false); return 'backup'; } },
    onDelta: (chunk) => deltas.push(chunk),
  });
  assert.equal(out, 'backup');
  assert.deepEqual(deltas, ['backup']);
});

test('stream fails over before the first visible token', async () => {
  const deltas = [];
  const out = await streamWithFailover([{ role: 'user', content: 'hi' }], {
    primary: { stream: async () => { throw retryable(503); } },
    backup: { stream: async (m, { onDelta }) => { onDelta('backup', false); return 'backup'; } },
    onDelta: (chunk) => deltas.push(chunk),
  });
  assert.equal(out, 'backup');
  assert.deepEqual(deltas, ['backup']);
});

test('stream does NOT fail over after visible output — the primary error propagates', async () => {
  let backupCalls = 0;
  const deltas = [];
  await assert.rejects(
    streamWithFailover([{ role: 'user', content: 'hi' }], {
      primary: {
        stream: async (m, { onDelta }) => {
          onDelta('partial', false);
          throw retryable(500);
        },
      },
      backup: { stream: async () => { backupCalls += 1; return 'backup'; } },
      onDelta: (chunk) => deltas.push(chunk),
    })
  );
  assert.equal(backupCalls, 0, 'no second generation once output was visible');
  assert.deepEqual(deltas, ['partial']);
});

test('stream does NOT fail over on non-retryable primary errors', async () => {
  let backupCalls = 0;
  await assert.rejects(
    streamWithFailover([{ role: 'user', content: 'hi' }], {
      primary: { stream: async () => { throw new GenerationError('bad request', { status: 400, retryable: false }); } },
      backup: { stream: async () => { backupCalls += 1; return 'backup'; } },
    })
  );
  assert.equal(backupCalls, 0);
});

test('stream supports a generate-only backup behind a streaming transport', async () => {
  const deltas = [];
  const out = await streamWithFailover([{ role: 'user', content: 'hi' }], {
    primary: null,
    backup: { generate: async () => 'full text' },
    onDelta: (chunk) => deltas.push(chunk),
  });
  assert.equal(out, 'full text');
  assert.deepEqual(deltas, ['full text']);
});

test('reasoning deltas do not count as visible output for failover', async () => {
  const seen = [];
  const out = await streamWithFailover([{ role: 'user', content: 'hi' }], {
    primary: {
      stream: async (m, { onDelta }) => {
        onDelta('thinking...', true);
        throw retryable(429);
      },
    },
    backup: { stream: async (m, { onDelta }) => { onDelta('backup', false); return 'backup'; } },
    onDelta: (chunk) => seen.push(chunk),
  });
  assert.equal(out, 'backup', 'reasoning-trace output must not block failover');
  assert.deepEqual(seen, ['thinking...', 'backup']);
});
