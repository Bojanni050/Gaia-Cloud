'use strict';

/**
 * Policy-gated memory recall and reflection — a port of gaia-web's
 * state/memoryContext.js, calling hindsightClient.js instead of going
 * through a same-origin browser proxy (see that file's own comment).
 * Same rendering, same gating, same "never blocks or breaks the turn"
 * contract.
 */
const { shouldRecall, shouldReflect, distillQuery } = require('./memoryPolicy');
const { isPureAcknowledgement } = require('./memoryWorthiness');
const { getAssistantIdentity, getUserIdentity, getConversationContext } = require('./identity');
const { relativeAge } = require('./nowContext');

/**
 * How many memory lines may reach the prompt in one turn.
 *
 * It was 6 until 18-10-2026. Three banks feed this block (the shared bank, her
 * own bank and the derived `gaia-logos`) and, since the same day, each of them
 * claims up to 3 of those lines in the merge (`CROSS_BANK_QUOTA` in
 * hindsightClient.js), so 9 is the size that lets every bank speak. The old 6
 * silently meant "two lines each", and worse: the flat score sort that came
 * with it let one bank take all six.
 *
 * This is not a budget decision. A rendered line is 100–200 characters, so 9
 * lines is roughly 1.5 kB — against the seven standing mental models, which are
 * already sent on every turn and run to about 50 kB together. Six was caution,
 * not a limit anyone measured.
 *
 * `MEMORY_MAX_LINES` overrides it (see .env.example).
 */
const MAX_MEMORY_LINES = Number(process.env.MEMORY_MAX_LINES) || 9;
const UNCERTAIN_CONFIDENCE_THRESHOLD = 0.55;

/**
 * The 7 standing mental models provisioned on the system-memory bank
 * (`HINDSIGHT_BANK_ID`, default `bojan`) — see
 * services/gaia-api/scripts/provision-mental-models.js — each a living,
 * periodically-refreshed synthesis over Bo's memories, distinct from
 * per-turn recall above. IDs must match what was provisioned on Hindsight.
 */
const MENTAL_MODEL_IDS = [
  'identity-personal-context',
  'communication-style',
  'goals-priorities',
  'preferences',
  'relationships-context',
  'work-projects',
  'emotional-patterns',
];

// Mental models only change on a daily cron (or on-demand refresh) — an
// in-process cache keeps every turn from paying a Hindsight round-trip per
// model for content that is, in the common case, hours old.
const MENTAL_MODEL_CACHE_TTL_MS = 10 * 60 * 1000;
let mentalModelCache = { fetchedAt: 0, models: [] };

