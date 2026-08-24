'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const reasonModels = require('../src/logos/reasonModels');
const { parseAndValidateReasoningOutput, MalformedReasoningOutputError } = require('../src/logos/reasonValidate');
const { buildReasoningPrompt } = require('../src/logos/reasonPrompt');
const { createReasoningModelClient } = require('../src/logos/reasoningModelClient');
const reasonIQ = require('../src/logos/reasonIQ');
const { evaluate, decideReasoningDepth } = reasonIQ;
const { runLogos } = require('../src/logos/index');

const silent = { silent: true };

// --- reasonModels -----------------------------------------------------

test('reasonModels: vocabularies are the exact fixed sets', () => {
  assert.deepEqual(reasonModels.EPISTEMIC_STATUS, ['fact', 'inference', 'hypothesis', 'unknown']);
  assert.deepEqual(reasonModels.EVIDENCE_VERDICTS, ['supports', 'weakens', 'contradicts', 'irrelevant']);
  assert.deepEqual(reasonModels.HYPOTHESIS_STATUSES, ['proposed', 'testing', 'confirmed', 'rejected']);
});

test('reasonModels: makeHypothesis defaults to proposed and gets a local id', () => {
  const h = reasonModels.makeHypothesis({ statement: 'x' });
  assert.equal(h.status, 'proposed');
  assert.ok(h.id);
  assert.equal(h.confidence, 0.5);
});

// --- reasonValidate -----------------------------------------------------

const VALID_OUTPUT = JSON.stringify({
  interpretation: 'The user is asking why their website crashed.',
  evidence: [{ content: 'server logs show OOM errors', type: 'fact', origin: 'supplied' }],
  hypotheses: [{
    statement: 'The website crashes due to a memory leak.',
    confidence: 0.6,
    status: 'proposed',
    verificationPlan: 'Check memory usage over time.',
    evidenceAssessments: [{
      evidence: 'server logs show OOM errors',
      verdict: 'supports',
      confidence: 0.8,
      reasoning: 'OOM errors directly indicate a memory problem.',
      newConfidence: 0.75,
    }],
  }],
  contradictions: [],
  uncertainties: ['exact leak source unknown'],
  informationGaps: [],
  conclusions: [{ statement: 'Investigate memory usage.', basis: 'inference', confidence: 0.7 }],
  sufficientForConclusion: true,
  confidence: 0.7,
});

test('parseAndValidateReasoningOutput: happy path parses fully', () => {
  const result = parseAndValidateReasoningOutput(VALID_OUTPUT);
  assert.equal(result.interpretation, 'The user is asking why their website crashed.');
  assert.equal(result.hypotheses.length, 1);
  assert.equal(result.hypotheses[0].evidenceAssessments[0].verdict, 'supports');
});

test('parseAndValidateReasoningOutput: confidence and newConfidence stay distinct', () => {
  const result = parseAndValidateReasoningOutput(VALID_OUTPUT);
  const assessment = result.hypotheses[0].evidenceAssessments[0];
  assert.equal(assessment.confidence, 0.8);
  assert.equal(assessment.newConfidence, 0.75);
  assert.notEqual(assessment.confidence, assessment.newConfidence);
});

test('parseAndValidateReasoningOutput: confidence is capped below 1.0', () => {
  const output = JSON.parse(VALID_OUTPUT);
  output.confidence = 1.0;
  output.hypotheses[0].confidence = 1.0;
  const result = parseAndValidateReasoningOutput(JSON.stringify(output));
  assert.ok(result.confidence <= 0.95);
  assert.ok(result.hypotheses[0].confidence <= 0.95);
});

test('parseAndValidateReasoningOutput: throws on non-JSON', () => {
  assert.throws(() => parseAndValidateReasoningOutput('not json at all'), MalformedReasoningOutputError);
});

test('parseAndValidateReasoningOutput: throws on missing interpretation', () => {
  assert.throws(() => parseAndValidateReasoningOutput(JSON.stringify({})), MalformedReasoningOutputError);
});

