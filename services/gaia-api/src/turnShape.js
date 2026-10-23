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
  REPAIR_SIGNALS, HER_VIEW_SIGNALS, contentWords,
} = require('./memoryPolicy');
const { detectSignals, detectSkillTasks } = require('./logos/intentSignals');

/** Local copy of memoryPolicy's own probe — the signal lists stay arrays of RegExps. */
function hasSignal(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * The same question, asked again. Not a lexical cue but a conversational one,
 * and 23-10-2026 Bo named it as a cue in its own right: "als ik het meerdere
 * keren vraag". A person who repeats himself has already decided the answer was
 * wrong; asking again is the cheapest possible evidence that she should look.
 *
 * Deliberately dumb and explainable: at least three content words in common,
 * and they cover at least 60% of the shorter of the two turns. Below that it is
 * the same topic, not the same question ("hoe gaat het met Pieter?" vs "hoe
 * gaat het met je werk?" share two words and must stay separate).
 *
 * @param {string} text the current turn
 * @param {Array<string>|undefined} previousUserTexts earlier user turns, oldest first
 * @returns {boolean}
 */
function isRepeatAsk(text, previousUserTexts) {
  const current = contentWords(text);
  if (current.size < 3) return false;
  const earlier = Array.isArray(previousUserTexts) ? previousUserTexts : [];
  for (const previous of earlier) {
    const words = contentWords(previous);
    if (words.size < 3) continue;
    let shared = 0;
    for (const word of current) if (words.has(word)) shared += 1;
    const smaller = Math.min(current.size, words.size);
    if (shared >= 3 && shared / smaller >= 0.6) return true;
  }
  return false;
}

/**
 * Read the user's turn once and state what shape it has.
 *
 * @param {string|null|undefined} text the latest user turn
 * @param {{ previousUserTexts?: string[] }} [options] earlier user turns (oldest
 *   first), used only for the repeat-ask cue — pure and optional: without it
 *   `repeatAsk` is false and every other verdict is unchanged.
 * @returns {{
 *   empty: boolean,          nothing (or only whitespace) was said
 *   trivial: boolean,        at the pattern floor: filler or very short
 *   reflectable: boolean,    at the reflection floor — drives shouldReflect's user half
 *   pastReference: boolean,  a lexical past-reference cue fired
 *   durableTopic: boolean,   a durable-topic cue fired
 *   repair: boolean,         doubt, a challenge to her memory, or "look again"
 *   repeatAsk: boolean,      the same question came back in this conversation
 *   wantsRecall: boolean,    the live recall gate — must equal shouldRecall(text)
 *   looksInArchive: boolean, asks for what was literally said (transcript read)
 *   looksInRecords: boolean, asks what is recorded in Foundation (archive read)
 *   topical: boolean,        patternAwareness' own gate, before its runtime check
 *   skillTasks: string[],    routing-skill task shapes the wording matches
 *   matched: string[],       which of the above vocabularies fired, by name
 * }}
 */
function readTurn(text, options = {}) {
  const raw = text == null ? '' : String(text);
  const trimmed = raw.trim();
  const empty = trimmed === '';

  const trivial = isTrivial(trimmed, MEMORY_POLICY.minRecallLength);
  const reflectable = !isTrivial(trimmed, MEMORY_POLICY.minReflectLength);

  const pastReference = hasSignal(trimmed, PAST_REFERENCE_SIGNALS);
  const durableTopic = hasSignal(trimmed, DURABLE_CONTEXT_SIGNALS);
  // Doubt, a challenge to her memory, or "look again" — see REPAIR_SIGNALS.
  const repair = hasSignal(trimmed, REPAIR_SIGNALS);
  // The same question asked again is a cue too, but only the caller knows the
  // conversation: it passes the earlier user turns in.
  const repeatAsk = isRepeatAsk(trimmed, options.previousUserTexts);

  // The live recall gate: shouldRecall(query, { intentDecision: null }).
  // No length floor: a cue decides at any length, because the floor used to
  // swallow exactly the shortest memory questions ("weet je nog?" is eleven
  // characters, "geheugen?" eight). `trivial` below still feeds the pattern
  // gate, which keeps its floor.
  const wantsRecall = pastReference || durableTopic || repair || repeatAsk;

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
  if (repair) matched.push('repair');
  if (repeatAsk) matched.push('repeatAsk');
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
    repair,
    repeatAsk,
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
    repair: Boolean(entry.repair),
    repeatAsk: Boolean(entry.repeatAsk),
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