function normalizeSummary(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

/**
 * What KIND of thing a recalled item is, read from the tags the knowledge
 * adapters write (cognitionSync.js, hindsightHypothesisAdapter.js,
 * hindsightPatternAdapter.js, aion.js, turn.js). Hindsight hands these over on
 * every recall and the renderer used to throw them away — which is how a
 * hypothesis Gaia derived herself and a statement a human happened to confirm
 * arrived in front of her as the same bare sentence, with nothing to tell them
 * apart from a plain memory.
 *
 * Order matters: a confirmed fact also carries `gaia:hypothesis`, and promoted
 * knowledge carries it too, so the strongest tag decides.
 */
const CONFIRMED_TAG = 'gaia:confirmed_fact';
const KNOWLEDGE_TAG = 'gaia:knowledge';
const HYPOTHESIS_TAG = 'gaia:hypothesis';
const PATTERN_TAG = 'gaia:pattern';
const KAIROS_TAG = 'gaia:kairos_episode';
const AION_TAG = 'gaia:aion';
const TURN_TAG = 'gaia-turn';
const OBSERVATION_TAG = 'gaia-observation';
const LEGACY_FACT_TAG = 'foundation:fact';

/**
 * Rendered inside the same parentheses as (uncertain) and the age. English,
 * like the rest of this block.
 */
const KIND_MARKERS = {
  confirmed: 'confirmed by the person',
  knowledge: 'settled knowledge',
  hypothesis: 'your own hypothesis, never confirmed',
  pattern: 'a pattern you formed',
  episode: 'an episode you noted',
  reflection: 'your own reflection',
  observation: 'a record of what was said',
};

function reflectionTags(reflection) {
  const tags = reflection?.tags;
  if (!Array.isArray(tags)) return [];
  return tags
    .filter((tag) => typeof tag === 'string')
    .map((tag) => tag.trim().toLowerCase());
}

/**
 * @param {{tags?: string[]}} [reflection]
 * @returns {string|null} a KIND_MARKERS key, or null for an item with no mark
 */
function memoryKindOf(reflection) {
  const tags = reflectionTags(reflection);
  if (tags.length === 0) return null;
  const has = (tag) => tags.includes(tag);
  // A Foundation fact is a human-confirmed statement by Foundation's own rule.
  if (has(CONFIRMED_TAG) || has(LEGACY_FACT_TAG)) return 'confirmed';
  if (has(KNOWLEDGE_TAG)) return 'knowledge';
  if (has(HYPOTHESIS_TAG)) return 'hypothesis';
  if (has(PATTERN_TAG)) return 'pattern';
  if (has(KAIROS_TAG)) return 'episode';
  if (has(AION_TAG)) return 'reflection';
  if (has(TURN_TAG) || has(OBSERVATION_TAG)) return 'observation';
  return null;
}

/**
 * Reads Hindsight's own field names directly (`text`, `scores.final`) —
 * hindsightClient.js no longer renames these to `summary`/`confidence` on
 * the way in, so this is the one place that derives a renderable line
 * from them. `type`/`entities`/`tags`/`occurred*` ride along on each
 * reflection for future use (e.g. filtering by type) without needing
 * another round-trip through hindsightClient.js to add them.
 *
 * When Hindsight gives an event time (`occurredStart`/`occurredEnd`) the line
 * also carries its real age — an item from three days ago should not read as
 * if it were said a minute ago. When Hindsight gives tags, the line also says
 * what KIND of thing it is (see `memoryKindOf`) — the difference between a
 * fact the person confirmed and a hypothesis Gaia derived herself. A
 * reflection without a timestamp or tags renders byte-for-byte as before,
 * which is what keeps the no-timestamp callers and their tests unchanged.
 * @param {{ text?: string, tags?: string[], occurredStart?: string|number|Date, occurredEnd?: string|number|Date, scores?: { final?: number|null } }} reflection
 * @param {number|Date} [now] the turn's single clock
 */
function formatReflectionLine(reflection, now = Date.now()) {
  const summary = normalizeSummary(reflection?.text);
  if (!summary) return null;
  const confidence = reflection?.scores?.final;
  const isUncertain = typeof confidence === 'number' && confidence < UNCERTAIN_CONFIDENCE_THRESHOLD;
  const kind = memoryKindOf(reflection);
  const age = relativeAge(reflection?.occurredStart || reflection?.occurredEnd, now);
  const flags = [];
  if (kind) flags.push(KIND_MARKERS[kind]);
  if (isUncertain) flags.push('uncertain');
  if (age) flags.push(age);
  return flags.length ? `- ${summary} (${flags.join(', ')})` : `- ${summary}`;
}

/**
 * The selection step shared by both renderers: the same dedupe and the same
 * line cap (`MEMORY_MAX_LINES`, 9 by default), but each surviving line keeps
 * the reflection it came from, so a caller can attach that item's Foundation
 * evidence beneath it.
 * @param {Array<{id?: string, text: string, scores: {final: number|null}}>} reflections
 * @param {number|Date} [now]
 * @returns {Array<{reflection: object, line: string}>}
 */
function condenseMemoryEntries(reflections, now = Date.now()) {
  if (!reflections || reflections.length === 0) return [];
  const seen = new Set();
  const entries = [];
  for (const reflection of reflections) {
    const line = formatReflectionLine(reflection, now);
    if (!line || seen.has(line)) continue;
    seen.add(line);
    entries.push({ reflection, line });
    if (entries.length >= MAX_MEMORY_LINES) break;
  }
  return entries;
}

/**
 * @param {Array<{text: string, scores: {final: number|null}}>} reflections
 * @param {number|Date} [now]
 */
function condenseMemoryContext(reflections, now = Date.now()) {
  return condenseMemoryEntries(reflections, now).map((entry) => entry.line);
}

const MEMORY_CONTEXT_HEADER = [
  'From your long-term memory (Hindsight), things you have come to understand',
  'that may be relevant to this conversation. Use only what genuinely applies;',
  'do not force it in, and do not announce that you are consulting memory.',
  'Every item says what kind of thing it is. "confirmed by the person" is',
  'something the person confirmed themselves — that you may state as a fact.',
  '"settled knowledge" earned its place. Everything else is your own working:',
  '"your own hypothesis, never confirmed", "a pattern you formed", "an episode',
  'you noted", "your own reflection", "a record of what was said" — never state',
  'those as established fact, and never add names, dates or details an item does',
  'not contain. (uncertain) means the same: a possibility, not a settled fact.',
  'When an item touches the person\'s own life — people, health, safety, or',
  'relationships — and you are not certain, ask instead of asserting.',
];

// Added only when the terugweg actually resolved raw records — the note would
// be a lie when nothing could be fetched.
const MEMORY_EVIDENCE_NOTE = [
  'Indented lines marked [observatie] are the literal Foundation records each',
  'item was built from — the raw words, not a summary. Prefer them when the',
  'exact wording matters.',
];

const EVIDENCE_LINE_PREFIX = '  - [observatie] ';

/**
 * @param {Array<{text: string, scores: {final: number|null}}>} reflections
 * @param {number|Date} [now]
 */
function renderMemoryContext(reflections, now = Date.now()) {
  const lines = condenseMemoryContext(reflections, now);
  if (lines.length === 0) return null;
  return [...MEMORY_CONTEXT_HEADER, '', ...lines].join('\n');
}

/**
 * Dual Recall — renders the Hindsight block and, beneath each item that has
 * them, the literal Foundation observations it was built from (see
 * reasoning/evidenceRecall.js). `evidenceByFactId` maps a recalled item's id
 * (its Hindsight fact/observation id) to the raw fragment texts. With no
 * evidence the output is byte-for-byte `renderMemoryContext`.
 * @param {Array<{id?: string, text: string, scores: {final: number|null}}>} reflections
 * @param {Map<string, string[]>|null|undefined} evidenceByFactId
 * @param {number|Date} [now] the turn's single clock, for each item's age
 * @returns {string|null}
 */
function renderDualRecallContext(reflections, evidenceByFactId, now = Date.now()) {
  const entries = condenseMemoryEntries(reflections, now);
  if (entries.length === 0) return null;
  const evidence = evidenceByFactId instanceof Map ? evidenceByFactId : null;
  const body = [];
  let hasEvidence = false;
  for (const { reflection, line } of entries) {
    body.push(line);
    const texts = evidence && reflection && reflection.id != null
      ? evidence.get(reflection.id)
      : null;
    if (!Array.isArray(texts)) continue;
    for (const text of texts) {
      if (!text) continue;
      hasEvidence = true;
      body.push(`${EVIDENCE_LINE_PREFIX}${text}`);
    }
  }
  const header = hasEvidence
    ? [...MEMORY_CONTEXT_HEADER, ...MEMORY_EVIDENCE_NOTE]
    : MEMORY_CONTEXT_HEADER;
  return [...header, '', ...body].join('\n');
}

/**
 * Best-effort recall, policy-gated. Never throws — a slow or unreachable
 * Hindsight, or a query the policy judges not worth a lookup, both
 * resolve to [] rather than failing or delaying the turn. The optional
 * `intentDecision` rides into the policy so an IntentIQ-resolved
 * memory-anchored follow-up (assistant-originated referents — see
 * memoryPolicy.shouldRecall) can open the gate even without a lexical
 * past-reference cue in the query text.
 *
 * `pastReference` is the caller's own judgment that this turn is asking about
 * the past (the turn detected a literal-lookup signal — what was actually
 * said). It OPENS the gate, so a past-facing turn consults Hindsight even when
 * the query carries no lexical past cue of its own: memory and the transcript
 * are two halves of "what do you know about this", and a lookup should reach
 * for both, not one.
 *
 * `shape.asksAboutHer` — he asks for her own view or state ("wat vind jij",
 * "wat houdt je bezig") — opens the gate the same way: that is the one turn
 * where her own bank is read, and reading nothing at all would make the cue
 * empty.
 *
 * `shape` is the verdict of `turnShape.readTurn` for this same query (stap 4
 * van "de vraag één keer lezen"): when the turn read the question once, the
 * policy uses that reading instead of scanning the text a second time.
 * @param {ReturnType<import('./hindsightClient').createHindsightClient>} hindsight
 * @param {string} query
 * @param {{ intentDecision?: object|null, pastReference?: boolean, shape?: object|null }} [options]
 */
async function recallRelevantContext(hindsight, query, options = {}) {
  if (!query || !query.trim()) return [];
  // A turn that asks about her opens the gate by itself: he wants her view, and
  // her own memories are part of what she answers from. Without this the
  // asksAboutHer branch in turn.js could never reach a line at all, because the
  // gate drops the query before the bank choice is made (measured 18-10-2026:
  // "wat houdt je bezig?" gave reflectionCount 0 and she answered "Bo niet.").
  const asksAboutHer = Boolean(options.shape && options.shape.asksAboutHer);
  if (!options.pastReference
    && !asksAboutHer
    && !shouldRecall(query, { intentDecision: options.intentDecision, shape: options.shape })) {
    return [];
  }
  try {
    // The gate read the turn as Bo wrote it; retrieval reads only the words
    // that carry it (distillQuery — a whole conversational sentence pushed the
    // right fact to rank 38 of 44, "Pieter hond" put it first).
    return await hindsight.recall(distillQuery(query) || query);
  } catch (_) {
    return [];
  }
}

const QUESTION_OPENERS = new Set([
  // Dutch interrogatives and inverted verb openers
  'wat', 'wie', 'waar', 'waarvan', 'waarom', 'wanneer', 'hoe', 'hoeveel', 'welke', 'welk',
  'is', 'zijn', 'was', 'waren', 'ben', 'heb', 'hebt', 'heeft', 'hebben', 'had', 'hadden',
  'kun', 'kan', 'kunt', 'kunnen', 'kon', 'wil', 'wilt', 'willen', 'zou', 'zouden',
  'zal', 'zult', 'mag', 'mogen', 'moet', 'moeten', 'doe', 'doet', 'doen', 'weet', 'vind', 'denk',
  // English
  'what', 'who', 'whom', 'whose', 'where', 'when', 'why', 'how', 'which', 'whichever',
  'do', 'does', 'did', 'am', 'can', 'could', 'will', 'would', 'shall', 'should', 'may', 'might',
]);

// Openers that carry no content of their own: a greeting, an acknowledgement or
// a discourse marker in front of the actual question ("Oké, en wat weet je dan
// van Luca?"). A single word followed by a comma is skipped too, which is how a
// name in front of a question is handled ("Yassine, wat weet je van hem?").
const QUESTION_NOISE = /^(ok(é|ay)?|okay|hey|hoi|hallo|hello|hi|nou|ja|nee|zeg|eens|even|dus|en|maar|and|but|so|well|yes|no)(?![\p{L}\p{N}])[,.!?\s]*/giu;
const QUESTION_ADDRESS = /^\p{L}{2,20},\s*/u;

function questionLead(sentence) {
  let rest = sentence;
  for (let i = 0; i < 5; i += 1) {
    const before = rest;
    rest = rest.replace(QUESTION_NOISE, '').replace(QUESTION_ADDRESS, '');
    if (rest === before) break;
  }
  return (rest.toLowerCase().match(/[a-zà-ÿ]+/) || [''])[0];
}

function isPureQuestion(sentence) {
  if (!sentence.endsWith('?')) return false;
  return QUESTION_OPENERS.has(questionLead(sentence));
}

/**
 * What the person actually said, with their questions left out.
 *
 * Hindsight extracts facts from the text we retain, and it reads a question as
 * content: on 18-10-2026 a measured quarter of the store turned out to be
 * records of the exchange itself ("user asked about X", "Gaia has no knowledge
 * of Y"), and those phrasings outrank the real facts because they repeat the
 * question's own words. The seed is that the person's question was handed over
 * as if the person had stated it.
 *
 * So a sentence that only asks is not retained as something the person said,
 * while a sentence that states something always is. A turn that mixes the two
 * keeps its stating part, and a sentence that corrects and asks at once stays
 * whole ("Dat klopt niet, wat weet je over Luca?" does not open with a question
 * word, so it is kept). A turn that is nothing but questions leaves nothing on
 * the person's side, and the retained summary then carries only the answer.
 *
 * The list of question openers is deliberately short and behavioural — it
 * decides what NOT to hand over, so a miss keeps the text (the safe side) and
 * the extractor still sees everything the person stated.
 * @param {string} text
 * @returns {string} the stating sentences, joined, or '' when there are none
 */
function spokenPart(text) {
  if (!text) return '';
  const sentences = String(text).match(/[^.!?]+[.!?]*/g) || [];
  return sentences
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence && !isPureQuestion(sentence))
    .join(' ');
}

