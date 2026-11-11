'use strict';

/**
 * Context-aware foundation document selection — a faithful port of
 * gaia-web's client-side selection (state/intentIQ.js's deriveIntent +
 * foundation/rules.js + foundation/selector.js + foundation/index.js's
 * getPrompt), not a rebuild on real Logos judgment. Deliberately named
 * the same way the source module names itself: this is NOT Logos's
 * semantic intentIQ (gaia/logos/intentIQ, an LLM call) — it is the fast,
 * synchronous, zero-latency local heuristic that picks which documents
 * accompany a turn, ported here so gaia-api can produce the same system
 * prompt Web's client-side lifecycle produces today (docs/web-migration-plan.md
 * Phase B — a parity port, confirmed with the user, not new authority).
 */
const fs = require('fs');
const path = require('path');

const boundary = (word) => new RegExp(`\\b${word}\\b`, 'i');

// Bilingual (NL/EN) — kept identical to gaia-web/src/gaia/state/intentIQ.js.
const TECHNICAL_SIGNALS = [
  'implement', 'implementeer', 'implementeren',
  'refactor', 'refactoren', 'refactoring',
  'architecture', 'architectuur',
  'prompt',
  'code', 'codeer', 'codeert',
  'bug', 'fout', 'error',
  'deploy', 'deployen', 'deployment',
  'database', 'databank',
  'api',
  'function', 'functie',
  'component',
].map(boundary);

const GAIA_SIGNALS = [
  /why did you answer (that|like that)/i,
  /what are your principles/i,
  /wat zijn je principes/i,
  /how do you think/i,
  /hoe denk je/i,
  /\bevolution\b/i,
  /\bevolutie\b/i,
  /who are you/i,
  /wie ben je/i,
];

function score(text, patterns) {
  return patterns.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0);
}

/**
 * Classifies intent from recent user turns, not the full conversation.
 * @param {Array<{role: string, content: string}>} messages
 * @param {number} [windowSize]
 * @returns {{ type: 'technical'|'gaia'|'conversation' }}
 */
function deriveIntent(messages, windowSize = 3) {
  const recentUserText = (messages || [])
    .filter((m) => m.role === 'user')
    .slice(-windowSize)
    .map((m) => m.content || '')
    .join(' ');

  if (!recentUserText.trim()) return { type: 'conversation' };

  const gaiaScore = score(recentUserText, GAIA_SIGNALS);
  const technicalScore = score(recentUserText, TECHNICAL_SIGNALS);

  if (gaiaScore === 0 && technicalScore === 0) return { type: 'conversation' };
  return gaiaScore >= technicalScore ? { type: 'gaia' } : { type: 'technical' };
}

// The classifier above is still gaia-web's. The document SETS are not: through
// 2026-11-11 they were kept identical to gaia-web/src/gaia/foundation/rules.js, which
// sent the two heaviest documents with a turn — `architecture.md` (~33 kB, on any turn
// whose last three user messages mentioned code, api, fout, bug, database, …) and
// `evolution.md` (~131 kB, on any turn asking "wie ben je" or mentioning "evolutie").
// Both are the archive: code-level detail and engineering history. A turn now gets
// `identity.md` instead — the short self-knowledge document — while both full documents
// stay in the artifact for clients and for anyone reading the repo. Gaia-Web's own copy
// of these rules lives in its repository and is not changed by this.
const RULES = [
  {
    name: 'Technical',
    condition: (context) => context.type === 'technical',
    documents: ['soul.md', 'principles.md', 'lexicon.md', 'identity.md'],
  },
  {
    name: 'Gaia',
    condition: (context) => context.type === 'gaia',
    documents: ['soul.md', 'principles.md', 'lexicon.md', 'identity.md'],
  },
  {
    name: 'Conversation',
    condition: (context) => context.type === 'conversation',
    documents: ['soul.md', 'principles.md', 'lexicon.md'],
  },
];

const FALLBACK_DOCUMENTS = ['soul.md', 'principles.md', 'lexicon.md'];

/** @param {{ type: string }} context */
function selectDocuments(context) {
  for (const rule of RULES) {
    if (rule.condition(context)) return rule.documents;
  }
  return FALLBACK_DOCUMENTS;
}

/**
 * Joins selected documents' content exactly as gaia-web's
 * foundation/index.js's getPrompt does — '\n\n---\n\n' between documents,
 * in selection order, silently skipping any document not present in the
 * artifact (matches getPrompt's `.filter(content => content !== undefined)`).
 * @param {Record<string, string>} documents artifact.documents
 * @param {Array<{role: string, content: string}>} messages
 */
function buildSystemPrompt(documents, messages) {
  const context = deriveIntent(messages);
  const selected = selectDocuments(context);
  return selected
    .map((filename) => documents[filename])
    .filter((content) => content !== undefined)
    .join('\n\n---\n\n');
}

const CANDIDATES = [
  () => process.env.FOUNDATION_ARTIFACT_PATH,
  // Dev: services/gaia-api/src → services/gaia-api/foundation-artifact.json
  () => path.resolve(__dirname, '../foundation-artifact.json'),
  // Container: materialized next to the app by the deploy step (see
  // .github/workflows/deploy.yml) and baked in by the Dockerfile.
  () => '/app/foundation-artifact.json',
];

function resolveArtifactPath() {
  for (const candidate of CANDIDATES) {
    const value = candidate();
    if (value && fs.existsSync(value)) return value;
  }
  return null;
}

/**
 * Loads the foundation artifact's documents dictionary. Missing/unreadable
 * is a hard startup failure — same posture as soul.js: a Gaia API that
 * cannot select context-aware documents must not silently fall back to
 * guessing (dev note: run `node ../../scripts/build-foundation-artifact.js`
 * from the repo root, or set FOUNDATION_ARTIFACT_PATH, before `npm start`).
 * @returns {Record<string, string>}
 */
function loadFoundationDocuments() {
  const resolved = resolveArtifactPath();
  if (!resolved) {
    throw new Error(
      'foundation-artifact.json not found — set FOUNDATION_ARTIFACT_PATH, or run ' +
      'scripts/build-foundation-artifact.js from the repo root. Refusing to start without it.'
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, 'utf-8'));
  } catch (err) {
    throw new Error(`foundation-artifact.json at ${resolved} is not valid JSON: ${err.message}`);
  }
  if (!parsed.documents || typeof parsed.documents !== 'object') {
    throw new Error(`foundation-artifact.json at ${resolved} has no "documents" object.`);
  }
  return parsed.documents;
}

module.exports = {
  deriveIntent,
  selectDocuments,
  buildSystemPrompt,
  loadFoundationDocuments,
  resolveArtifactPath,
};
