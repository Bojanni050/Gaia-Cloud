'use strict';

/**
 * Turn shape — ONE reading of the user's turn.
 *
 * Why this exists (18-10-2026): five places read the same sentence, each with
 * its own word list, and none of them sees the others' verdict — memoryPolicy
 * (recall + reflection), intentSignals (archive/transcript/Foundation),
 * patternAwareness (patterns), knowledgePages (knowledge), the Logos depth
 * gate. In a 21-turn conversation about Yassine exactly one of those doors
 * opened and three stayed shut, so she said she remembered nothing while
 * eleven valid items sat in her own bank.
 *
 * This module does NOT read the text a sixth time with new words. It only
 * composes the vocabularies that already exist — `memoryPolicy.isTrivial`,
 * `PAST_REFERENCE_SIGNALS`, `DURABLE_CONTEXT_SIGNALS`, and
 * `intentSignals.detectSignals`/`detectSkillTasks` — and states the verdict
 * once, in one object. Step 1 of the streamlining plan (`plan: de vraag één
 * keer lezen`): shape only, deliberately inert. Nothing consumes this yet;
 * the verdict is logged per turn (kind 'turn.shape') so it can be compared
 * against the existing per-gate records BEFORE any consumer is moved onto it.
 *
 * Two consumers keep their own extra conditions and are therefore NOT
 * mirrored here:
 *   - `memory.js` `recallRelevantContext` also opens on its caller's
 *     `pastReference` argument (the transcript signal);
 *   - `patternAwareness.shouldAttemptPatternRetrieval` also requires the
 *     pattern runtime to be present in `turn.js` (`wantPatterns` combines the
 *     two).
 * `topical` below is that gate's own verdict, before the runtime check.
 *
 * The IntentIQ branch of `shouldRecall` (sourceOfTruth === 'memory', the
 * assistant-anchored follow-ups) is deliberately not mirrored: `turn.js` sets
 * `intentDecision = null` and no live caller ever resolves one, so that branch
 * is dead (plan step 5 removes it). `wantsRecall` therefore equals the live
 * gate exactly, which is what the drift test and the step-3 comparison pin.
 */

const {
  isTrivial, MEMORY_POLICY, PAST_REFERENCE_SIGNALS, DURABLE_CONTEXT_SIGNALS,
  HER_VIEW_SIGNALS,
} = require('./memoryPolicy');
const { detectSignals, detectSkillTasks } = require('./logos/intentSignals');

