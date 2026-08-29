'use strict';

/**
 * One-time (or re-run-safe) provisioning of the 7 standing mental models on
 * Bo's shared `bojan` Hindsight bank (deliberately not a Gaia-only bank —
 * see project_gaia_mental_models.md — so these draw on everything already
 * known about him) — see memory.js's MENTAL_MODEL_IDS, which must be kept
 * in sync with the ids created here. Not part of the running service; run
 * manually (from a machine that can reach HINDSIGHT_URL, e.g. over
 * Tailscale, or on the VPS itself) whenever the set of mental models needs
 * to change:
 *
 *   HINDSIGHT_URL=http://100.65.0.15:8888 HINDSIGHT_BANK_ID=bojan \
 *     node scripts/provision-mental-models.js
 *
 * Re-run-safe: an id that already exists gets PATCHed (name/source_query/
 * trigger) instead of failing on the create's 409/400 — safe to re-run
 * after editing an entry in MODELS, not just after adding a new one.
 */

// Each model's refresh_cron is staggered 5 minutes apart (03:00, 03:05, ...
// 03:30 UTC) rather than all firing at once — provisioning all 7 with the
// same cron on 2026-08-19 caused every one to kick off its agentic reflect
// concurrently, which pushed the shared `hindsight` container's memory
// past its limit and into an OOM restart loop. See
// project_gaia_mental_models.md. Hindsight skips a tick if nothing changed
// since the last refresh, so the 5-minute gaps cost nothing on quiet days.
const MODELS = [
  {
    id: 'identity-personal-context',
    name: 'Identity & Personal Context',
    source_query: 'Who is Bo — his background, role, identity, and the personal context that shapes how he shows up day to day?',
    refresh_cron: '0 3 * * *',
  },
  {
    id: 'communication-style',
    name: 'Communication Style',
    source_query: 'How does Bo prefer to communicate — tone, directness, feedback style, and what he responds well or poorly to?',
    refresh_cron: '5 3 * * *',
  },
  {
    id: 'goals-priorities',
    name: 'Goals & Priorities',
    source_query: "What are Bo's current goals and priorities, near-term and longer-term, and what he is actively working toward?",
    refresh_cron: '10 3 * * *',
  },
  {
    id: 'preferences',
    name: 'Preferences',
    source_query: "What are Bo's known preferences and defaults — tools, approaches, formats, workflows — that Gaia should default to without being asked each time?",
    refresh_cron: '15 3 * * *',
  },
  {
    id: 'relationships-context',
    name: 'Relationships & Context',
    source_query: 'Who and what matters in Bo\'s life and work — people, projects, and relationships Gaia should be aware of for context?',
    refresh_cron: '20 3 * * *',
  },
  {
    id: 'work-projects',
    name: 'Work & Projects',
    source_query: "What is Bo currently working on — active projects, their state, and what's next for each?",
    refresh_cron: '25 3 * * *',
  },
  {
    id: 'emotional-patterns',
    name: 'Emotional Patterns',
    source_query: 'What patterns has Bo shown in mood, stress, and emotional response over time, and what tends to help or not help?',
    refresh_cron: '30 3 * * *',
  },
];

const MAX_TOKENS = 768;

async function main() {
  const baseUrl = String(process.env.HINDSIGHT_URL || '').replace(/\/+$/, '');
  const bankId = process.env.HINDSIGHT_BANK_ID || 'bojan';
  if (!baseUrl) {
    console.error('HINDSIGHT_URL is required');
    process.exit(1);
  }

  for (const model of MODELS) {
    const trigger = { mode: 'full', refresh_cron: model.refresh_cron };
    const createResponse = await fetch(`${baseUrl}/v1/default/banks/${bankId}/mental-models`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: model.id,
        name: model.name,
        source_query: model.source_query,
        max_tokens: MAX_TOKENS,
        trigger,
      }),
    });
    if (createResponse.ok) {
      console.log(`created: ${model.id}`);
      continue;
    }

    // Already exists — re-run is expected to just re-stagger its cron
    // rather than fail, so a later change to MODELS above can be re-applied
    // with the same command.
    const updateResponse = await fetch(`${baseUrl}/v1/default/banks/${bankId}/mental-models/${model.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: model.name, source_query: model.source_query, trigger }),
    });
    if (updateResponse.ok) {
      console.log(`updated: ${model.id}`);
    } else {
      const text = await updateResponse.text().catch(() => '');
      console.warn(`skipped ${model.id}: ${updateResponse.status} ${text.slice(0, 200)}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