/**
 * Fire-and-forget reflection, policy-gated. Callers must not await this
 * for turn completion — matches gaia-web's reflectOnTurn contract exactly.
 *
 * Memoryworthiness 0.1: an optional `metadata` object (gaia_memory_* keys
 * describing the ingest decision, see memoryWorthiness.js) rides along on
 * the retained item — same gaia_ namespace as hypotheses/patterns, merged
 * additively over the existing provenance metadata. The retain/discard
 * GATE itself lives at the call site (turn.js); this function stays the
 * transport.
 *
 * Only what the person said is retained on their side of the summary: their
 * questions are left out (see spokenPart) so the extractor is not handed
 * "Bo asked about X" as if Bo had stated it, and a turn that is nothing but a
 * question is not retained at all. Reason, measured on 18-10-2026 with a
 * dry-run extract: her answer to "what do you know about X" is itself a
 * restatement of what is already stored, so retaining that exchange is how
 * "Gaia knows nothing about Yassine" became a stored fact that then outranked
 * the real ones. A turn in which the person states anything is still retained,
 * question attached or not.
 *
 * Identity: the persisted conversation is Gaia ↔ User (Bojan for dev,
 * dynamically derived for multi-user). Hermes is a capability, never the
 * conversational identity. The context and summary use the authoritative
 * identity module, not hardcoded strings.
 * @param {ReturnType<import('./hindsightClient').createHindsightClient>} hindsight
 * @param {{ conversationId: string, userText: string, assistantText: string,
 *          assistantMessageId?: string, metadata?: Record<string,string>,
 *          userDisplayName?: string, userIdentityOptions?: object,
 *          capabilityExecutor?: string, shape?: object|null }} turn
 */
