'use strict';

/**
 * Memoryworthiness 0.1 — a small, deterministic gate between IntentIQ and
 * Hindsight. It answers exactly one question:
 *
 *   > Is this turn worth keeping as a Hindsight memory?
 *
 * Conversation history keeps everything; this module decides what deserves
 * MEMORY. It is NOT an agent: it never reasons about the user, forms
 * hypotheses or patterns, selects capabilities, calls Hermes/Web, replaces
 * a routing layer, touches the Response Engine, or produces user-facing
 * output. It classifies one turn and explains itself.
 *
 *   User turn → IntentIQ → Memoryworthiness → { discard | retain_low_priority | retain }
 *
 * Pipeline position (turn.js): evaluated AFTER the parallel Hindsight recall
 * (the recalled reflections are the `existingMemorySignals` that power
 * duplicate/correction detection) and BEFORE ReasonIQ. On `discard`, turn.js
 * skips both hypothesis application and pattern formation (spec §15) and the
 * post-turn reflection never fires; on retain/retain_low_priority it rides
 * along as `gaia_memory_*` metadata on the existing reflection.
 *
 * It judges the COMPLETED turn: the user's message AND Gaia's delivered reply
 * (`assistantReply`) — the durable conclusion/decision/plan often lives in the
 * reply, so a lexically mundane prompt no longer forces a discard on its own.
 * Person-signals stay user-only; topic-signals read either side.
 *
 * Scoring (fully deterministic, no ML, no LLM — spec §10):
 *
 *   1. Six dimensions scored 0–3 from objective lexical/intent signals
 *      (novelty, persistence, personalRelevance, futureUtility,
 *      correctionValue, explicitRecallRequest).
 *   2. score = Σ(dim × weight) / 3  with the weights below.
 *   3. A small ordered set of hard rules adjusts floors/caps where pure
 *      averaging would betray the intent of a signal (explicit requests and
 *      corrections must retain; duplicates must not re-retain; trivial
 *      turns must discard regardless of a chatty reply).
 *   4. Thresholds map score → action: ≥ RETAIN_SCORE retain,
 *      ≥ LOW_PRIORITY_SCORE retain_low_priority, else discard.
 *
 * Semantic fallback (§11) is deliberately NOT built in 0.1: every case is
 * decided by the deterministic first pass, so clear retains/discards cost
 * zero LLM calls. The extension seam is evaluate()'s single call site in
 * turn.js — a semantic check would slot between the hard rules and the
 * threshold mapping for mid-band turns only.
 *
 * Boundary: PURE module. Requires only memoryPolicy's existing signal
 * vocabulary; performs no I/O whatsoever.
 */

const {
  isTrivial, FILLER_PATTERNS, PAST_REFERENCE_SIGNALS, DURABLE_CONTEXT_SIGNALS, MEMORY_POLICY,
} = require('./memoryPolicy');

const ACTIONS = Object.freeze(['discard', 'retain_low_priority', 'retain']);

/** Dimension weights — documented so no coefficient is magic (§4). */
const DIMENSION_WEIGHTS = Object.freeze({
  novelty: 0.16,            // adds something Gaia did not already hold
  persistence: 0.22,        // describes something durable, not momentary
  personalRelevance: 0.18,  // about Bo as a person (facts, preferences, life)
  futureUtility: 0.20,      // plausibly useful in later conversations
  correctionValue: 0.14,    // supersedes/contradicts existing understanding
  explicitRecallRequest: 0.10, // Bo explicitly asked Gaia to remember/change memory
});

/** Score thresholds after floors/caps (documented, §4). */
const RETAIN_SCORE = 0.62;
const LOW_PRIORITY_SCORE = 0.35;

/**
 * Compact signal vocabulary (§3: dozens, not hundreds). Dutch-first —
 * Gaia's user is Dutch-speaking — with the English anchors that already
 * existed in memoryPolicy. Each group feeds specific dimensions below.
 */
