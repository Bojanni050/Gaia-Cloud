'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createDesktopBroker } = require('../src/desktopBroker');

function turn() {
  const frames = [];
  const broker = createDesktopBroker({ logger() {}, resultTimeoutMs: 50, confirmTimeoutMs: 50 });
  const t = broker.forTurn({ emit: (v) => frames.push(v), conversationId: 'c1' });
  return { t, frames };
}

test('a relative, bare or missing path is rejected before any action reaches the client', async () => {
  for (const path of ['txtjes', '~/notes', '..\other', 'Documents\a.txt', '', undefined, 42]) {
    const { t, frames } = turn();
    const out = await t.execute('file-search', { query: 'x', path });
    assert.match(out, /full absolute path/, JSON.stringify(path));
    assert.equal(frames.length, 0, `no frame for ${JSON.stringify(path)}`);
  }
});

test('full paths pass the check and become real actions', async () => {
  for (const path of ['C:\\Users\\bojan\\txtjes', 'c:/Users/bojan', '\\\\server\\share\\a', '/home/a']) {
    const { t, frames } = turn();
    const pending = t.execute('file-read', { path });
    assert.equal(frames.length > 0, true, JSON.stringify(path));
    assert.equal(frames[0].skill, 'file-read');
    await pending; // times out quickly; nothing else to assert
  }
});

test('run-command needs no path', async () => {
  const { t, frames } = turn();
  const pending = t.execute('run-command', { command: 'dir' });
  assert.equal(frames.length, 1);
  await pending;
});
