'use strict';

/**
 * One-time Hindsight tag reconciliation — bring every derived record into the
 * single canonical `gaia:*` namespace.
 *
 * Context: Hindsight has accumulated derived units under two overlapping
 * schemes — Foundation's old `foundation:fact` (written by Foundation's
 * hindsightSync) and Gaia's earlier `gaia:hypothesis`/`gaia:pattern` (written
 * by the retired mayfly adapters). Cognition is now the source of truth, so
 * the store is rebuilt from it under one namespace (see cognitionSync.js).
 *
 * Safe by default: without --apply this only SURVEYS and prints what it would
 * do. Nothing is written, invalidated or retained until you pass --apply.
 *
 *   node scripts/reconcile-hindsight-tags.js                 # dry run
 *   node scripts/reconcile-hindsight-tags.js --apply         # re-push from Cognition
 *   node scripts/reconcile-hindsight-tags.js --apply --clear # invalidate gaia:* first, then re-push
 *
 * Caveat: --clear assumes Cognition holds the records to rebuild from. If the
 * cognition database was emptied when the service was decommissioned, re-push
 * will produce nothing — survey first; the dry run prints the Cognition counts.
 */

const { createHindsightClient } = require('../src/hindsightClient');
const { createCognitionClient } = require('../src/cognitionClient');
const { createCognitionSync } = require('../src/reasoning/cognitionSync');

function parseArgs(argv = []) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  return { apply: flags.has('--apply'), clear: flags.has('--clear') };
}

async function survey({ hindsight, cognition }) {
  const active = await hindsight.listMemories({ q: 'gaia', type: 'world', limit: 200, state: 'valid' }).catch(() => []);
  let gaiaHypotheses = 0;
  let gaiaPatterns = 0;
  for (const u of Array.isArray(active) ? active : []) {
    const tags = (u && u.tags) || [];
    if (tags.includes('gaia:hypothesis') || tags.includes('gaia:confirmed_fact')) gaiaHypotheses += 1;
    if (tags.includes('gaia:pattern')) gaiaPatterns += 1;
  }

  // Legacy units can't be listed by tag (the list endpoint has no tag filter),
  // so this is a best-effort recall probe — indicative, never exhaustive.
  let legacyFacts = null;
  try {
    const found = await hindsight.recall('foundation fact', {
      types: ['world'], tags: ['foundation:fact'], tagsMatch: 'all_strict',
    });
    legacyFacts = Array.isArray(found) ? found.length : 0;
  } catch (_) {
    legacyFacts = null;
  }

  const hypotheses = await cognition.listHypotheses().catch(() => null);
  const patterns = await cognition.listPatterns().catch(() => null);

  return {
    hindsight: { activeGaiaHypotheses: gaiaHypotheses, activeGaiaPatterns: gaiaPatterns, legacyFoundationFacts: legacyFacts },
    cognition: { hypotheses: hypotheses ? hypotheses.length : null, patterns: patterns ? patterns.length : null },
  };
}

/**
 * @param {{ argv?: string[], env?: NodeJS.ProcessEnv, deps?: object, log?: Function }} [options]
 */
async function runReconcile({ argv = process.argv.slice(2), env = process.env, deps = {}, log = console.log } = {}) {
  const { apply, clear } = parseArgs(argv);

  const hindsight = deps.hindsight || createHindsightClient({
    baseUrl: env.HINDSIGHT_URL || 'http://100.65.0.15:8888',
    bankId: env.HINDSIGHT_LOGOS_BANK_ID || 'gaia-logos',
  });
  const cognition = deps.cognition || createCognitionClient({
    baseUrl: env.COGNITION_URL || 'http://100.65.0.15:8890',
    bankId: env.COGNITION_BANK_ID || 'gaia',
  });
  const sync = deps.sync || createCognitionSync({ hindsight, cognition });

  const before = await survey({ hindsight, cognition });
  log(`[reconcile] mode: ${apply ? 'APPLY' : 'dry-run'}${clear ? ' (clear)' : ''}`);
  log(`[reconcile] Hindsight active  gaia:hypothesis=${before.hindsight.activeGaiaHypotheses} gaia:pattern=${before.hindsight.activeGaiaPatterns} legacy foundation:fact≈${before.hindsight.legacyFoundationFacts}`);
  log(`[reconcile] Cognition records hypotheses=${before.cognition.hypotheses} patterns=${before.cognition.patterns}`);

  if (!apply) {
    log('[reconcile] dry run — nothing written. Re-run with --apply to re-push from Cognition.');
    return { apply, clear, before, result: null };
  }

  const result = await sync.reconcile({ clear });
  log(`[reconcile] done: ${JSON.stringify(result)}`);
  return { apply, clear, before, result };
}

if (require.main === module) {
  runReconcile()
    .then(() => process.exit(0))
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`[reconcile] failed: ${err.message}`);
      process.exit(1);
    });
}

module.exports = { runReconcile, survey, parseArgs };