test('parseAndValidateReasoningOutput: throws on an invalid evidence verdict', () => {
  const output = JSON.parse(VALID_OUTPUT);
  output.hypotheses[0].evidenceAssessments[0].verdict = 'definitely-true';
  assert.throws(() => parseAndValidateReasoningOutput(JSON.stringify(output)), MalformedReasoningOutputError);
});

test('parseAndValidateReasoningOutput: missing optional arrays default to empty, not a throw', () => {
  const result = parseAndValidateReasoningOutput(JSON.stringify({ interpretation: 'ok' }));
  assert.deepEqual(result.evidence, []);
  assert.deepEqual(result.hypotheses, []);
  assert.deepEqual(result.contradictions, []);
  assert.equal(result.sufficientForConclusion, false);
});

// --- reasonPrompt -----------------------------------------------------

test('buildReasoningPrompt: embeds text, intent, and evidence in the user message', () => {
  const messages = buildReasoningPrompt({
    text: 'Why is my website crashing?',
    intentDecision: { intent: 'inform.explain', status: 'accepted', confidence: 0.8 },
    conversationContext: [],
    evidence: [{ content: 'server logs show OOM errors' }],
  });
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[1].role, 'user');
  assert.match(messages[1].content, /Why is my website crashing\?/);
  assert.match(messages[1].content, /inform\.explain/);
  assert.match(messages[1].content, /OOM errors/);
});

// --- reasoningModelClient -----------------------------------------------

test('reasoningModelClient: reports unconfigured with no baseUrl/model', () => {
  const client = createReasoningModelClient({});
  assert.equal(client.isConfigured(), false);
});

test('reasoningModelClient: chat() rejects when unconfigured, without a network call', async () => {
  const client = createReasoningModelClient({});
  await assert.rejects(() => client.chat([]), /not configured/);
});

test('reasoningModelClient: chat() parses a happy-path OpenAI-compatible response', async () => {
  const fakeFetch = async (url) => {
    assert.match(url, /\/chat\/completions$/);
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"interpretation":"ok"}' } }] }),
    };
  };
  const client = createReasoningModelClient({ baseUrl: 'http://fake:1234', model: 'test-model', fetchImpl: fakeFetch });
  const content = await client.chat([{ role: 'user', content: 'hi' }]);
  assert.equal(content, '{"interpretation":"ok"}');
});

test('reasoningModelClient: chat() maps a failing fetch to a generic error, no URL leaked', async () => {
  const fakeFetch = async () => { throw new Error('connect ECONNREFUSED 10.0.0.1:1234'); };
  const client = createReasoningModelClient({ baseUrl: 'http://fake:1234', model: 'test-model', fetchImpl: fakeFetch });
  await assert.rejects(() => client.chat([]), (err) => {
    assert.ok(!err.message.includes('10.0.0.1'));
    assert.match(err.message, /unreachable/);
    return true;
  });
});

test('reasoningModelClient: chat() defaults to forcing json_object (ReasonIQ\'s own need)', async () => {
  let capturedBody;
  const fakeFetch = async (url, init) => {
    capturedBody = JSON.parse(init.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{}' } }] }) };
  };
  const client = createReasoningModelClient({ baseUrl: 'http://fake:1234', model: 'm', fetchImpl: fakeFetch });
  await client.chat([{ role: 'user', content: 'hi' }]);
  assert.deepEqual(capturedBody.response_format, { type: 'json_object' });
});

test('reasoningModelClient: chat() omits response_format entirely when explicitly passed null (e.g. OCR)', async () => {
  let capturedBody;
  const fakeFetch = async (url, init) => {
    capturedBody = JSON.parse(init.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'a plain description' } }] }) };
  };
  const client = createReasoningModelClient({ baseUrl: 'http://fake:1234', model: 'm', fetchImpl: fakeFetch });
  await client.chat([{ role: 'user', content: 'describe this' }], { responseFormat: null });
  assert.ok(!('response_format' in capturedBody));
});

