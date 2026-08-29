'use strict';

/**
 * One-time (or re-run-safe) provisioning of Gaia's initial Knowledge Page
 * tree (User/{About,Preferences}, Projects/Gaia/{Overview,Architecture,
 * Memory,Behavior,Communication,Decisions}) on the same Hindsight bank
 * recall/reflect and the mental models already use (see
 * services/gaia-api/src/knowledgePages.js and hindsightClient.js — no
 * separate database, no duplicate memory store). Not part of the running
 * service; run manually (from a machine that can reach HINDSIGHT_URL, e.g.
 * over Tailscale, or on the VPS itself) whenever the initial page set
 * needs to be (re-)created or its definitions have changed:
 *
 *   HINDSIGHT_URL=http://100.65.0.15:8888 HINDSIGHT_BANK_ID=bojan \
 *     node scripts/provision-knowledge-pages.js
 *
 * Idempotent: provisionKnowledgePages() checks the bank's existing
 * knowledge-base tree by name+parent before creating anything, fills in
 * whatever is still missing, and PATCHes any existing page whose
 * source_query has drifted from the current spec (triggering an async
 * rebuild) — same re-run-safe posture as provision-mental-models.js. It
 * does NOT reparent an existing page on its own; a structural move needs
 * its own one-off migration script (see migrate-knowledge-pages-*.js).
 */

const { createHindsightClient } = require('../src/hindsightClient');
const { provisionKnowledgePages } = require('../src/knowledgePages');

async function main() {
  const baseUrl = process.env.HINDSIGHT_URL || 'http://100.65.0.15:8888';
  const bankId = process.env.HINDSIGHT_BANK_ID || 'bojan';

  const hindsight = createHindsightClient({ baseUrl, bankId });

  const { created, updated, skipped } = await provisionKnowledgePages(hindsight, {
    log: (msg) => console.log(msg),
  });

  console.log(`\ndone. created: ${created.length}, updated: ${updated.length}, unchanged: ${skipped.length}`);
  if (created.length > 0) console.log('created:', created.join(', '));
  if (updated.length > 0) console.log('updated (source_query changed):', updated.join(', '));
  if (skipped.length > 0) console.log('unchanged:', skipped.join(', '));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