const SIGNALS = Object.freeze({
  /** §7 — explicit memory requests are always strong. */
  strongRequest: [
    /\bonthoud\b/i, /\bbewaar\b/i, /\bvergeet niet\b/i, /\bnoteren?\b.*\bvoor\b/i,
    /\bremember (that|this)\b/i, /\bkeep in mind\b/i, /\bdon'?t forget\b/i,
    /\bvanaf nu\b/i, /\bvanaf nou\b/i, /\bvoortaan\b/i, /\bfrom now on\b/i,
    /\bik wil dat je\b/i, /\bik wil graag dat je\b/i, /\bi want you to\b/i,
    /\bvergeet (mijn )?(de )?(vorige|oude)\b/i,
  ],
  /** Preferences — durable personal stances (§9 retain list). */
  preference: [
    /\bik wil\b/i, /\bik heb liever\b/i, /\bliever\b/i, /\bik prefereer\b/i,
    /\bhou (ervan|van)\b/i, /\bhoud (ervan|van)\b/i, /\bik vind .{0,30} (beter|leuker|mooier|prettiger)\b/i,
    /\bi prefer\b/i, /\bi like\b/i, /\bi love\b/i,
  ],
  /** Corrections / contradictions of what Gaia may believe (§8 priority). */
  correction: [
    /\bklopt niet\b/i, /\bniet meer\b/i, /\beigenlijk\b/i, /\bdat is fout\b/i,
    /\bverkeerd\b/i, /\bintegendeel\b/i, /\bvergeet maar\b/i, /\bdat was vroeger\b/i,
    /\bno longer\b/i, /\bthat'?s wrong\b/i, /\bi don'?t anymore\b/i,
  ],
  /** First-person durable facts (life, work, relationships). */
  personalFact: [
    /\bik woon\b/i, /\bik werk\b/i, /\bik studeer\b/i,
    /\bmijn (naam|partner|vriend(in)?|vrouw|man|dochter|zoon|gezin|familie|baan|werkgever|studie|project|studio|werk|bedrijf|team|opleiding|hond|kat)\b/i,
    /\bsinds (vandaag|gisteren|deze week|vorige week|een maand|januari|maart|mei|juni|augustus|september)\b/i,
    /\bi live\b/i, /\bi work\b/i, /\bmy (name|wife|husband|son|daughter|family|job)\b/i,
  ],
  /**
   * Recurring commitments & routines ("elke dinsdag", "vaste studio") —
   * durable by nature: they describe how life/work IS, not a moment.
   */
  recurrence: [
    /\belke (dag|week|maand|ochtend|avond|weekend|maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag|zondag)\b/i,
    /\bwekelijks\b/i, /\bmaandelijks\b/i, /\bdagelijks\b/i, /\bvaste (studio|plek|tijd|dag|moment|routine|afspraak)\b/i,
    /\bevery (day|week|month|monday|friday)\b/i, /\bi always\b/i, /\bik altijd\b/i,
  ],
  /**
   * Durable LIFE EVENTS — rare, high-value personal milestones. Narrow by
   * design: these are exactly the facts losing one would be a real loss
   * (§18 false-discard matters).
   */
  lifeEvent: [
    /\bverhuis\b/i, /\bverhuizen\b/i, /\bnieuwe baan\b/i, /\bandere baan\b/i,
    /\bontslag\b/i, /\btrouwen\b/i, /\bgaat trouwen\b/i, /\bsamenwonen\b/i,
    /\bkind (gekr|krijg)/i, /\beerste werkdag\b/i, /\bi moved\b/i, /\bnew job\b/i,
    // Planned absences — durable availability knowledge (weeks of context).
    /\bvakantie\b/i, /\bverlof\b/i, /\b(week|weken|dagen|maand)(en)? vrij\b/i,
  ],
  /** Weak first-person presence — situational, NOT durable by itself. */
  presenceFact: [/\bik ben\b/i, /\bik heb\b/i, /\bi am\b/i],
  /**
   * A standing fact about the person's own surroundings or belongings —
   * first person with a count or article and something nameable ("ik heb twee
   * 27 inch monitoren", "ik heb een levende plant"). This is the middle ground
   * between presenceFact above (one weak word) and personalFact (life, work,
   * family): worth keeping, and worth reaching the extractor at all, because a
   * bare possession statement otherwise scores below the gate. Measured on
   * 18-10-2026: three such statements were all discarded, so nothing was ever
   * sent to Hindsight while the extractor had no trouble with them.
   */
  ownStandingFact: [
    /\bik\s+(?:heb|bezit)\s+(?:een|één|twee|drie|vier|vijf|zes|zeven|acht|negen|tien|\d{1,3})\s+[\p{L}\p{N}]/iu,
    /\bik\s+heb\s+(?:mijn|onze|ons)\s+\p{L}/iu,
    /\bi\s+(?:have|own)\s+(?:a|an|one|two|three|four|five|six|seven|eight|nine|ten|\d{1,3})\s+[\p{L}\p{N}]/iu,
  ],
  /**
   * What looks like the above but is not standing: what someone is wearing or
   * feeling right now, and abstract nouns that are not a thing. Kept separate
   * so ownStandingFact can stay readable ("ik heb een rode trui aan" is not a
   * fact about his wardrobe; "ik heb een vraag" is not a fact at all).
   */
  momentaryPossession: [
    /\b(?:trui|shirt|jas|vest|broek|jurk|pak|schoenen|laarzen|sokken)\b/i,
    /\bheb\b[^.!?]{0,40}\baan\b/i,
    /\bik\s+heb\s+(?:het\s+)?(?:druk|warm|koud|honger|dorst|haast|gelijk|zin|tijd|moeten?)\b/i,
    /\bik\s+heb\s+(?:een|één)\s+(?:vraag|idee|gevoel|probleem|moment|afspraak|keuze|pauze|plan|tip|bericht|theorie|opmerking)\b/i,
  ],
  /** Decisions & commitments (project decisions, appointments). */
  decision: [
    /\bbezloten\b/i, /\bbesluiten\b/i, /\bbesloten\b/i, /\bbeslist\b/i, /\bwe gaan voor\b/i, /\bkeuze gemaakt\b/i,
    /\bdefinitief\b/i, /\bakkoord\b/i, /\bafspraak\b/i, /\bvaste afspraak\b/i,
    /\bdecided\b/i, /\bwe'?re going with\b/i, /\bcommit(ted)? to\b/i,
  ],
  /** Goals / future consequences. */
  future: [
    /\bvolgende (week|maand|jaar|kwartaal|sprint)\b/i, /\bkomende (week|maand|jaar)\b/i,
    /\bvan plan\b/i, /\bga ik\b/i, /\bwil ik bereiken\b/i, /\bdoel\b/i, /\bstreefdatum\b/i,
    /\bnext (week|month|year)\b/i, /\bplanning to\b/i, /\bgoal\b/i,
  ],
  /**
   * Temporary context — explicitly low-persistence deixis ("even", "zo
   * meteen"). Deliberately narrow: only suppresses when nothing durable
   * co-occurs (§9 temporary context).
   */
  temporary: [
    /\beven\b/i, /\bzo meteen\b/i, /\bben zo terug\b/i, /\bmomenteel\b/i, /\bop dit moment\b/i,
    /\bright now\b/i, /\bbe right back\b/i, /\bbrb\b/i, /\bpauze\b/i, /\bkoffie\b/i, /\bthee\b/i,
  ],
});