test('reasoningModelClient: chat() carries multimodal content-block arrays through untouched', async () => {
  let capturedBody;
  const fakeFetch = async (url, init) => {
    capturedBody = JSON.parse(init.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
  };
  const client = createReasoningModelClient({ baseUrl: 'http://fake:1234', model: 'm', fetchImpl: fakeFetch });
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'x' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] }];
  await client.chat(messages, { responseFormat: null });
  assert.deepEqual(capturedBody.messages, messages);
});

// --- reasonIQ.evaluate — reasoning depth ----------------------------------

function stubModelReturning(jsonBody) {
  return { chat: async () => JSON.stringify(jsonBody), isConfigured: () => true };
}

function throwingModel(message) {
  return { chat: async () => { throw new Error(message); }, isConfigured: () => true };
}

test('reasonIQ: trivial input never calls the reasoning model (shallow)', async () => {
  let called = false;
  const model = { chat: async () => { called = true; return '{}'; }, isConfigured: () => true };
  const result = await reasonIQ.evaluate({ text: 'ok' }, { reasoningModel: model, ...silent });
  assert.equal(called, false);
  assert.equal(result.reasoningDepth, 'shallow');
});

test('reasonIQ: an accepted converse intent with no evidence is shallow', async () => {
  let called = false;
  const model = { chat: async () => { called = true; return '{}'; }, isConfigured: () => true };
  const result = await reasonIQ.evaluate(
    { text: 'I just need to vent for a second, it has been a long week honestly', intentDecision: { intent: 'converse', status: 'accepted' } },
    { reasoningModel: model, ...silent }
  );
  assert.equal(called, false);
  assert.equal(result.reasoningDepth, 'shallow');
});

test('reasonIQ: supplied evidence always triggers deep reasoning, even for short input', async () => {
  let called = false;
  const model = stubModelReturning({ interpretation: 'ok' });
  model.chat = async () => { called = true; return JSON.stringify({ interpretation: 'ok' }); };
  const result = await reasonIQ.evaluate(
    { text: 'and this?', evidence: [{ content: 'the server restarted at 3am' }] },
    { reasoningModel: model, ...silent }
  );
  assert.equal(called, true);
  assert.equal(result.reasoningDepth, 'deep');
});

test('reasonIQ: a substantial, non-conversational turn WITHOUT evidence still stays shallow — intent alone no longer triggers a model call', async () => {
  let called = false;
  const model = { chat: async () => { called = true; return JSON.stringify({ interpretation: 'ok' }); }, isConfigured: () => true };
  const result = await reasonIQ.evaluate(
    { text: 'Why does the API return a 500 on the checkout endpoint sometimes?', intentDecision: { intent: 'inform.explain', status: 'accepted' } },
    { reasoningModel: model, ...silent }
  );
  assert.equal(called, false);
  assert.equal(result.reasoningDepth, 'shallow');
});

test('reasonIQ: decideReasoningDepth depends only on evidence, not intent or text length', () => {
  assert.equal(reasonIQ.decideReasoningDepth({ text: 'short' }), 'shallow');
  assert.equal(reasonIQ.decideReasoningDepth({ text: 'a long, substantial, detailed question about something important' }), 'shallow');
  assert.equal(reasonIQ.decideReasoningDepth({ text: 'x', evidence: [{ content: 'anything' }] }), 'deep');
  assert.equal(reasonIQ.decideReasoningDepth({ text: '', evidence: [] }), 'shallow');
});

// --- shallow path is a real (cheap) judgment, not a placeholder -----------

test('shallow: an evidence-dependent intent with no evidence reports an honest information gap, not false sufficiency', async () => {
  const model = { chat: async () => { throw new Error('must not be called'); }, isConfigured: () => true };
  const result = await reasonIQ.evaluate(
    { text: 'Why is my website crashing?', intentDecision: { intent: 'inform.explain', status: 'accepted' } },
    { reasoningModel: model, ...silent }
  );
  assert.equal(result.reasoningDepth, 'shallow');
  assert.equal(result.sufficientForConclusion, false);
  assert.ok(result.informationGaps.length > 0);
  assert.ok(result.confidence <= 0.45);
});

