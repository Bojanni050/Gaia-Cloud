'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildKnowledgePageTree,
  provisionKnowledgePages,
  shouldSearchKnowledgeBase,
  searchRelevantKnowledgePages,
  renderKnowledgePageContext,
} = require('../src/knowledgePages');

test('buildKnowledgePageTree: initial structure matches the spec (User/*, Projects/Gaia/*)', () => {
  const tree = buildKnowledgePageTree({ assistant: 'Gaia', user: 'Bojan' });
  assert.equal(tree.length, 2);

  const userFolder = tree.find((n) => n.name === 'User');
  assert.ok(userFolder);
  assert.equal(userFolder.kind, 'folder');
  assert.deepEqual(userFolder.children.map((c) => c.name), ['About', 'Preferences']);
  assert.ok(userFolder.children.every((c) => c.kind === 'page' && typeof c.sourceQuery === 'string'));

  const projects = tree.find((n) => n.name === 'Projects');
  assert.ok(projects);
  const gaia = projects.children.find((n) => n.name === 'Gaia');
  assert.ok(gaia);
  assert.deepEqual(
    gaia.children.map((c) => c.name),
    ['Overview', 'Architecture', 'Memory', 'Behavior', 'Communication', 'Decisions']
  );
});

test("buildKnowledgePageTree: Gaia's Communication page describes Gaia's own model, not the user's preferences", () => {
  const tree = buildKnowledgePageTree({ assistant: 'Gaia', user: 'Bojan' });
  const gaiaCommunication = tree.find((n) => n.name === 'Projects').children
    .find((n) => n.name === 'Gaia').children
    .find((n) => n.name === 'Communication');
  assert.ok(gaiaCommunication.sourceQuery.includes("Gaia's own communication model"));
  assert.ok(gaiaCommunication.sourceQuery.toLowerCase().includes('preferences'));
});

test('buildKnowledgePageTree: source queries use resolved identity, not hardcoded names', () => {
  const tree = buildKnowledgePageTree({ assistant: 'Gaia', user: 'Alice' });
  const userFolder = tree.find((n) => n.name === 'User');
  for (const page of userFolder.children) {
    assert.ok(page.sourceQuery.includes('Alice'), `${page.name} source query should mention Alice`);
    assert.ok(!page.sourceQuery.includes('Bojan'), `${page.name} source query must not hardcode Bojan`);
  }
  const gaiaFolder = tree.find((n) => n.name === 'Projects').children.find((n) => n.name === 'Gaia');
  for (const page of gaiaFolder.children) {
    assert.ok(!page.sourceQuery.includes('Hermes'), `${page.name} source query must not mention Hermes`);
  }
});

test('provisionKnowledgePages: creates the full tree on an empty bank', async () => {
  const createdFolders = [];
  const createdPages = [];
  let idCounter = 0;
  const hindsight = {
    getKnowledgeTree: async () => [],
    createKnowledgeFolder: async ({ name, parentId }) => {
      idCounter += 1;
      const id = `kf-${idCounter}`;
      createdFolders.push({ id, name, parentId });
      return { id, kind: 'folder', name, parentId: parentId ?? null };
    },
    createKnowledgePage: async ({ name, sourceQuery, parentId }) => {
      idCounter += 1;
      const id = `kp-${idCounter}`;
      createdPages.push({ id, name, sourceQuery, parentId });
      return { pageId: id, mentalModelId: `mm-${idCounter}`, operationId: null };
    },
  };

  const { created, updated, skipped } = await provisionKnowledgePages(hindsight);

  assert.equal(skipped.length, 0);
  assert.equal(updated.length, 0);
  // 2 top folders + 1 nested Gaia folder + 2 User pages + 6 Gaia pages
  assert.equal(created.length, 11);
  assert.equal(createdFolders.length, 3);
  assert.equal(createdPages.length, 8);
  // Nested pages get the resolved parent folder id, not null
  const about = createdPages.find((p) => p.name === 'About');
  const userFolder = createdFolders.find((f) => f.name === 'User');
  assert.equal(about.parentId, userFolder.id);
  const communication = createdPages.find((p) => p.name === 'Communication');
  const gaiaFolder = createdFolders.find((f) => f.name === 'Gaia');
  assert.equal(communication.parentId, gaiaFolder.id, 'Communication must be created under Projects/Gaia, not User');
});

// A fully-current existing tree — matches buildKnowledgePageTree() exactly,
// including each page's live `description` (Hindsight's stored source_query)
// — reused by both the idempotency test and the sync test below.
function buildCurrentExistingTree() {
  const spec = buildKnowledgePageTree({ assistant: 'Gaia', user: 'Bojan' });
  const gaiaPages = spec.find((n) => n.name === 'Projects').children.find((n) => n.name === 'Gaia').children;
  const userPages = spec.find((n) => n.name === 'User').children;
  const pageNode = (id, page, parentId) => ({ id, kind: 'page', name: page.name, parentId, description: page.sourceQuery, children: [] });
  return [
    {
      id: 'kf-user', kind: 'folder', name: 'User', parentId: null, children: userPages.map((p, i) => pageNode(`kp-user-${i}`, p, 'kf-user')),
    },
    {
      id: 'kf-projects', kind: 'folder', name: 'Projects', parentId: null, children: [
        {
          id: 'kf-gaia', kind: 'folder', name: 'Gaia', parentId: 'kf-projects',
          children: gaiaPages.map((p, i) => pageNode(`kp-gaia-${i}`, p, 'kf-gaia')),
        },
      ],
    },
  ];
}

