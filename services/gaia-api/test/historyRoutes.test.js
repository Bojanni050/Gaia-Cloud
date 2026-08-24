'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHistoryRouter } = require('../src/historyRoutes');
const { createConversationStore } = require('../src/conversationStore');
const { parseTokens, createAuthMiddleware } = require('../src/auth');

function startTestServer() {
  const historyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-routes-'));
  const store = createConversationStore({ historyDir });
  const auth = createAuthMiddleware(parseTokens('test-token'));

  const app = express();
  app.use(express.json());
  app.use('/conversations', createHistoryRouter({ store, auth }));

  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return { baseUrl, store, close: () => new Promise((resolve) => server.close(resolve)) };
}

function authHeaders(token = 'test-token') {
  return { Authorization: `Bearer ${token}` };
}

test('GET /conversations requires auth', async () => {
  const ctx = startTestServer();
  try {
    const res = await fetch(`${ctx.baseUrl}/conversations`);
    assert.equal(res.status, 401);
  } finally {
    await ctx.close();
  }
});

test('GET /conversations lists saved conversations', async () => {
  const ctx = startTestServer();
  try {
    ctx.store.saveConversation('conv-1', [{ role: 'user', content: 'hello there' }]);
    const res = await fetch(`${ctx.baseUrl}/conversations`, { headers: authHeaders() });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.conversations.length, 1);
    assert.equal(body.conversations[0].id, 'conv-1');
  } finally {
    await ctx.close();
  }
});

test('GET /conversations returns [] when nothing has been saved', async () => {
  const ctx = startTestServer();
  try {
    const res = await fetch(`${ctx.baseUrl}/conversations`, { headers: authHeaders() });
    const body = await res.json();
    assert.deepEqual(body.conversations, []);
  } finally {
    await ctx.close();
  }
});

test('GET /conversations/:id returns the full transcript', async () => {
  const ctx = startTestServer();
  try {
    ctx.store.saveConversation('conv-1', [
      { role: 'user', content: 'why is my website crashing?' },
      { role: 'assistant', content: 'let\'s check the logs' },
    ]);
    const res = await fetch(`${ctx.baseUrl}/conversations/conv-1`, { headers: authHeaders() });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.meta.id, 'conv-1');
    assert.equal(body.messages.length, 2);
  } finally {
    await ctx.close();
  }
});

test('GET /conversations/:id requires auth', async () => {
  const ctx = startTestServer();
  try {
    const res = await fetch(`${ctx.baseUrl}/conversations/conv-1`);
    assert.equal(res.status, 401);
  } finally {
    await ctx.close();
  }
});

test('GET /conversations/:id returns 404 for an unknown id', async () => {
  const ctx = startTestServer();
  try {
    const res = await fetch(`${ctx.baseUrl}/conversations/does-not-exist`, { headers: authHeaders() });
    assert.equal(res.status, 404);
  } finally {
    await ctx.close();
  }
});

test('GET /conversations/:id returns 404 (not 500) for a path-traversal id', async () => {
  const ctx = startTestServer();
  try {
    const res = await fetch(`${ctx.baseUrl}/conversations/${encodeURIComponent('../../etc/passwd')}`, { headers: authHeaders() });
    assert.equal(res.status, 404);
  } finally {
    await ctx.close();
  }
});

test('DELETE /conversations/:id removes the conversation, and it is gone from a subsequent list', async () => {
  const ctx = startTestServer();
  try {
    ctx.store.saveConversation('conv-1', [{ role: 'user', content: 'gone soon' }]);
    const delRes = await fetch(`${ctx.baseUrl}/conversations/conv-1`, { method: 'DELETE', headers: authHeaders() });
    assert.equal(delRes.status, 204);

    const listRes = await fetch(`${ctx.baseUrl}/conversations`, { headers: authHeaders() });
    const { conversations } = await listRes.json();
    assert.equal(conversations.length, 0);
  } finally {
    await ctx.close();
  }
});

test('DELETE /conversations/:id requires auth and returns 404 for an unknown id', async () => {
  const ctx = startTestServer();
  try {
    const unauth = await fetch(`${ctx.baseUrl}/conversations/anything`, { method: 'DELETE' });
    assert.equal(unauth.status, 401);

    const res = await fetch(`${ctx.baseUrl}/conversations/does-not-exist`, { method: 'DELETE', headers: authHeaders() });
    assert.equal(res.status, 404);
  } finally {
    await ctx.close();
  }
});

// --- GET /conversations/:id/export/:format (JSON and Markdown export) ---------

test('GET /conversations/:id/export/json requires auth', async () => {
  const ctx = startTestServer();
  try {
    const res = await fetch(`${ctx.baseUrl}/conversations/conv-1/export/json`);
    assert.equal(res.status, 401);
  } finally {
    await ctx.close();
  }
});