test('shallow: converse and meta.relational intents are not evidence-dependent — no gap, ordinary confidence', async () => {
  const converse = await reasonIQ.evaluate(
    { text: 'I just need to vent for a second, long week honestly', intentDecision: { intent: 'converse', status: 'accepted' } },
    { silent: true }
  );
  assert.equal(converse.informationGaps.length, 0);
  assert.equal(converse.sufficientForConclusion, true);
  assert.equal(converse.confidence, 0.5);
});

test('shallow: an unresolved (unknown) intent reports genuine uncertainty and low confidence', async () => {
  const result = await reasonIQ.evaluate(
    { text: 'asdkfj alkj qzx', intentDecision: { intent: null, status: 'unknown' } },
    { silent: true }
  );
  assert.equal(result.sufficientForConclusion, false);
  assert.ok(result.uncertainties.length > 0);
  assert.equal(result.confidence, 0.25);
});

test('shallow: no intentDecision at all is treated the same as unknown', async () => {
  const result = await reasonIQ.evaluate({ text: 'some plain input here' }, { silent: true });
  assert.equal(result.sufficientForConclusion, false);
  assert.ok(result.uncertainties.length > 0);
});

test('shallow: an ambiguous intent reports uncertainty distinct from unknown', async () => {
  const result = await reasonIQ.evaluate(
    { text: 'I need you to handle this.', intentDecision: { intent: null, status: 'ambiguous' } },
    { silent: true }
  );
  assert.equal(result.sufficientForConclusion, false);
  assert.ok(result.uncertainties.length > 0);
  assert.equal(result.confidence, 0.3);
});

test('shallow: an ambiguous, evidence-dependent intent combines both signals into the lower confidence', async () => {
  const result = await reasonIQ.evaluate(
    { text: 'Should we ship or wait?', intentDecision: { intent: 'decide.support', status: 'ambiguous' } },
    { silent: true }
  );
  assert.ok(result.uncertainties.length > 0);
  assert.ok(result.informationGaps.length > 0);
  assert.ok(result.confidence <= 0.3);
});

// --- reasonIQ.evaluate — happy path structure -----------------------------

test('reasonIQ: deep path returns a fully-shaped ReasoningResult', async () => {
  const model = stubModelReturning(JSON.parse(VALID_OUTPUT));
  const result = await reasonIQ.evaluate(
    { text: 'Why is my website crashing?', evidence: [{ content: 'server logs show OOM errors' }] },
    { reasoningModel: model, ...silent }
  );
  assert.equal(result.schemaVersion, 'reasoniq.v1');
  assert.equal(result.reasoningDepth, 'deep');
  assert.equal(result.hypotheses.length, 1);
  assert.equal(result.meta.reasoningModelConfigured, true);
  assert.equal(result.meta.fallbackReason, null);
});

// --- reasonIQ.evaluate — graceful degradation -----------------------------

test('reasonIQ: malformed model output degrades gracefully, never throws', async () => {
  const model = { chat: async () => 'this is not json', isConfigured: () => true };
  const result = await reasonIQ.evaluate(
    { text: 'Why is my website crashing?', evidence: [{ content: 'x' }] },
    { reasoningModel: model, ...silent }
  );
  assert.equal(result.meta.fallbackReason, 'malformed_model_output');
  assert.equal(result.sufficientForConclusion, false);
  assert.equal(result.confidence, 0);
  assert.ok(result.informationGaps.length > 0);
});

test('reasonIQ: an unreachable model degrades gracefully, never throws', async () => {
  const model = throwingModel('connect ECONNREFUSED');
  const result = await reasonIQ.evaluate(
    { text: 'Why is my website crashing?', evidence: [{ content: 'x' }] },
    { reasoningModel: model, ...silent }
  );
  assert.equal(result.meta.fallbackReason, 'reasoning_model_unavailable');
});