/** Local copy of memoryPolicy's own probe — the signal lists stay arrays of RegExps. */
function hasSignal(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * Read the user's turn once and state what shape it has.
 *
 * @param {string|null|undefined} text the latest user turn
 * @returns {{
 *   empty: boolean,          nothing (or only whitespace) was said
 *   trivial: boolean,        at the pattern floor: filler or very short
 *   reflectable: boolean,    at the reflection floor — drives shouldReflect's user half
 *   pastReference: boolean,  a lexical past-reference cue fired
 *   durableTopic: boolean,   a durable-topic cue fired
 *   wantsRecall: boolean,    the live recall gate — must equal shouldRecall(text)
 *   looksInArchive: boolean, asks for what was literally said (transcript read)
 *   looksInRecords: boolean, asks what is recorded in Foundation (archive read)
 *   topical: boolean,        patternAwareness' own gate, before its runtime check
 *   skillTasks: string[],    routing-skill task shapes the wording matches
 *   matched: string[],       which of the above vocabularies fired, by name
 * }}
 */
function readTurn(text) {
  const raw = text == null ? '' : String(text);
  const trimmed = raw.trim();
  const empty = trimmed === '';

  const trivial = isTrivial(trimmed, MEMORY_POLICY.minRecallLength);
  const reflectable = !isTrivial(trimmed, MEMORY_POLICY.minReflectLength);

  const pastReference = hasSignal(trimmed, PAST_REFERENCE_SIGNALS);
  const durableTopic = hasSignal(trimmed, DURABLE_CONTEXT_SIGNALS);

  // The live recall gate: shouldRecall(query, { intentDecision: null }).
  // No length floor: a cue decides at any length, because the floor used to
  // swallow exactly the shortest memory questions ("weet je nog?" is eleven
  // characters, "geheugen?" eight). `trivial` below still feeds the pattern
  // gate, which keeps its floor.
  const wantsRecall = pastReference || durableTopic;

  // The archive/transcript vocabulary (intentSignals). Never lets a vocabulary
  // failure take down a turn — same posture as turn.js' own guards.
  let signals = null;
  try {
    signals = detectSignals(trimmed);
  } catch (_) {
    signals = null;
  }
  const looksInArchive = Boolean(
    signals && (signals.exactHistory || signals.pastLookup || signals.rememberedKnowledge)
  );
  const looksInRecords = Boolean(signals && signals.recordedKnowledge);

  // The one turn where her own bank joins the recall: he asks about her view
  // or her state (see HER_VIEW_SIGNALS in memoryPolicy).
  const asksAboutHer = hasSignal(trimmed, HER_VIEW_SIGNALS);

  // patternAwareness' live verdict: no trivial turn triggers pattern analysis.
  const topical = !trivial;

  let skillTasks = [];
  try {
    skillTasks = detectSkillTasks(trimmed) || [];
  } catch (_) {
    skillTasks = [];
  }

  const matched = [];
  if (pastReference) matched.push('pastReference');
  if (durableTopic) matched.push('durableTopic');
  if (asksAboutHer) matched.push('asksAboutHer');
  if (signals) {
    if (signals.exactHistory) matched.push('exactHistory');
    if (signals.pastLookup) matched.push('pastLookup');
    if (signals.rememberedKnowledge) matched.push('rememberedKnowledge');
    if (signals.recordedKnowledge) matched.push('recordedKnowledge');
  }
  if (skillTasks.length > 0) matched.push('skillTasks');

  return {
    empty,
    trivial,
    reflectable,
    pastReference,
    durableTopic,
    asksAboutHer,
    wantsRecall,
    looksInArchive,
    looksInRecords,
    topical,
    skillTasks,
    matched,
  };
}

/**
 * Meetbasis voor stap 3: één regel per turn met het verdict, alleen ja/nee en
 * namen. Nooit de tekst van de gebruiker, nooit geheugeninhoud. Zelfde posture
 * als `recallLog.js` — de aanroeper vangt fouten af, observability mag nooit
 * een turn stukmaken.
 *
 * @param {ReturnType<typeof readTurn> & { traceId?: string|null, queryLength?: number }} entry
 * @param {(line: string) => void} [sink] defaults to console.log
 */
function logTurnShape(entry, sink = (line) => console.log(line)) {
  const record = {
    kind: 'turn.shape',
    timestamp: new Date().toISOString(),
    traceId: entry.traceId || null,
    empty: Boolean(entry.empty),
    trivial: Boolean(entry.trivial),
    reflectable: Boolean(entry.reflectable),
    pastReference: Boolean(entry.pastReference),
    durableTopic: Boolean(entry.durableTopic),
    asksAboutHer: Boolean(entry.asksAboutHer),
    wantsRecall: Boolean(entry.wantsRecall),
    looksInArchive: Boolean(entry.looksInArchive),
    looksInRecords: Boolean(entry.looksInRecords),
    topical: Boolean(entry.topical),
    skillTasks: Array.isArray(entry.skillTasks) ? entry.skillTasks.slice() : [],
    matched: Array.isArray(entry.matched) ? entry.matched.slice() : [],
    queryLength: Number.isFinite(entry.queryLength) ? entry.queryLength : 0,
  };
  sink(JSON.stringify(record));
  return record;
}

module.exports = { readTurn, logTurnShape };
