'use strict';

/**
 * One-off structural migration (2026-08-29): the Knowledge Page brief was
 * revised so `Communication` moves from `User/Communication` (the user's
 * own communication preferences — that content now lives on
 * `User/Preferences` instead) to `Projects/Gaia/Communication` (Gaia's OWN
 * communication model — tone, verbosity, when to ask questions, etc.,
 * distinct from the user's preferences).
 *
 * This MOVES the existing page (reparents it via updateKnowledgeNode and
 * updates its source_query to the new definition) rather than delete +
 * recreate, so its backing mental model id and any refresh history survive
 * the restructuring. Idempotent: if `User/Communication` no longer exists
 * (already migrated, or a fresh bank), this is a no-op and the follow-up
 * provisionKnowledgePages() call creates `Projects/Gaia/Communication`
 * fresh instead.
 *
 * After the move, runs provisionKnowledgePages() to fill in anything else
 * missing and sync every page's source_query to the current spec.
 *
 * Run once per bank that already had the OLD tree (both the old and new
 * Hindsight addresses, if both still hold live knowledge-base data — see
 * project_gaia_knowledge_pages.md):
 *
 *   HINDSIGHT_URL=http://100.65.0.15:8888 HINDSIGHT_BANK_ID=bojan \
 *     node scripts/migrate-knowledge-pages-2026-08-29.js
 */

const { createHindsightClient } = require('../src/hindsightClient');
const { buildKnowledgePageTree, provisionKnowledgePages } = require('../src/knowledgePages');

async function main() {
  const baseUrl = process.env.HINDSIGHT_URL || 'http://100.65.0.15:8888';
  const bankId = process.env.HINDSIGHT_BANK_ID || 'bojan';
  const hindsight = createHindsightClient({ baseUrl, bankId });

  const roots = await hindsight.getKnowledgeTree();
  const userFolder = roots.find((n) => n.kind === 'folder' && n.name === 'User');
  const projectsFolder = roots.find((n) => n.kind === 'folder' && n.name === 'Projects');
  const gaiaFolder = projectsFolder && (projectsFolder.children || []).find((n) => n.kind === 'folder' && n.name === 'Gaia');

  const oldCommunication = userFolder && (userFolder.children || []).find((n) => n.kind === 'page' && n.name === 'Communication');
  const newCommunicationAlreadyThere = gaiaFolder && (gaiaFolder.children || []).some((n) => n.kind === 'page' && n.name === 'Communication');

  if (!oldCommunication) {
    console.log('no User/Communication page found — nothing to migrate (already moved, or fresh bank).');
  } else if (newCommunicationAlreadyThere) {
    console.warn(
      `WARNING: both User/Communication (${oldCommunication.id}) and Projects/Gaia/Communication already exist. `
      + 'Not touching either automatically — resolve the duplicate by hand (likely delete the old User/Communication '
      + 'once you have confirmed Projects/Gaia/Communication has the content you want).'
    );
  } else if (!gaiaFolder) {
    console.warn('Projects/Gaia folder not found — run provision-knowledge-pages.js first, then re-run this migration.');
  } else {
    const gaiaCommunicationQuery = buildKnowledgePageTree()
      .find((n) => n.name === 'Projects').children
      .find((n) => n.name === 'Gaia').children
      .find((n) => n.name === 'Communication').sourceQuery;
    await hindsight.updateKnowledgeNode(oldCommunication.id, {
      parentId: gaiaFolder.id,
      sourceQuery: gaiaCommunicationQuery,
    });
    console.log(`moved Communication (${oldCommunication.id}) from User/ to Projects/Gaia/ and updated its source_query.`);
  }

  console.log('\nsyncing the rest of the tree against the current spec...');
  const { created, updated, skipped } = await provisionKnowledgePages(hindsight, {
    log: (msg) => console.log(msg),
  });
  console.log(`\ndone. created: ${created.length}, updated: ${updated.length}, unchanged: ${skipped.length}`);
  if (created.length > 0) console.log('created:', created.join(', '));
  if (updated.length > 0) console.log('updated (source_query changed):', updated.join(', '));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