/**
 * Pure social-ritual vocabulary beyond memoryPolicy's English filler set —
 * short Dutch acknowledgements/reactions. Only decisive for SHORT turns
 * (see isPureAcknowledgement): "Ja precies." discards, but any substantive
 * clause alongside it keeps normal evaluation.
 */
const ACK_VOCABULARY = new Set([
  'ja', 'jah', 'jawel', 'nee', 'niet', 'oké', 'oke', 'okee', 'ok', 'okay', 'prima',
  'goed', 'mooi', 'fijn', 'top', 'klopt', 'precies', 'inderdaad', 'duidelijk',
  'snap', 'begrijp', 'hoor', 'wel', 'heel', 'helemaal', 'dank', 'bedankt',
  'dankjewel', 'dankje', 'graag', 'gedaan', 'haha', 'hihi', 'hè', 'hm', 'hmm',
  'aha', 'ach', 'ai', 'wow', 'leuk', 'vet', 'zeker', 'check', 'cool', 'nice',
  'yes', 'yep', 'nope', 'thanks', 'thank', 'you', 'great', 'perfect', 'sure',
  // Her own confirmations count too: a reply that only says "Genoteerd." must
  // not read as a substantive answer, or the extractor ends up storing her
  // noting the information as a fact of its own (measured 18-10-2026).
  'genoteerd', 'begrepen', 'noted', 'kept', 'understood',
]);