test('provisionKnowledgePages: idempotent — a second run against a fully current tree creates and updates nothing', async () => {
  const stateful = {
    getKnowledgeTree: async () => buildCurrentExistingTree(),
    createKnowledgeFolder: async () => { throw new Error('should not create anything'); },
    createKnowledgePage: async () => { throw new Error('should not create anything'); },
    updateKnowledgeNode: async () => { throw new Error('should not update anything'); },
  };

  const { created, updated, skipped } = await provisionKnowledgePages(stateful);
  assert.equal(created.length, 0);
  assert.equal(updated.length, 0);
  assert.equal(skipped.length, 11);
});

test('provisionKnowledgePages: PATCHes an existing page whose source_query drifted from the spec', async () => {
  const tree = buildCurrentExistingTree();
  const behaviorPage = tree.find((n) => n.name === 'Projects').children
    .find((n) => n.name === 'Gaia').children
    .find((n) => n.name === 'Behavior');
  behaviorPage.description = 'a stale, superseded source_query';

  const patched = [];
  const stateful = {
    getKnowledgeTree: async () => tree,
    createKnowledgeFolder: async () => { throw new Error('should not create anything'); },
    createKnowledgePage: async () => { throw new Error('should not create anything'); },
    updateKnowledgeNode: async (nodeId, options) => { patched.push({ nodeId, options }); },
  };

  const { created, updated, skipped } = await provisionKnowledgePages(stateful);
  assert.equal(created.length, 0);
  assert.deepEqual(updated, ['Behavior']);
  assert.equal(skipped.length, 10);
  assert.equal(patched.length, 1);
  assert.equal(patched[0].nodeId, behaviorPage.id);
  assert.ok(patched[0].options.sourceQuery.length > 0);
  assert.notEqual(patched[0].options.sourceQuery, 'a stale, superseded source_query');
});

test('shouldSearchKnowledgeBase: gates trivial queries out', () => {
  assert.equal(shouldSearchKnowledgeBase(''), false);
  assert.equal(shouldSearchKnowledgeBase('hi'), false);
  assert.equal(shouldSearchKnowledgeBase('ok thanks'), false);
});

test('shouldSearchKnowledgeBase: opens on preference/architecture/decision language', () => {
  assert.equal(shouldSearchKnowledgeBase('What are my current preferences?'), true);
  assert.equal(shouldSearchKnowledgeBase("What's Gaia's architecture look like?"), true);
  assert.equal(shouldSearchKnowledgeBase('What decisions have been made about memory?'), true);
});

test('shouldSearchKnowledgeBase: opens on meta.question / meta.capability_question intents', () => {
  assert.equal(shouldSearchKnowledgeBase('tell me something', { intentDecision: { intent: 'meta.question' } }), true);
  assert.equal(
    shouldSearchKnowledgeBase('tell me something', { intentDecision: { intent: 'meta.capability_question' } }),
    true
  );
});

test('searchRelevantKnowledgePages: never throws when hindsight is unreachable', async () => {
  const hindsight = {
    searchKnowledgeBase: async () => { throw new Error('down'); },
    getKnowledgePage: async () => { throw new Error('down'); },
  };
  const result = await searchRelevantKnowledgePages(hindsight, 'what are my preferences?');
  assert.deepEqual(result, []);
});

test('searchRelevantKnowledgePages: skipped when the gate is closed', async () => {
  let called = false;
  const hindsight = {
    searchKnowledgeBase: async () => { called = true; return []; },
  };
  const result = await searchRelevantKnowledgePages(hindsight, 'hi');
  assert.equal(called, false);
  assert.deepEqual(result, []);
});

test('searchRelevantKnowledgePages: filters low-score hits and fetches full page bodies', async () => {
  const hindsight = {
    searchKnowledgeBase: async () => [
      { id: 'kp-1', name: 'Preferences', score: 0.8 },
      { id: 'kp-2', name: 'Irrelevant', score: 0.1 },
    ],
    getKnowledgePage: async (id) => {
      if (id === 'kp-1') return { id, name: 'Preferences', body: 'Prefers terse answers.' };
      throw new Error('should not fetch a filtered-out page');
    },
  };
  const result = await searchRelevantKnowledgePages(hindsight, 'what are my current preferences?');
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'Preferences');
  assert.equal(result[0].body, 'Prefers terse answers.');
});

test('renderKnowledgePageContext: null when no pages', () => {
  assert.equal(renderKnowledgePageContext([]), null);
  assert.equal(renderKnowledgePageContext(null), null);
});

test('renderKnowledgePageContext: frames as consolidated knowledge, distinct from raw memory', () => {
  const block = renderKnowledgePageContext([{ name: 'Preferences', body: 'Prefers terse answers.' }]);
  assert.ok(block.includes('consolidated knowledge'));
  assert.ok(block.includes('### Preferences'));
  assert.ok(block.includes('Prefers terse answers.'));
  assert.ok(!block.toLowerCase().includes('long-term memory'), 'should not reuse renderMemoryContext\'s framing');
});