function reflectOnTurn(hindsight, { conversationId, userText, assistantText, assistantMessageId, metadata, userDisplayName, userIdentityOptions, capabilityExecutor, shape }) {
  if (!userText || !assistantText) return;
  if (!shouldReflect(userText, assistantText, { shape })) return;
  // Nothing stated on the person's side means nothing to remember: a turn that
  // only asks would otherwise store her answer to that question, and an answer
  // to "what do you know about X" is a restatement of what memory already
  // holds — never a new fact. See spokenPart for what counts as asking.
  const spoken = spokenPart(userText);
  if (!spoken) return;
  // A reply that is nothing but a confirmation ("Genoteerd.") is not worth
  // handing to the extractor: it would be kept as a fact about her noting what
  // he said. Measured 18-10-2026, where "Gaia noteert de informatie van Bojan"
  // came out of exactly that shape.
  const reply = isPureAcknowledgement(assistantText) ? '' : assistantText;
  const assistantIdentity = getAssistantIdentity();
  const userIdentity = getUserIdentity(
    userDisplayName ? { displayName: userDisplayName } : userIdentityOptions || {}
  );
  const context = getConversationContext({ userDisplayName: userIdentity.displayName });
  // Summary uses the authoritative display names, not hardcoded "Bo"/"Gaia" literals
  const summary = reply
    ? `${userIdentity.displayName}: ${spoken}\n\n${assistantIdentity.displayName}: ${reply}`
    : `${userIdentity.displayName}: ${spoken}`;
  // Identity metadata: conversational agent is always Gaia, even when a
  // capability (Hermes, etc.) executed internally. Capability executor may
  // be recorded separately where useful, but never as the conversation agent.
  const identityMetadata = {
    agent_identity: assistantIdentity.displayName,
    conversation_agent: assistantIdentity.displayName,
    user_display_name: userIdentity.displayName,
    // Keep platform for observability; Hindsight may also set its own
    platform: 'api_server',
    ...(capabilityExecutor ? { capability_executor: capabilityExecutor } : {}),
  };
  const mergedMetadataForReflect = { ...identityMetadata, ...(metadata || {}) };
  // Ensure agent_identity cannot be overridden to Hermes by caller metadata —
  // conversational identity is always Gaia.
  mergedMetadataForReflect.agent_identity = assistantIdentity.displayName;
  mergedMetadataForReflect.conversation_agent = assistantIdentity.displayName;

  hindsight.reflect({
    domain: 'context',
    context,
    summary,
    provenance: {
      conversation_id: conversationId,
      source_message_id: assistantMessageId,
      observed_at: new Date().toISOString(),
    },
    metadata: mergedMetadataForReflect,
  }).catch((err) => {
    console.warn(`reflection failed (non-fatal): ${err.message}`);
  });
}