function clamp01(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

function round(n, places = 2) {
  const f = Math.pow(10, places);
  return Math.round(n * f) / f;
}

function hasSignal(text, patterns) {
  return patterns.some((p) => p.test(text));
}

/**
 * Short turns composed ONLY of acknowledgement/reaction vocabulary —
 * deterministic extension of memoryPolicy's filler judgment to Dutch
 * social ritual ("Ja precies.", "Haha mooi.", "Oké prima hoor").
 */
function isPureAcknowledgement(text) {
  const normalized = String(text || '').toLowerCase().replace(/[.!?,…]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) return true;
  const words = normalized.split(' ');
  if (words.length > 4) return false;
  return words.every((w) => ACK_VOCABULARY.has(w));
}

/**
 * Compares the turn against what recall just surfaced from Hindsight
 * (`existingMemorySignals.recalledReflections`). Returns:
 *   duplicate     — near-identical statement already known (§5 lower/discard)
 *   contradiction — correction language AND the topic is known at all
 *   extendsKnownTopic — same topic, materially different claim (§5 new info)
 *   fresh         — nothing comparable recalled
 *
 * Duplicate similarity uses a CONTAINMENT ratio (|turn∩known| / |turn|):
 * a SHORT restatement of a longer stored memory ("ik werk aan melodiq" vs
 * "Bo werkt aan zijn Melodiq muziekproject in de avonduren") is fully
 * covered by it even though symmetric Jaccard would call the overlap weak.
 */
function relationToExistingMemory(userInput, existingMemorySignals) {
  const reflections = (existingMemorySignals && Array.isArray(existingMemorySignals.recalledReflections))
    ? existingMemorySignals.recalledReflections.filter((r) => r && r.text)
    : [];
  if (!String(userInput || '').trim() || reflections.length === 0) return { relation: 'fresh', overlap: 0 };

  let bestContainment = 0; let bestTopicOverlap = 0;
  for (const r of reflections) {
    bestContainment = Math.max(bestContainment, tokenContainment(userInput, r.text));
    bestTopicOverlap = Math.max(bestTopicOverlap, topicOverlap(userInput, r.text));
  }
  if (bestContainment >= 0.65) return { relation: 'duplicate', overlap: round(bestContainment) };
  if (bestTopicOverlap >= 0.25) return { relation: 'extendsKnownTopic', overlap: round(bestTopicOverlap) };
  return { relation: 'fresh', overlap: 0 };
}

/** |A∩B| over the SMALLER set — how fully one statement covers the other. */
function tokenContainment(a, b) {
  const A = tokensOf(a); const B = tokensOf(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  return inter / Math.min(A.size, B.size);
}

function tokensOf(text) {
  return new Set(String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2));
}

function topicOverlap(a, b) {
  const tokA = String(a || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 4);
  const setB = new Set(String(b || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/));
  if (tokA.length === 0 || setB.size === 0) return 0;
  const hits = tokA.filter((w) => setB.has(w)).length;
  return hits / tokA.length;
}

/**
 * Evaluates one turn. Returns the structured MemoryDecision.
 *
 * @param {{
 *   userInput: string,
 *   assistantReply?: string,                    // Gaia's reply for the completed turn — part of what may be worth remembering
 *   intent?: object|null,                       // IntentIQ's IntentDecision
 *   conversationContext?: Array|null,           // full message history (context only)
 *   existingMemorySignals?: { recalledReflections?: Array }|null,
 * }} input
 * @returns {{ action: 'discard'|'retain_low_priority'|'retain', score: number,
 *             reasons: string[], dimensions: object }}
 */
function evaluateMemoryWorthiness(input = {}) {
  const userInput = String(input.userInput || '');
  const text = userInput.trim();
  const intent = input.intent || null;
  const reasons = [];

  // The turn's own reply is part of what may deserve memory: the durable
  // conclusion, decision or plan often lives in Gaia's answer, not in the
  // (possibly mundane) prompt that triggered it. Bug this fixes: only the
  // user's INPUT was ever judged, so a turn whose substance sat in the reply
  // read as trivia. Signals ABOUT THE PERSON stay user-only — Gaia's "ik" is
  // not Bo — while topic-level signals may come from either side. With no
  // reply supplied the behavior is byte-for-byte what it was.
  const reply = String(input.assistantReply || '').trim();
  const turnText = reply ? `${text}\n${reply}` : text;
  const replySubstantive = Boolean(reply)
    && !isTrivial(reply, MEMORY_POLICY.minReflectLength)
    && !isPureAcknowledgement(reply);

  // --- 1. Dimensions -------------------------------------------------------
  const d = {
    novelty: 0,
    persistence: 0,
    personalRelevance: 0,
    futureUtility: 0,
    correctionValue: 0,
    explicitRecallRequest: 0,
  };

  const isTrivialTurn = isTrivial(text, MEMORY_POLICY.minReflectLength);
  const pureAck = isPureAcknowledgement(text);

  if (SIGNALS.strongRequest.some((p) => p.test(text))) {
    d.explicitRecallRequest = 3;
    reasons.push('explicit_memory_request');
    d.persistence = Math.max(d.persistence, 2);
  }
  if (hasSignal(text, SIGNALS.correction)) {
    d.correctionValue = 3;
    reasons.push('correction_language');
    d.novelty = Math.max(d.novelty, 1);
  }
  // §6: memory.correct INTENT reinforces correction value — input, not verdict.
  if (intent && intent.intent === 'memory.correct') {
    d.correctionValue = Math.max(d.correctionValue, 2);
    reasons.push('intent_memory_correct');
  }
  if (hasSignal(text, SIGNALS.preference)) {
    d.personalRelevance = Math.max(d.personalRelevance, 2);
    d.futureUtility = Math.max(d.futureUtility, 2);
    d.persistence = Math.max(d.persistence, 2);
    d.novelty = Math.max(d.novelty, 1);
    reasons.push('explicit_preference');
  }
  if (hasSignal(text, SIGNALS.personalFact)) {
    d.personalRelevance = Math.max(d.personalRelevance, 3);
    d.persistence = Math.max(d.persistence, 2);
    d.novelty = Math.max(d.novelty, 2);
    reasons.push('personal_fact');
  }
  if (hasSignal(turnText, SIGNALS.lifeEvent)) {
    d.personalRelevance = Math.max(d.personalRelevance, 3);
    d.persistence = Math.max(d.persistence, 3);
    d.futureUtility = Math.max(d.futureUtility, 2);
    d.novelty = Math.max(d.novelty, 2);
    reasons.push('life_event');
  }
  if (hasSignal(text, SIGNALS.presenceFact)) {
    // Weak anchor only: situational self-statements get a nudge, never a
    // durability claim ("Ik ben even koffie halen" is not a memory).
    d.personalRelevance = Math.max(d.personalRelevance, 1);
  }
  if (hasSignal(text, SIGNALS.ownStandingFact) && !hasSignal(text, SIGNALS.momentaryPossession)) {
    // A standing statement about his own surroundings does belong in memory, so
    // it gets past the gate a bare "ik heb …" cannot pass (0.11, measured
    // 18-10-2026). High enough to retain as low priority, not to outrank a life
    // event: 2/2/2 lands at 0.37, just over LOW_PRIORITY_SCORE.
    d.personalRelevance = Math.max(d.personalRelevance, 2);
    d.persistence = Math.max(d.persistence, 2);
    d.novelty = Math.max(d.novelty, 2);
    reasons.push('own_standing_fact');
  }
  if (hasSignal(turnText, SIGNALS.recurrence)) {
    d.persistence = Math.max(d.persistence, 3);
    d.futureUtility = Math.max(d.futureUtility, 2);
    d.novelty = Math.max(d.novelty, 2);
    reasons.push('recurring_commitment');
  }
  if (hasSignal(turnText, SIGNALS.decision)) {
    // Commitments are durable by nature (§9: project decisions, afspraken).
    d.persistence = Math.max(d.persistence, 3);
    d.futureUtility = Math.max(d.futureUtility, 2);
    d.novelty = Math.max(d.novelty, 2);
    reasons.push('decision_or_commitment');
  }
  if (hasSignal(turnText, SIGNALS.future)) {
    // Forward-looking commitments about one's own life/work: useful later,
    // durable across weeks, novel by definition.
    d.futureUtility = Math.max(d.futureUtility, 2);
    d.persistence = Math.max(d.persistence, 2);
    d.novelty = Math.max(d.novelty, 2);
    d.personalRelevance = Math.max(d.personalRelevance, 2);
    reasons.push('future_consequence');
  }
  if (hasSignal(turnText, PAST_REFERENCE_SIGNALS)) {
    // References to prior conversation imply an active memory relationship.
    d.personalRelevance = Math.max(d.personalRelevance, 1);
    reasons.push('references_shared_history');
  }
  if (hasSignal(turnText, DURABLE_CONTEXT_SIGNALS)) {
    d.futureUtility = Math.max(d.futureUtility, 1);
    d.persistence = Math.max(d.persistence, 1);
    reasons.push('durable_topic');
  }

  // Non-trivial, non-acknowledgement speech carries at least situational
  // novelty; pure ritual carries none by definition. A substantive REPLY
  // carries that same floor even when the prompt itself was terse.
  if (!isTrivialTurn && !pureAck) {
    d.novelty = Math.max(d.novelty, 1);
  }
  if (replySubstantive) {
    d.novelty = Math.max(d.novelty, 1);
    reasons.push('substantive_reply');
  }
  // §6: intent is INPUT, never the verdict — memory.inspect/meta.relational
  // nudge relevance at most; inform/converse stay neutral.
  if (intent && intent.intent === 'meta.relational') {
    d.personalRelevance = Math.max(d.personalRelevance, 2);
    reasons.push('relational_turn');
  } else if (intent && intent.intent === 'memory.inspect') {
    d.futureUtility = Math.max(d.futureUtility, 1);
    reasons.push('memory_inspection');
  }
  if (Array.isArray(intent && intent.entities) && intent.entities.length > 0) {
    d.futureUtility = Math.max(d.futureUtility, 1);
  }

  // --- 2. Relation to existing memory (§5) ----------------------------------
  const relation = relationToExistingMemory(userInput, input.existingMemorySignals);
  const isDuplicate = relation.relation === 'duplicate';
  const extendsKnown = relation.relation === 'extendsKnownTopic';
  if (isDuplicate) reasons.push(`duplicate_of_existing_memory(${relation.overlap})`);
  else if (extendsKnown) reasons.push(`extends_known_topic(${relation.overlap})`);

  // --- 3. Score + hard rules -------------------------------------------------
  let score = 0;
  for (const [dim, weight] of Object.entries(DIMENSION_WEIGHTS)) score += d[dim] * weight;
  score = clamp01(score / 3);

  // Rule A — trivial/social-ritual turns discard unless a STRONG signal fired.
  const hasStrongSignal = d.explicitRecallRequest >= 2 || d.correctionValue >= 2
    || d.personalRelevance >= 2 || d.persistence >= 2;
  if ((isTrivialTurn || pureAck) && !hasStrongSignal) {
    return finish('discard', Math.min(score, LOW_PRIORITY_SCORE / 2), [...reasons, 'trivial_or_acknowledgement'], d);
  }
  // Rule B — explicit memory requests always retain (§7).
  if (d.explicitRecallRequest >= 2) score = Math.max(score, 0.75);
  // Rule C — corrections always rank as memory-worthy (§8).
  if (d.correctionValue >= 2) score = Math.max(score, 0.72);
  // Rule G — important personal facts (§9 retain list): a strong, durable,
  // novel first-person fact floors at retain. Losing these is exactly the
  // false-discard cost §18 warns about.
  if (d.personalRelevance >= 3 && d.persistence >= 2 && d.novelty >= 2) {
    score = Math.max(score, RETAIN_SCORE);
    reasons.push('important_personal_fact');
  }
  // Rule H — durable plans/routines (§9: afspraken, long-term context):
  // maximally persistent AND forward-useful AND novel ⇒ retain-worthy even
  // without a first-person fact anchor.
  if (d.persistence >= 3 && d.futureUtility >= 2 && d.novelty >= 2) {
    score = Math.max(score, RETAIN_SCORE);
    reasons.push('durable_plan_or_routine');
  }
  // Rule D — a NEW preference is durable knowledge; a REPEATED one is not (§5).
  if (hasSignal(text, SIGNALS.preference) && d.explicitRecallRequest < 2 && d.correctionValue < 2) {
    if (isDuplicate) { score = Math.min(score, LOW_PRIORITY_SCORE + 0.05); }
    else score = Math.max(score, RETAIN_SCORE);
  }
  // Rule E — duplicates never re-enter as important memory without correction.
  if (isDuplicate && d.correctionValue < 2 && d.explicitRecallRequest < 2) {
    score = Math.min(score, LOW_PRIORITY_SCORE + 0.05);
    reasons.push('duplicate_downgrade');
  }
  // Rule F — temporary context with nothing durable caps at low priority (§9).
  // Ephemeral deixis ("even", "zo meteen", "koffie") demotes any incidental
  // weak anchors: a momentary presence is not a memory unless a durable or
  // corrective signal co-occurs.
  const temporaryContext = hasSignal(text, SIGNALS.temporary)
    && d.explicitRecallRequest < 2 && d.correctionValue < 2
    && !hasSignal(turnText, SIGNALS.decision) && !hasSignal(turnText, SIGNALS.lifeEvent);
  if (temporaryContext && d.persistence <= 2 && d.futureUtility <= 1) {
    d.persistence = Math.min(d.persistence, 1);
    d.personalRelevance = Math.min(d.personalRelevance, 1);
    score = 0;
    for (const [dim, weight] of Object.entries(DIMENSION_WEIGHTS)) score += d[dim] * weight;
    score = clamp01(score / 3);
    score = Math.min(score, LOW_PRIORITY_SCORE + 0.05);
    reasons.push('temporary_context');
  }

  const action = score >= RETAIN_SCORE ? 'retain'
    : (score >= LOW_PRIORITY_SCORE ? 'retain_low_priority' : 'discard');
  return finish(action, score, reasons.length ? reasons : ['below_retain_threshold'], d);

  function finish(act, sc, rs, dims) {
    return { action: act, score: round(clamp01(sc)), reasons: rs, dimensions: dims };
  }
}

/**
 * Whether a memory decision allows the Hindsight reflection to proceed.
 * @param {object|null|undefined} memoryDecision
 * @returns {boolean}
 */
function shouldRetainToHindsight(memoryDecision) {
  return Boolean(memoryDecision && memoryDecision.action !== 'discard');
}

/**
 * Whether a capability's outcome is, on its own, notable enough to force
 * retention — independent of evaluateMemoryWorthiness's score.
 *
 * evaluateMemoryWorthiness runs during the turn immediately after recall, and
 * now also receives the completed turn's reply; even so, a capability's
 * outcome (retry/failure/ask_user) is not something its lexical signals can
 * read, so this stays a separate, additive override. Since P0's
 * runtime integration routes every capability — including ordinary
 * conversational replies via the "hermes" capability — through the same
 * contract loop with at least a trivial default expected_outcome, a
 * routine single-attempt success is the common case and must NOT force
 * retention on its own (that would defeat Memoryworthiness entirely).
 * Only a non-routine outcome does: a retry, a failure, or an ask_user
 * escalation. Losing a PASS/FAIL verdict on a capability contract because
 * the request that triggered it read as lexically mundane ("voer de tests
 * uit") is exactly the false-discard this closes.
 *
 * @param {object|null|undefined} executionResult
 * @returns {boolean}
 */
function isNotableCapabilityOutcome(executionResult) {
  const outcome = executionResult && executionResult.outcome;
  if (!outcome || !outcome.verdict) return false;
  if (outcome.verdict !== 'success') return true;
  return Number(outcome.attempts) > 1;
}

/**
 * Applies the capability-outcome override (see isNotableCapabilityOutcome)
 * to an existing memory decision, upgrading a would-be discard to retain.
 * A null/low-priority/retain decision that is already not a discard is
 * returned unchanged. Never downgrades.
 *
 * @param {object|null} memoryDecision
 * @param {object|null|undefined} executionResult
 * @returns {object|null}
 */
function applyCapabilityOutcomeOverride(memoryDecision, executionResult) {
  if (!isNotableCapabilityOutcome(executionResult)) return memoryDecision;
  if (memoryDecision && memoryDecision.action !== 'discard') return memoryDecision;
  return {
    action: 'retain',
    score: memoryDecision ? memoryDecision.score : 1,
    reasons: [...(memoryDecision ? memoryDecision.reasons : []), 'notable_capability_outcome'],
    dimensions: memoryDecision ? memoryDecision.dimensions : {},
  };
}

/**
 * Hindsight metadata describing the ingest decision (§13/§14) — same gaia_
 * namespace as hypotheses/patterns, string→string per Hindsight's API.
 * @param {object} memoryDecision
 */
function metadataForMemoryDecision(memoryDecision) {
  if (!memoryDecision) return undefined;
  return {
    gaia_memory_decision: String(memoryDecision.action),
    gaia_memory_reason: String((memoryDecision.reasons || []).join('|')).slice(0, 300),
    gaia_memory_priority: memoryDecision.action === 'retain_low_priority' ? 'low' : 'normal',
    gaia_memory_score: String(memoryDecision.score != null ? memoryDecision.score : ''),
  };
}

/**
 * Observability line (§16): action/score/reasons/latency — ids and numbers,
 * never user content. Never allowed to affect the turn.
 * @param {object|null} memoryDecision
 * @param {number} latencyMs
 * @param {(line: string) => void} [logger]
 */
function logMemoryWorthiness(memoryDecision, latencyMs, logger) {
  try {
    if (!memoryDecision) return;
    const line = JSON.stringify({
      kind: 'memory.worthiness',
      action: memoryDecision.action,
      score: memoryDecision.score,
      reasons: memoryDecision.reasons,
      latencyMs: Number.isFinite(latencyMs) ? latencyMs : null,
    });
    if (logger) logger(line);
    else console.log(line);
  } catch (_) { /* observability never breaks the turn */ }
}

module.exports = {
  ACTIONS,
  DIMENSION_WEIGHTS,
  RETAIN_SCORE,
  LOW_PRIORITY_SCORE,
  SIGNALS,
  ACK_VOCABULARY,
  evaluateMemoryWorthiness,
  shouldRetainToHindsight,
  isNotableCapabilityOutcome,
  applyCapabilityOutcomeOverride,
  metadataForMemoryDecision,
  logMemoryWorthiness,
  isPureAcknowledgement,
  relationToExistingMemory,
};