test('reasonIQ: with no reasoning model configured at all, a deep-worthy turn still degrades gracefully', async () => {
  const result = await reasonIQ.evaluate(
    { text: 'Why is my website crashing?', evidence: [{ content: 'x' }] },
    { reasoningModel: createReasoningModelClient({}), ...silent }
  );
  assert.equal(result.meta.reasoningModelConfigured, false);
  assert.equal(result.meta.fallbackReason, 'reasoning_model_unavailable');
});

// --- epistemic honesty -----------------------------------------------------

test('reasonIQ: never reports a hypothesis confidence of 1.0 (no false certainty)', async () => {
  const output = JSON.parse(VALID_OUTPUT);
  output.hypotheses[0].confidence = 1.0;
  const model = stubModelReturning(output);
  const result = await reasonIQ.evaluate(
    { text: 'Why is my website crashing?', evidence: [{ content: 'x' }] },
    { reasoningModel: model, ...silent }
  );
  assert.ok(result.hypotheses[0].confidence < 1.0);
});

test('reasonIQ: contradicting evidence can drive a hypothesis toward a low newConfidence', async () => {
  const output = JSON.parse(VALID_OUTPUT);
  output.hypotheses[0].evidenceAssessments[0].verdict = 'contradicts';
  output.hypotheses[0].evidenceAssessments[0].newConfidence = 0.1;
  const model = stubModelReturning(output);
  const result = await reasonIQ.evaluate(
    { text: 'Why is my website crashing?', evidence: [{ content: 'x' }] },
    { reasoningModel: model, ...silent }
  );
  assert.equal(result.hypotheses[0].evidenceAssessments[0].verdict, 'contradicts');
  assert.equal(result.hypotheses[0].evidenceAssessments[0].newConfidence, 0.1);
});

test('reasonIQ: insufficient information is reported, not papered over', async () => {
  const model = stubModelReturning({
    interpretation: 'The user asked something with almost no context to reason from.',
    informationGaps: ['no prior conversation context was supplied', 'no evidence was supplied'],
    sufficientForConclusion: false,
    confidence: 0.2,
  });
  const result = await reasonIQ.evaluate(
    { text: 'Should I say yes or no?', evidence: [{ content: 'placeholder' }] },
    { reasoningModel: model, ...silent }
  );
  assert.equal(result.sufficientForConclusion, false);
  assert.ok(result.informationGaps.length >= 2);
});

test('reasonIQ: competing hypotheses are both preserved with distinct ids', async () => {
  const model = stubModelReturning({
    interpretation: 'Two plausible explanations exist.',
    hypotheses: [
      { statement: 'A', confidence: 0.5, status: 'proposed', evidenceAssessments: [] },
      { statement: 'B', confidence: 0.5, status: 'proposed', evidenceAssessments: [] },
    ],
    sufficientForConclusion: false,
    confidence: 0.3,
  });
  const result = await reasonIQ.evaluate(
    { text: 'Why did the deploy fail?', evidence: [{ content: 'x' }] },
    { reasoningModel: model, ...silent }
  );
  assert.equal(result.hypotheses.length, 2);
  assert.notEqual(result.hypotheses[0].id, result.hypotheses[1].id);
});

// --- logging ---------------------------------------------------------------

test('reasonIQ: logs a result line unless silent', async () => {
  const lines = [];
  const model = { chat: async () => '{}', isConfigured: () => true };
  await reasonIQ.evaluate({ text: 'ok' }, { reasoningModel: model, logger: (l) => lines.push(l) });
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.kind, 'reasoniq.result');
});

// --- IntentIQ -> ReasonIQ handoff (logos/index.js) ------------------------

test('runLogos: passes IntentIQ\'s real decision into ReasonIQ\'s prompt, not a re-derived one', async () => {
  let capturedMessages;
  const model = {
    chat: async (messages) => { capturedMessages = messages; return JSON.stringify({ interpretation: 'ok' }); },
    isConfigured: () => true,
  };

  const { intentDecision, reasoningResult } = await runLogos(
    [{ role: 'user', content: 'Why is my website crashing?' }],
    { evidence: [{ content: 'server logs show OOM errors' }], reasoningModel: model, silent: true }
  );

  assert.equal(intentDecision.intent, 'inform.explain');
  assert.equal(reasoningResult.reasoningDepth, 'deep');
  const userMessage = capturedMessages.find((m) => m.role === 'user');
  assert.match(userMessage.content, /"intent":\s*"inform\.explain"/);
});