/**
 * Renders the cached mental models into one system-message block. Framed as
 * standing understanding (not a per-query recall) so Gaia treats it as
 * background insight into who Bo is, not evidence to cite.
 * @param {Array<{ name: string, content: string }>} models
 * @returns {string|null}
 */
function renderMentalModelContext(models) {
  const sections = (models || [])
    .filter((m) => m && m.content && m.content.trim())
    .map((m) => `### ${m.name}\n${m.content.trim()}`);
  if (sections.length === 0) return null;
  return [
    "This is Gaia's standing understanding of Bo, synthesized over time from",
    'long-term memory (Hindsight mental models) and refreshed periodically —',
    'not a transcript of this conversation. Let it inform tone and judgment',
    'quietly; never quote it back or announce that you are drawing on it.',
    '',
    ...sections,
  ].join('\n');
}

/**
 * Best-effort fetch of all mental models, cached in-process
 * (MENTAL_MODEL_CACHE_TTL_MS). Never throws — same "must not affect the
 * turn" contract as recallRelevantContext. A model that fails to fetch
 * (not yet provisioned, Hindsight unreachable, no content generated yet)
 * is silently omitted rather than failing the whole batch.
 * @param {ReturnType<import('./hindsightClient').createHindsightClient>} hindsight
 * @param {{ now?: () => number }} [options] test seam for the cache clock
 */
async function fetchMentalModelContext(hindsight, { now = Date.now } = {}) {
  const nowMs = now();
  if (nowMs - mentalModelCache.fetchedAt < MENTAL_MODEL_CACHE_TTL_MS) {
    return mentalModelCache.models;
  }
  const results = await Promise.all(
    MENTAL_MODEL_IDS.map((id) =>
      hindsight.getMentalModel(id).catch(() => null)
    )
  );
  const models = results.filter(Boolean);
  mentalModelCache = { fetchedAt: nowMs, models };
  return models;
}

module.exports = {
  condenseMemoryContext,
  condenseMemoryEntries,
  memoryKindOf,
  KIND_MARKERS,
  renderMemoryContext,
  renderDualRecallContext,
  recallRelevantContext,
  reflectOnTurn,
  spokenPart,
  MENTAL_MODEL_IDS,
  renderMentalModelContext,
  fetchMentalModelContext,
};
