'use strict';

/**
 * Pattern Awareness 0.1 — live-path validation (spec §20).
 * Runs the REAL performStreamingTurn + REAL hindsightPatternAdapter against
 * a faithful fake of Hindsight's HTTP surface (same fakes the test suite
 * uses), since the real deployment is unreachable from this machine.
 */

const http = require('http');
const { createHindsightClient } = require('../src/hindsightClient');
const { createHindsightPatternAdapter } = require('../src/reasoning/hindsightPatternAdapter');
const { performStreamingTurn } = require('../src/turn');

function makeFakeHindsight() {
  const facts = new Map();
  let n = 0;
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    let body = '';
    for await (const chunk of req) body += chunk;
    const parsed = body ? JSON.parse(body) : null;
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST' && u.pathname.endsWith('/memories/recall')) {
      // Naive lexical scoring — enough to exercise the real relevance path.
      const q = parsed.query.toLowerCase().split(/\s+/);
      const results = [...facts.values()]
        .filter((f) => f.state === 'valid')
        .map((f) => ({ ...f, scores: { final: Math.min(0.99, q.filter((w) => f.text.toLowerCase().includes(w)).length * 0.25) } }))
        .filter((f) => f.scores.final > 0)
        .sort((a, b) => b.scores.final - a.scores.final);
      res.end(JSON.stringify({ results }));
      return;
    }
    if (req.method === 'POST' && u.pathname.endsWith('/memories')) {
      for (const item of parsed.items) {
        n += 1;
        facts.set(`ptf_${n}`, { id: `ptf_${n}`, text: item.content, type: 'world', state: 'valid', tags: item.tags || [], metadata: item.metadata || {} });
      }
      res.end(JSON.stringify({ success: true }));
      return;
    }
    if (req.method === 'GET' && u.pathname.endsWith('/memories/list')) {
      const docId = u.searchParams.get('document_id');
      res.end(JSON.stringify({ items: [...facts.values()].filter((f) => !docId || f.document_id === docId || true) }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({}));
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ server, port: server.address().port, facts })));
}

async function main() {
  const { server, port } = await makeFakeHindsight();
  const client = createHindsightClient({ baseUrl: `http://127.0.0.1:${port}`, bankId: 'bojan', fetchImpl: fetch });
  const patternAdapter = createHindsightPatternAdapter({ client });

  // Seed two durable patterns via the real persistence sink.
  await patternAdapter.sink.save({
    id: 'pattern-7',
    statement: 'Bo lijkt vaak langdurig creatief te werken aan muziekprojecten na technische doorbraken.',
    status: 'established', confidence: 0.85, hypothesisIds: ['h1', 'h2'],
  });
  await patternAdapter.sink.save({
    id: 'pattern-9',
    statement: 'Bo lijkt voorkeur te geven aan korte directe communicatie bij reviews.',
    status: 'candidate', confidence: 0.5, hypothesisIds: ['h3'],
  });

  const runtime = {
    manager: { list: () => [], applyReasoningResult: () => {} },
    recallPatterns: (q) => patternAdapter.recallPatterns(q),
  };
  const hermes = { stream: async (messages, { onDelta }) => { onDelta('...antwoord...', false); return '...antwoord...'; } };

  async function turn(text, intent) {
    const logs = [];
    const orig = console.log;
    console.log = (l) => { try { logs.push(JSON.parse(l)); } catch (_) {} };
    await performStreamingTurn({
      messages: [{ role: 'user', content: text }],
      documents: {},
      hermes,
      hindsight: client,
      res: { writeHead() {}, write() {}, end() {}, status() { return this; }, json() {} },
      intentIQ: () => ({ schemaVersion: 'intentiq.v1', intent, status: 'accepted', entities: [], sourceOfTruth: 'conversation' }),
      reasonIQ: async () => ({}),
      hypothesisRuntime: runtime,
    });
    console.log = orig;
    const awareness = logs.find((l) => l.kind === 'pattern.awareness');
    return awareness;
  }

  console.log('Pattern Awareness 0.1 — live-path validation (real turn pipeline + real adapter)\n');

  const a = await turn('Hoi Gaia', 'converse');
  console.log(`A. greeting        -> ${a ? 'LOGGED (FAIL)' : 'no retrieval ran (gate closed)'}`);

  const b = await turn('Ik ga vanavond weer langdurig creatief werken aan mijn muziekproject na die doorbraak.', 'converse');
  const bs = JSON.stringify(b && b.selected);
  console.log(`B. relevant durable -> mode=${b.mode}, candidates=${b.candidates}`);
  console.log(`   ${bs.slice(0, 220)}`);

  const c = await turn('Wat is de hoofdstad van Bolivia?', 'inform.explain');
  console.log(`C. irrelevant       -> mode=${c.mode}, selected=${JSON.stringify(c.selected.map((s) => `${s.patternId}:${s.usage}`))}`);

  const d = await turn('Hoe geef jij normaal feedback en communicatie tijdens reviews?', 'converse');
  console.log(`D. candidate        -> mode=${d.mode}, selected=${JSON.stringify(d.selected.map((s) => `${s.patternId}:${s.usage} (${s.reason})`))}`);

  server.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
