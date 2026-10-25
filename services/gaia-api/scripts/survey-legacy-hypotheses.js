#!/usr/bin/env node
'use strict';

/**
 * Survey (and optionally lapse) the legacy `proposed` hypotheses — the
 * residue of the old per-turn formation model.
 *
 * Context: before migration 015 a hypothesis was formed per turn from one
 * recall snippet, and the evidence text behind it lived only in that turn's
 * prompt — the store kept turn-local ids (`hindsight-1`, `turn-2`) in
 * evidence_for/evidence_against, never the text. Those records can never be
 * re-formed (the belief formation pass groups OBSERVATIONS, which they have
 * no provenance for) and never re-weighed (their ids resolve to nothing).
 * The review card shows them as "Waar dit op rust is niet bewaard gebleven".
 *
 * This script classifies every `proposed` hypothesis into:
 *
 *   current                 evidence_items carries snapshots (post-015
 *                           model) — NEVER touched, not even with --apply.
 *   legacy_no_ground        no evidence at all: no items, no for/against ids.
 *   legacy_refs_without_text  for/against ids but no evidence_items — the ids
 *                           are turn-local and resolve to nothing, so the
 *                           record has no usable ground left.
 *
 * Both legacy categories are what the handover calls "wezen van het oude
 * model". The expiry scan (reasoning/expiryScan.js) only lapses the
 * no-ground half (it never expires a record that has evidence_for), so the
 * refs_without_text half lingers in `proposed` forever — this survey is the
 * one-time cleanup for exactly that residue.
 *
 * Safe by default: without --apply this only SURVEYS and prints the legacy
 * records (id, dates, counts, statement preview) so a person can settle the
 * ones worth settling. --apply lapses the legacy records via
 * POST /hypotheses/:id/expire — `verlopen`, NOT `rejected`: not a quarantine,
 * and `expired → testing` revives the record if evidence ever arrives.
 * `current` records are never written.
 *
 *   node scripts/survey-legacy-hypotheses.js            # dry run
 *   node scripts/survey-legacy-hypotheses.js --apply    # lapse the legacy records
 *
 * Reads Cognition over HTTP (COGNITION_URL, COGNITION_BANK_ID — same env as
 * scripts/reconcile-hindsight-tags.js). Read-only unless --apply.
 */

const { createCognitionClient } = require('../src/cognitionClient');

function parseArgs(argv = []) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  return { apply: flags.has('--apply') };
}

/**
 * @param {object} row a Cognition hypotheses row (snake_case)
 * @returns {'current'|'legacy_no_ground'|'legacy_refs_without_text'}
 */
function classify(row) {
  const items = Array.isArray(row && row.evidence_items) ? row.evidence_items : [];
  const forIds = Array.isArray(row && row.evidence_for) ? row.evidence_for : [];
  const againstIds = Array.isArray(row && row.evidence_against) ? row.evidence_against : [];
  if (items.length > 0) return 'current';
  if (forIds.length === 0 && againstIds.length === 0) return 'legacy_no_ground';
  return 'legacy_refs_without_text';
}

function toRecord(row) {
  return {
    id: String(row.id),
    statement: String(row.statement || ''),
    confidence: row.confidence != null ? Number(row.confidence) : null,
    createdAt: row.created_at || row.createdAt || null,
    updatedAt: row.updated_at || row.updatedAt || null,
    evidenceFor: (Array.isArray(row.evidence_for) ? row.evidence_for : []).length,
    evidenceAgainst: (Array.isArray(row.evidence_against) ? row.evidence_against : []).length,
    evidenceItems: (Array.isArray(row.evidence_items) ? row.evidence_items : []).length,
    category: classify(row),
  };
}

/**
 * @param {{ cognition: object, log?: Function }} deps
 */