test('GET /conversations/:id/export/json returns conversation as JSON file', async () => {
  const ctx = startTestServer();
  try {
    ctx.store.saveConversation('conv-1', [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ]);
    const res = await fetch(`${ctx.baseUrl}/conversations/conv-1/export/json`, { headers: authHeaders() });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /application\/json/);
    assert.match(res.headers.get('content-disposition') || '', /attachment.*gaia-chat-conv-1\.json/);

    const body = await res.json();
    assert.ok(body.exportedAt);
    assert.equal(body.conversation.meta.id, 'conv-1');
    assert.equal(body.conversation.messages.length, 2);
  } finally {
    await ctx.close();
  }
});

test('GET /conversations/:id/export/json returns 404 for unknown id', async () => {
  const ctx = startTestServer();
  try {
    const res = await fetch(`${ctx.baseUrl}/conversations/does-not-exist/export/json`, { headers: authHeaders() });
    assert.equal(res.status, 404);
  } finally {
    await ctx.close();
  }
});

test('GET /conversations/:id/export/markdown requires auth', async () => {
  const ctx = startTestServer();
  try {
    const res = await fetch(`${ctx.baseUrl}/conversations/conv-1/export/markdown`);
    assert.equal(res.status, 401);
  } finally {
    await ctx.close();
  }
});

test('GET /conversations/:id/export/markdown returns conversation as Markdown file', async () => {
  const ctx = startTestServer();
  try {
    ctx.store.saveConversation('conv-1', [
      { role: 'user', content: 'why is my website crashing?' },
      { role: 'assistant', content: 'let\'s check the logs' },
    ]);
    const res = await fetch(`${ctx.baseUrl}/conversations/conv-1/export/markdown`, { headers: authHeaders() });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/markdown/);
    assert.match(res.headers.get('content-disposition') || '', /attachment.*gaia-chat-conv-1\.md/);

    const text = await res.text();
    assert.match(text, /# why is my website crashing\?/);
    assert.match(text, /\*\*You\*\*/);
    assert.match(text, /\*\*Gaia\*\*/);
    assert.match(text, /let's check the logs/);
  } finally {
    await ctx.close();
  }
});

test('GET /conversations/:id/export/markdown returns 404 for unknown id', async () => {
  const ctx = startTestServer();
  try {
    const res = await fetch(`${ctx.baseUrl}/conversations/does-not-exist/export/markdown`, { headers: authHeaders() });
    assert.equal(res.status, 404);
  } finally {
    await ctx.close();
  }
});

test('GET /conversations/:id/export/:format returns 400 for invalid format', async () => {
  const ctx = startTestServer();
  try {
    ctx.store.saveConversation('conv-1', [{ role: 'user', content: 'hi' }]);
    const res = await fetch(`${ctx.baseUrl}/conversations/conv-1/export/pdf`, { headers: authHeaders() });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /format must be/);
  } finally {
    await ctx.close();
  }
});

// --- GET /conversations/events (SSE push, so the sidebar can stay in sync
// with another client without polling) -------------------------------------

test('GET /conversations/events requires auth', async () => {
  const ctx = startTestServer();
  try {
    const res = await fetch(`${ctx.baseUrl}/conversations/events`);
    assert.equal(res.status, 401);
  } finally {
    await ctx.close();
  }
});

test('GET /conversations/events pushes "changed" when a conversation is saved', async () => {
  const ctx = startTestServer();
  try {
    const res = await fetch(`${ctx.baseUrl}/conversations/events`, { headers: authHeaders() });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/event-stream/);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    async function readUntil(match) {
      while (!buffer.includes(match)) {
        const { value, done } = await reader.read();
        if (done) throw new Error('stream ended before seeing ' + JSON.stringify(match));
        buffer += decoder.decode(value, { stream: true });
      }
    }

    await readUntil('\n\n'); // the initial ":ok" comment frame
    buffer = '';

    ctx.store.saveConversation('conv-1', [{ role: 'user', content: 'hi' }]);
    await readUntil('event: changed');
    assert.match(buffer, /event: changed\ndata: \{\}\n\n/);

    await reader.cancel();
  } finally {
    await ctx.close();
  }
});

test('GET /conversations/events does not push for a no-op save (empty messages)', async () => {
  const ctx = startTestServer();
  try {
    const res = await fetch(`${ctx.baseUrl}/conversations/events`, { headers: authHeaders() });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    async function readSome() {
      const { value, done } = await reader.read();
      if (!done) buffer += decoder.decode(value, { stream: true });
    }
    await readSome(); // the initial ":ok" comment frame
    buffer = '';

    ctx.store.saveConversation('conv-1', []); // no-op, per conversationStore.js
    ctx.store.saveConversation('conv-2', [{ role: 'user', content: 'this one counts' }]);
    await readUntilChanged(reader, decoder, () => buffer, (v) => { buffer = v; });

    // Only one "changed" frame should ever arrive, from conv-2's real save.
    assert.equal((buffer.match(/event: changed/g) || []).length, 1);
    await reader.cancel();
  } finally {
    await ctx.close();
  }
});

async function readUntilChanged(reader, decoder, getBuffer, setBuffer) {
  while (!getBuffer().includes('event: changed')) {
    const { value, done } = await reader.read();
    if (done) throw new Error('stream ended before seeing event: changed');
    setBuffer(getBuffer() + decoder.decode(value, { stream: true }));
  }
}
