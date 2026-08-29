'use strict';

/**
 * Hindsight Knowledge Pages — a living, consolidated-knowledge layer on
 * top of Gaia's existing memory system (memory.js's recall/reflect,
 * hindsightClient.js's mental models). This module does NOT replace or
 * modify that memory architecture; it is additive.
 *
 * The distinction this module exists to preserve:
 *   - Memory (Hindsight raw facts, via recall/reflect): what was said,
 *     observed, decided, or happened at a specific point in time.
 *   - Knowledge Page (this module): the CURRENT consolidated understanding
 *     derived from those memories, kept up to date by Hindsight's own
 *     consolidation-triggered refresh.
 *
 * Architecture:
 *   Conversation -> Hindsight Retain -> Memories -> Hindsight Consolidation
 *     -> Knowledge Pages -> IntentIQ / ReasonIQ / Conversation
 *
 * A Knowledge Page IS a Hindsight mental model wearing a knowledge-base
 * tree-node identity (hindsightClient.js's createKnowledgePage/
 * getKnowledgePage/searchKnowledgeBase/getKnowledgeTree) — no separate
 * database, no duplicate memory store. Everything here goes through the
 * same hindsightClient bound to the same bank recall/reflect already use.
 *
 * Identity: page content is synthesized by Hindsight from this bank's
 * memories, which are themselves stored under the Gaia <-> user identity
 * (identity.js) — never "Hermes Agent". The source queries below use
 * getAssistantIdentity()/getUserIdentity() rather than hardcoded names, so
 * a different deployed user identity requires no code change here.
 */

const { getAssistantIdentity, getUserIdentity } = require('./identity');

/**
 * The initial Knowledge Page tree (User/*, Projects/Gaia/*). Each entry's
 * `path` is a '/'-joined breadcrumb used only for idempotent provisioning
 * (matching existing tree nodes by name+parent) — it is not a Hindsight
 * concept. `sourceQuery` is a function of the resolved identity so nothing
 * user-specific is hardcoded into this structure.
 *
 * Deliberately not auto-extended: per the brief, no additional pages are
 * created during initial provisioning beyond this set unless Hindsight
 * itself requires it (e.g. it manages the folder tree; it never invents
 * pages).
 */
function buildKnowledgePageTree({ assistant, user } = {}) {
  const a = assistant || getAssistantIdentity().displayName;
  const u = user || getUserIdentity().displayName;

  return [
    {
      name: 'User',
      kind: 'folder',
      children: [
        {
          name: 'About',
          kind: 'page',
          // "Who is the user?" — based only on what the user explicitly
          // stated or what is reliably established through conversation.
          sourceQuery: `Who is ${u} — name or preferred name, profession, relevant interests, `
            + `recurring activities, long-term projects, and other stable facts that help ${a} `
            + `understand ${u}, based only on what ${u} has explicitly stated or what is `
            + 'reliably established through conversation? Include only stable or sufficiently '
            + 'established information. Exclude assumptions, guesses, temporary statements, and '
            + 'inferred sensitive characteristics.',
        },
        {
          name: 'Preferences',
          kind: 'page',
          // "What does the user prefer?"
          sourceQuery: `What are ${u}'s current preferences, choices, habits, and recurring `
            + `preferences relevant to ${a} — preferred tools or technologies, creative `
            + 'preferences, workflow preferences, recurring choices, preferred level of detail, '
            + `things ${u} likes or dislikes, and preferences that affect how ${a} should assist `
            + `${u}? When newer information contradicts older information, prefer the newer `
            + 'reliable information; do not present an obsolete preference as still current.',
        },
      ],
    },
    {
      name: 'Projects',
      kind: 'folder',
      children: [
        {
          name: 'Gaia',
          kind: 'folder',
          children: [
            {
              name: 'Overview',
              kind: 'page',
              sourceQuery: `What is ${a} — its purpose, major capabilities, current development `
                + 'goals, important terminology, and high-level product concepts? A living, '
                + `current project overview of ${a}.`,
            },
            {
              name: 'Architecture',
              kind: 'page',
              // "How is Gaia built?"
              sourceQuery: `What is ${a}'s current technical architecture — major components `
                + '(including IntentIQ, ReasonIQ, the Conversation pipeline, and the Hindsight '
                + 'integration), the relationships between those components, data flow, external '
                + 'services and APIs, and important architectural boundaries? Reflect the CURRENT '
                + 'architecture; do not preserve obsolete architecture as current.',
            },
            {
              name: 'Memory',
              kind: 'page',
              sourceQuery: `What is ${a}'s current memory architecture and memory principles — `
                + 'Hindsight usage, retention, recall, consolidation, Knowledge Pages, memory '
                + `categories, identity handling, and the distinction between raw memories and `
                + `consolidated knowledge? Describe how ${a}'s memory system works in general, `
                + 'not individual user memories.',
            },
            {
              name: 'Behavior',
              kind: 'page',
              // "How should Gaia behave?"
              sourceQuery: `What is ${a}'s intended behavioral model — its role, interaction `
                + 'principles, reasoning behavior, memory behavior, tool usage, when it should '
                + 'ask questions, how it should handle uncertainty, important behavioral '
                + 'constraints, and decision-making principles? Exclude temporary implementation '
                + 'details that are not genuine, permanent behavioral rules.',
            },
            {
              name: 'Communication',
              kind: 'page',
              // "How should Gaia communicate?" — Gaia's OWN communication
              // model, distinct from User/Preferences (the user's personal
              // preferences); not duplicated here unless also part of
              // Gaia's general communication behavior.
              sourceQuery: `How should ${a} communicate with ${u} — ${a}'s conversational tone, `
                + 'desired level of directness, response structure, appropriate verbosity, how '
                + `${a} should explain things, how ${a} should handle uncertainty, when ${a} `
                + `should ask clarifying questions, when ${a} should make suggestions and when `
                + `${a} should avoid unnecessary ones, how ${a} should respond to corrections, `
                + `principles for maintaining natural conversation, language and terminology `
                + `conventions, and rules for maintaining ${a}'s identity and voice? Describe `
                + `${a}'s own communication model, not ${u}'s personal preferences — those `
                + 'belong on the User Preferences page and should not be duplicated here unless '
                + `they are also part of ${a}'s general communication behavior.`,
            },
            {
              name: 'Decisions',
              kind: 'page',
              // "What important decisions have been made about Gaia, and why?"
              sourceQuery: `What important architectural, product, and design decisions have `
                + `been made during ${a}'s development? For each significant decision, preserve `
                + 'where available: the decision, the reason, the date or approximate timeframe, '
                + 'alternatives considered, and current status. When a decision is later '
                + 'changed, mark the previous decision as superseded rather than silently '
                + 'deleting it — the latest valid decision must remain clearly identifiable.',
            },
          ],
        },
      ],
    },
  ];
}