async function survey({ cognition, log = () => {} }) {
  const rows = await cognition.listHypotheses({ status: 'proposed', kind: 'hypothesis' });
  const records = (Array.isArray(rows) ? rows : []).map(toRecord);
  const byCategory = { current: 0, legacy_no_ground: 0, legacy_refs_without_text: 0 };
  for (const r of records) byCategory[r.category] += 1;
  const legacy = records
    .filter((r) => r.category !== 'current')
    .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || '')); // oldest first
  log(`[survey] proposed hypotheses examined: ${records.length}`);
  log(`[survey]   current (evidence text kept)      : ${byCategory.current}`);
  log(`[survey]   legacy_no_ground                  : ${byCategory.legacy_no_ground}`);
  log(`[survey]   legacy_refs_without_text          : ${byCategory.legacy_refs_without_text}`);
  return { examined: records.length, byCategory, legacy };
}

const preview = (text, max = 90) => {
  const one = String(text || '').replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

function render({ examined, byCategory, legacy }) {
  const out = [];
  out.push(`Proposed hypotheses: ${examined} — current ${byCategory.current}, legacy ${legacy.length} (no_ground ${byCategory.legacy_no_ground}, refs_without_text ${byCategory.legacy_refs_without_text})`);
  out.push('');
  if (legacy.length === 0) {
    out.push('No legacy records — nothing to lapse, nothing to settle.');
    return out.join('\n');
  }
  const header = ['id', 'created', 'conf', 'for', 'against', 'items', 'category', 'statement'];
  const table = [header];
  for (const r of legacy) {
    table.push([
      r.id,
      (r.createdAt || '').slice(0, 10) || '-',
      r.confidence == null ? '-' : r.confidence.toFixed(2),
      String(r.evidenceFor),
      String(r.evidenceAgainst),
      String(r.evidenceItems),
      r.category,
      preview(r.statement),
    ]);
  }
  const widths = header.map((_, i) => Math.max(...table.map((r) => String(r[i]).length)));
  for (const [ri, row] of table.entries()) {
    out.push(row.map((cell, i) => (i === header.length - 1 ? String(cell) : String(cell).padStart(widths[i]))).join('  '));
    if (ri === 0) out.push(widths.map((w) => '-'.repeat(w)).join('  '));
  }
  out.push('(legacy records only — `current` records with evidence text are never listed for lapsing and never written)');
  return out.join('\n');
}

/**
 * Lapse the legacy records. `expired` (verlopen), never `rejected` — not a
 * quarantine; evidence arriving later revives the record (`expired → testing`).
 * @param {{ cognition: object, legacy: Array<object>, log?: Function }} deps
 */
async function lapseLegacy({ cognition, legacy, log = () => {} }) {
  const result = { expired: 0, failed: 0, ids: [] };
  for (const r of legacy) {
    try {
      await cognition.expireHypothesis(r.id);
      result.expired += 1;
      result.ids.push(r.id);
      log(`[survey] expired ${r.id} (${r.category})`);
    } catch (error) {
      result.failed += 1;
      log(`[survey] FAILED to expire ${r.id}: ${error.message}`);
    }
  }
  return result;
}

/**
 * @param {{ argv?: string[], env?: NodeJS.ProcessEnv, deps?: object, log?: Function }} [options]
 */
async function runSurvey({ argv = process.argv.slice(2), env = process.env, deps = {}, log = console.log } = {}) {
  const { apply } = parseArgs(argv);
  const cognition = deps.cognition || createCognitionClient({
    baseUrl: env.COGNITION_URL || 'http://100.65.0.15:8890',
    bankId: env.COGNITION_BANK_ID || 'gaia',
  });

  log(`[survey] mode: ${apply ? 'APPLY (lapse legacy records)' : 'dry-run'}`);
  const result = await survey({ cognition, log });
  log(render(result));

  if (!apply) {
    log('[survey] dry run — nothing written. Settle what is worth settling in the review list, then re-run with --apply to lapse the rest.');
    return { apply, ...result, lapsed: null };
  }
  const lapsed = await lapseLegacy({ cognition, legacy: result.legacy, log });
  log(`[survey] lapsed ${lapsed.expired} legacy record(s)${lapsed.failed > 0 ? `, ${lapsed.failed} failed` : ''} (verlopen, not rejected — revivable via expired → testing)`);
  return { apply, ...result, lapsed };
}

if (require.main === module) {
  runSurvey()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(`[survey] failed: ${err.message}`);
      process.exit(1);
    });
}

module.exports = { parseArgs, classify, survey, render, lapseLegacy, runSurvey };
