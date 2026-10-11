'use strict';

/**
 * Research reach — the ONE place Gaia reaches FOR a Hermes skill instead of
 * answering from her own model alone.
 *
 * Who decides what is not decided here. The task shape comes from IntentIQ
 * (src/logos/intentSignals.js, SKILL_TASK_FRAMES) and the permission to route
 * comes from the Capability Registry (routing:true). This module owns the
 * wording: which turn qualifies, how the request to Hermes is phrased, and how
 * the material (and the waiting note) is rendered for the prompt.
 *
 * Why naming is the mechanism: hermes-agent is reached over its OpenAI-
 * compatible API, which has no skill parameter — verified live 2026-10-11
 * (v0.21.5, contabo). A `/skill-name` turn is NOT dispatched by that endpoint,
 * but naming the skill in the message makes Hermes load it itself via its
 * `skill_view` tool and follow it. So Gaia states which skill applies; Hermes
 * loads and executes it. Gaia never loads skill contents.
 *
 * Why the job is async: the same live check measured one grounded-citations
 * run still going after 15 minutes and 33 tool calls. Holding a chat turn open
 * for that is not viable, so the run is submitted and polled
 * (src/researchJob.js) instead — Gaia answers now, the findings follow.
 *
 * Boundary: the answer stays Gaia's. Hermes returns material, never the reply.
 */

const { detectSkillTasks } = require('./logos/intentSignals');
const { getCapabilityProfile } = require('./capabilityRegistry');

// Where the Hermes-side of the shared volume is mounted (see the compose
// files): a research run is told to drop any deliverable here, and Gaia reads
// the same host directory at its own path (GAIA_RESEARCH_OUTBOX).
const HERMES_OUTBOX_DIR = '/shared/out';

/**
 * @param {string|null|undefined} userText the latest user turn
 * @returns {string|null} the first detected task skill the registry allows as
 *   a routing target, or null when this turn is not a reach at all
 */
function resolveReachSkill(userText) {
  let tasks;
  try {
    tasks = detectSkillTasks(userText);
  } catch (_) {
    return null;
  }
  const profile = getCapabilityProfile('hermes');
  if (!profile || !Array.isArray(profile.skills)) return null;
  for (const skillId of tasks) {
    const skill = profile.skills.find((s) => s.id === skillId);
    if (skill && skill.routing === true) return skill.id;
  }
  return null;
}

/**
 * The exact text submitted to Hermes for one research question: the skill by
 * name (which makes Hermes load it), the deliverable instruction, and the
 * question itself.
 *
 * @param {{ skillId: string, question: string, outboxDir?: string }} input
 * @returns {string}
 */
function buildReachPrompt({ skillId, question, outboxDir = HERMES_OUTBOX_DIR }) {
  return [
    `Gebruik de skill \`${skillId}\` voor deze onderzoeksvraag.`,
    'Onderzoek het en geef je bevindingen terug met de bronnen erbij.',
    `Hoort er een document bij (pdf, rapport, overzicht), schrijf het dan als`,
    `bestand in ${outboxDir} en noem de bestandsnaam in je antwoord.`,
    '',
    String(question || '').trim(),
  ].join('\n');
}

/**
 * Renders the research material as a prompt block, or null when there is
 * none. The wording keeps the boundary explicit: materiaal, geen antwoord.
 *
 * @param {{ skillId?: string, text?: string }|null|undefined} result
 * @returns {string|null}
 */
function renderResearchContext(result) {
  if (!result || !result.text) return null;
  return [
    `Research-materiaal (opgehaald via de Hermes-skill ${result.skillId}). Dit is`,
    'materiaal, niet je antwoord: schrijf je eigen antwoord in je eigen stem en',
    'neem de bronnen over.',
    '',
    result.text,
  ].join('\n');
}

/**
 * The note for a turn whose research is still running. Gaia answers now and
 * must SAY so — otherwise she answers a research question from her own
 * knowledge and quietly implies that is the research.
 *
 * @param {{ skillId?: string }|null|undefined} job
 * @returns {string|null}
 */
function renderResearchPending(job) {
  if (!job || !job.skillId) return null;
  return [
    `Er loopt nu een onderzoeksopdracht: je hebt deze vraag bij Hermes uitgezet`,
    `(skill ${job.skillId}) en wacht er niet op. Zeg kort dat je ermee bezig bent`,
    'en dat je je meldt zodra het er is. Beloof geen resultaat dat je nog niet',
    'hebt en doe niet alsof je het onderzoek al gedaan hebt.',
  ].join('\n');
}

module.exports = {
  resolveReachSkill,
  buildReachPrompt,
  renderResearchContext,
  renderResearchPending,
  HERMES_OUTBOX_DIR,
};