/**
 * Idempotently provisions the Knowledge Page tree: walks the spec,
 * compares against the bank's existing tree (by name+parent, not id — ids
 * are assigned by Hindsight and unknown ahead of time), and creates only
 * what's missing. Safe to re-run after editing buildKnowledgePageTree() —
 * same re-run-safe posture as scripts/provision-mental-models.js: an
 * existing page whose `sourceQuery` no longer matches the spec gets
 * PATCHed (via updateKnowledgeNode, which schedules an async rebuild)
 * rather than left stale, so editing a page's definition here and
 * re-running is the supported way to evolve a page's purpose in place.
 * This does NOT reparent/rename/delete anything on its own — a structural
 * move (a page changing folders) needs an explicit one-off migration, see
 * scripts/migrate-knowledge-pages-2026-08-29.js for the Communication move.
 * @param {ReturnType<import('./hindsightClient').createHindsightClient>} hindsight
 * @param {{ tree?: Array<object>, log?: (msg: string) => void }} [options]
 * @returns {Promise<{ created: string[], updated: string[], skipped: string[] }>}
 */
async function provisionKnowledgePages(hindsight, { tree, log = () => {} } = {}) {
  const spec = tree || buildKnowledgePageTree();
  const existingRoots = await hindsight.getKnowledgeTree();

  const created = [];
  const updated = [];
  const skipped = [];

  function findExisting(nodes, name, parentId) {
    return (nodes || []).find((n) => n.name === name && (n.parentId ?? null) === (parentId ?? null));
  }

  async function ensureNode(node, parentId, siblingsHint) {
    const existing = findExisting(siblingsHint, node.name, parentId);
    if (existing) {
      if (node.kind === 'page' && node.sourceQuery && existing.description !== node.sourceQuery) {
        await hindsight.updateKnowledgeNode(existing.id, { sourceQuery: node.sourceQuery });
        updated.push(node.name);
        log(`updated source_query: ${node.name}`);
      } else {
        skipped.push(node.name);
      }
      if (node.kind === 'folder' && Array.isArray(node.children)) {
        for (const child of node.children) {
          // eslint-disable-next-line no-await-in-loop
          await ensureNode(child, existing.id, existing.children);
        }
      }
      return existing.id;
    }

    if (node.kind === 'folder') {
      const folder = await hindsight.createKnowledgeFolder({ name: node.name, parentId });
      created.push(node.name);
      log(`created folder: ${node.name}`);
      if (Array.isArray(node.children)) {
        for (const child of node.children) {
          // eslint-disable-next-line no-await-in-loop
          await ensureNode(child, folder.id, []);
        }
      }
      return folder.id;
    }

    const page = await hindsight.createKnowledgePage({
      name: node.name,
      sourceQuery: node.sourceQuery,
      parentId,
    });
    created.push(node.name);
    log(`created page: ${node.name}`);
    return page.pageId;
  }

  for (const root of spec) {
    // eslint-disable-next-line no-await-in-loop
    await ensureNode(root, null, existingRoots);
  }

  return { created, updated, skipped };
}