test('runLogos: a shallow-worthy turn never calls the reasoning model, but still runs IntentIQ', async () => {
  let called = false;
  const model = { chat: async () => { called = true; return '{}'; }, isConfigured: () => true };
  const { intentDecision, reasoningResult } = await runLogos([{ role: 'user', content: 'ok' }], { reasoningModel: model, silent: true });
  assert.equal(called, false);
  assert.equal(intentDecision.status, 'unknown');
  assert.equal(reasoningResult.reasoningDepth, 'shallow');
});

// --- boundary: ReasonIQ is a cognitive component, never an agent ---------

test('boundary: reasonIQ.js and logos/index.js never import Hermes, Hindsight, or MCP clients', () => {
  for (const file of ['../src/logos/reasonIQ.js', '../src/logos/index.js', '../src/logos/reasoningModelClient.js']) {
    const source = fs.readFileSync(path.join(__dirname, file), 'utf-8');
    assert.ok(!/require\(.*hermesClient/.test(source), `${file} must not import hermesClient`);
    assert.ok(!/require\(.*hindsightClient/.test(source), `${file} must not import hindsightClient`);
    assert.ok(!/require\(.*mcp/i.test(source), `${file} must not import an MCP client`);
  }
});

test('boundary: a ReasoningResult never carries a tool/capability/action/final-response field', async () => {
  const model = stubModelReturning(JSON.parse(VALID_OUTPUT));
  const result = await reasonIQ.evaluate(
    { text: 'Why is my website crashing?', evidence: [{ content: 'x' }] },
    { reasoningModel: model, ...silent }
  );
  const keys = Object.keys(result);
  for (const forbidden of ['tool', 'toolCalls', 'capability', 'provider', 'action', 'response', 'model']) {
    assert.ok(!keys.includes(forbidden), `ReasoningResult leaked a routing/response field: ${forbidden}`);
  }
});

test('boundary: reasonIQ.evaluate is a pure async function of its inputs — no shared mutable state', async () => {
  const model = stubModelReturning(JSON.parse(VALID_OUTPUT));
  const a = await reasonIQ.evaluate({ text: 'Why is my website crashing?', evidence: [{ content: 'x' }] }, { reasoningModel: model, ...silent });
  const b = await reasonIQ.evaluate({ text: 'Why is my website crashing?', evidence: [{ content: 'x' }] }, { reasoningModel: model, ...silent });
  assert.equal(a.interpretation, b.interpretation);
  assert.equal(a.hypotheses.length, b.hypotheses.length);
});

// === ReasonIQ 0.2 — Evidence & Context Reasoning ============================

const { assembleEvidence } = require('../src/reasoning/evidenceAssembler');

const KNOWN_EVIDENCE = [
  { id: 'hindsight-1', source: 'hindsight', type: 'memory', content: 'The team decided streaming in March', relevance: 0.9 },
  { id: 'upload-1', source: 'upload', type: 'document', content: 'Design doc: cancellation races are possible', relevance: 0.95 },
];

const DEEP_OUTPUT = JSON.stringify({
  interpretation: 'The user asks what follows from the design decisions.',
  evidence: [{ content: 'streaming was chosen in March', type: 'fact', origin: 'supplied' }],
  hypotheses: [{
    statement: 'Cancellation may race with the stream teardown.',
    confidence: 0.68,
    status: 'testing',
    verificationPlan: 'Reproduce with an aborted request mid-stream.',
    evidenceFor: ['upload-1', 'invented-id'],
    evidenceAgainst: ['hindsight-1', 'also-invented'],
    evidenceAssessments: [],
  }],
  contradictions: [{
    evidenceA: 'hindsight-1',
    evidenceB: 'made-up',
    description: 'March decision vs doc claim',
    significance: 'high',
    a: 'decided streaming in March',
    b: 'doc doubts streaming safety',
    explanation: 'The decision predates the documented concern.',
  }],
  uncertainties: [],
  informationGaps: ['No evidence about the non-streaming path.'],
  conclusions: [{
    statement: 'Streaming interruption may be caused by concurrent cancellation.',
    basis: 'inference',
    confidence: 0.84,
    evidence: ['upload-1', 'turn-81', 'hindsight-1'],
  }],
  sufficientForConclusion: false,
  confidence: 0.6,
});

test('0.2 gating: evidence alone is not a task — conversational/unknown turns stay shallow', () => {
  const evidence = [{ id: 'hindsight-1', source: 'hindsight', content: 'a recalled memory' }];
  assert.equal(decideReasoningDepth({ text: 'Weet je nog wat we over Luca bespraken?', evidence, intentDecision: { intent: null, status: 'unknown' } }), 'shallow');
  assert.equal(decideReasoningDepth({ text: 'Hoi Gaia', evidence, intentDecision: { intent: 'converse', status: 'accepted' } }), 'shallow');
  assert.equal(decideReasoningDepth({ text: 'Wat bedoel je?', evidence, intentDecision: { intent: null, status: 'ambiguous' } }), 'shallow');
  assert.equal(decideReasoningDepth({ text: 'Waarom deed je dat?', evidence, intentDecision: { intent: 'meta.question', status: 'accepted' } }), 'shallow');
});

test('0.2 gating: analysis-shaped turns WITH evidence go deep, as do explicit-evidence calls without a decision', () => {
  const evidence = [{ id: 'upload-1', source: 'upload', content: 'design doc' }];
  assert.equal(decideReasoningDepth({ text: 'Analyseer de race conditions.', evidence, intentDecision: { intent: 'inform.explain', status: 'accepted' } }), 'deep');
  assert.equal(decideReasoningDepth({ text: 'What can you derive from these earlier conversations?', evidence, intentDecision: { intent: 'memory.inspect', status: 'accepted' } }), 'deep');
  // Legacy shape (no IntentDecision supplied): presence of evidence still forces depth.
  assert.equal(decideReasoningDepth({ text: 'Why did the deploy fail?', evidence }), 'deep');
  assert.equal(decideReasoningDepth({ text: 'Hoi Gaia', evidence: [] }), 'shallow');
});

test('0.2 evaluate: shallow turn with evidence carries evidence metadata without a model call', async () => {
  const result = await evaluate(
    { text: 'Hoi Gaia', intentDecision: { intent: 'converse', status: 'accepted', confidence: 0.9 }, evidence: [{ id: 'hindsight-1', source: 'hindsight', content: 'memory' }] },
    { reasoningModel: { chat: async () => { throw new Error('must not be called'); }, isConfigured: () => true }, silent: true }
  );
  assert.equal(result.reasoningDepth, 'shallow');
  assert.equal(result.meta.evidenceCount, 1);
  assert.deepEqual(result.meta.evidenceSources, ['hindsight']);
});

test('0.2 provenance: invented evidence ids are stripped, known ids resolve to their source', async () => {
  let seenPrompt;
  const model = {
    chat: async (messages) => { seenPrompt = messages[1].content; return DEEP_OUTPUT; },
    isConfigured: () => true,
  };
  const result = await evaluate(
    { text: 'What follows from the design doc and our history?', intentDecision: { intent: 'inform.explain', status: 'accepted', confidence: 0.8 }, evidence: KNOWN_EVIDENCE },
    { reasoningModel: model, silent: true }
  );

  assert.equal(result.reasoningDepth, 'deep');
  const h = result.hypotheses[0];
  assert.deepEqual(h.evidenceFor, ['upload-1']); // invented-id dropped
  assert.deepEqual(h.evidenceAgainst, ['hindsight-1']); // also-invented dropped
  const c = result.conclusions[0];
  assert.deepEqual(c.evidence, [
    { id: 'upload-1', source: 'upload' },
    { id: 'hindsight-1', source: 'hindsight' }, // turn-81 was never supplied -> gone
  ]);
  const contra = result.contradictions[0];
  assert.equal(contra.evidenceA, 'hindsight-1');
  assert.equal(contra.evidenceB, null); // made-up id nulled, conflict text kept
  assert.equal(contra.significance, 'high');
  assert.ok(contra.a && contra.b); // v0.1 content sides preserved

  assert.equal(result.sufficientForConclusion, false);
  assert.equal(result.evidenceSufficient, false); // named alias mirrors it
  assert.equal(result.informationGaps.length, 1);

  // The model saw the ids and sources it was allowed to cite.
  assert.match(seenPrompt, /upload-1/);
  assert.match(seenPrompt, /hindsight-1/);
});

test('0.2 provenance: sufficient results mirror into evidenceSufficient = true', async () => {
  const output = JSON.parse(DEEP_OUTPUT);
  output.sufficientForConclusion = true;
  const model = { chat: async () => JSON.stringify(output), isConfigured: () => true };
  const result = await evaluate(
    { text: 'Analyseer dit.', intentDecision: { intent: 'inform.explain', status: 'accepted', confidence: 0.8 }, evidence: KNOWN_EVIDENCE },
    { reasoningModel: model, silent: true }
  );
  assert.equal(result.evidenceSufficient, true);
  assert.equal(result.sufficientForConclusion, true);
});

test("0.2 brief case B/C/D/E/F: one memory+document turn exercises use, reference, conflict, gap, hypothesis", async () => {
  const evidence = assembleEvidence({
    reflections: [{ text: 'Earlier chats concluded the emitter owns the wire format', scores: { final: 0.88 } }],
    attachments: [{ filename: 'design.md', content: 'The design doc claims the orchestrator owns the wire format.' }],
  });
  assert.equal(evidence.length, 2);
  assert.ok(evidence.every((e) => e.id && e.source));

  const output = JSON.stringify({
    interpretation: 'Comparing prior conclusions against the uploaded design.',
    hypotheses: [{
      statement: 'Wire-format ownership moved from emitter to orchestrator.',
      confidence: 0.55,
      status: 'testing',
      verificationPlan: null,
      evidenceFor: [evidence[0].id],
      evidenceAgainst: [evidence[1].id],
      evidenceAssessments: [],
    }],
    contradictions: [{
      evidenceA: evidence[0].id,
      evidenceB: evidence[1].id,
      description: 'Memory says emitter owns it; the upload says orchestrator.',
      significance: 'medium',
      a: 'emitter owns the wire format',
      b: 'orchestrator owns the wire format',
      explanation: 'Two sources disagree on ownership.',
    }],
    uncertainties: ['which source is more current'],
    informationGaps: ['No commit history evidence was supplied.'],
    conclusions: [],
    sufficientForConclusion: false,
    confidence: 0.5,
  });

  const lines = [];
  const result = await evaluate(
    { text: 'Wat kun je uit deze eerdere gesprekken afleiden?', intentDecision: { intent: 'memory.inspect', status: 'accepted', confidence: 0.8 }, evidence },
    { reasoningModel: { chat: async () => output, isConfigured: () => true }, silent: false, logger: (l) => lines.push(l) }
  );

  assert.deepEqual(result.hypotheses[0].evidenceFor, [evidence[0].id]);
  assert.equal(result.contradictions[0].significance, 'medium');
  assert.equal(result.evidenceSufficient, false);
  const logRecord = JSON.parse(lines[0]);
  assert.equal(logRecord.kind, 'reasoniq.result');
  assert.equal(logRecord.reasoningDepth, 'deep');
  assert.equal(logRecord.evidenceCount, 2);
  assert.deepEqual(logRecord.evidenceSources.sort(), ['hindsight', 'upload']);
  assert.equal(logRecord.evidenceSufficient, false);
  assert.equal(logRecord.contradictionCount, 1);
});