// --- turn-time retrieval ---------------------------------------------------

/**
 * Cheap, keyword-driven gate for whether this turn's query is the kind of
 * "what's the current state / current understanding" question a Knowledge
 * Page answers, as opposed to "what did I say / what happened" (raw
 * recall's job — memoryPolicy.shouldRecall). Deliberately permissive
 * (search_knowledge_base is a hybrid keyword+vector lookup, not an LLM
 * call, so a false-positive lookup is cheap) but not unconditional, so a
 * trivial greeting doesn't pay a round-trip for nothing.
 * @param {string} query
 * @param {{ intentDecision?: object|null }} [context]
 */
const KNOWLEDGE_SIGNAL_PATTERNS = [
  /\bprefer(ence|ences|red)?\b/i,
  /\barchitecture\b/i,
  /\bhow (do|does) (gaia|you) work\b/i,
  /\bwhat (are|is) (gaia|your)\b/i,
  /\bcurrent(ly)?\b/i,
  /\bdecision(s)?\b/i,
  /\bwho (am i|are you)\b/i,
  /\babout (me|yourself|gaia)\b/i,
  /\bcommunicat/i,
  /\bbehavior|behaviour\b/i,
  /\boverview\b/i,
];

function shouldSearchKnowledgeBase(query, context = {}) {
  const text = (query || '').trim();
  if (text.length < 8) return false;
  const intent = context && context.intentDecision;
  if (intent && intent.intent === 'meta.question') return true;
  if (intent && intent.intent === 'meta.capability_question') return true;
  return KNOWLEDGE_SIGNAL_PATTERNS.some((pattern) => pattern.test(text));
}

const MAX_KNOWLEDGE_RESULTS = 3;
const MIN_KNOWLEDGE_SCORE = 0.3;

/**
 * Best-effort, policy-gated Knowledge Page search. Never throws — same
 * "must never affect the turn" contract as memory.js's
 * recallRelevantContext. Reads each hit's page id and fetches its full
 * markdown body via getKnowledgePage (search returns only a short
 * snippet).
 * @param {ReturnType<import('./hindsightClient').createHindsightClient>} hindsight
 * @param {string} query
 * @param {{ intentDecision?: object|null }} [options]
 * @returns {Promise<Array<{ id: string, name: string, body: string|null }>>}
 */
async function searchRelevantKnowledgePages(hindsight, query, options = {}) {
  if (!hindsight || !query || !query.trim()) return [];
  if (!shouldSearchKnowledgeBase(query, options)) return [];
  let hits;
  try {
    hits = await hindsight.searchKnowledgeBase(query, { limit: MAX_KNOWLEDGE_RESULTS });
  } catch (_) {
    return [];
  }
  const relevant = (hits || []).filter((h) => typeof h.score !== 'number' || h.score >= MIN_KNOWLEDGE_SCORE);
  const pages = await Promise.all(
    relevant.slice(0, MAX_KNOWLEDGE_RESULTS).map(async (hit) => {
      const page = await hindsight.getKnowledgePage(hit.id).catch(() => null);
      return { id: hit.id, name: hit.name, body: page ? page.body : null };
    })
  );
  return pages.filter((p) => p.body && p.body.trim());
}

/**
 * Renders Knowledge Page results into one system-message block, framed
 * distinctly from raw memory context (renderMemoryContext in memory.js):
 * this is CURRENT CONSOLIDATED UNDERSTANDING, not individual recalled
 * observations, and should read to Gaia as standing knowledge rather than
 * evidence to cite verbatim.
 * @param {Array<{ name: string, body: string|null }>} pages
 * @returns {string|null}
 */
function renderKnowledgePageContext(pages) {
  const sections = (pages || [])
    .filter((p) => p && p.body && p.body.trim())
    .map((p) => `### ${p.name}\n${p.body.trim()}`);
  if (sections.length === 0) return null;
  return [
    "This is Gaia's current consolidated knowledge on the topic — a living",
    "summary Hindsight keeps up to date from Gaia's memories, distinct from",
    'any single recalled observation. Use only what genuinely applies to this',
    'turn; do not quote it verbatim or announce that you are consulting it.',
    '',
    ...sections,
  ].join('\n');
}

module.exports = {
  buildKnowledgePageTree,
  provisionKnowledgePages,
  shouldSearchKnowledgeBase,
  searchRelevantKnowledgePages,
  renderKnowledgePageContext,
  MAX_KNOWLEDGE_RESULTS,
  MIN_KNOWLEDGE_SCORE,
};
