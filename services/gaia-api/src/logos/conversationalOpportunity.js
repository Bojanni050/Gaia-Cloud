'use strict';

/**
 * Conversational Opportunity — advisory guidance for Gaia's response layer.
 *
 * Part of Logos.ReasonIQ: identifies whether there is a natural, human
 * reason for Gaia to show interest in this turn. This is NOT a decision to
 * ask a question — it is an observation that the response layer MAY use
 * as a brief acknowledgement, reflection, empathy, celebration, or (when
 * genuinely natural) a follow-up question. interest ≠ questioning.
 *
 * Architecture: reasonIQ identifies and describes the opportunity; the Gaia
 * decision/response layer decides whether and how to express it. The
 * structured result is advisory, never an instruction.
 *
 * Pure function: same inputs, same output, no I/O, no model calls.
 * Delete-friendly: removing this module only removes advisory nuance.
 */

// --- constants --------------------------------------------------------------

/** Values for naturalResponse — keep in sync with spec. */
const NATURAL_RESPONSES = Object.freeze([
  'none',
  'acknowledgement',
  'curiosity',
  'empathy',
  'celebration',
  'reflection',
]);

/** Trivial responses that must never create an opportunity. */
const TRIVIAL_NORM = new Set([
  'ok', 'okay', 'oké', 'oke', 'k', 'kk',
  'ja', 'nee', 'yes', 'no', 'yep', 'yup', 'nope',
  'dank je', 'dankje', 'bedankt', 'thanks', 'thank you', 'thx', 'ty',
  'dank je wel', 'dankjewel',
  'cool', 'nice', 'great', 'top', 'prima', 'goed',
  'got it', 'gotcha', 'lol', 'haha',
  'hi', 'hello', 'hey', 'hoi', 'hallo', 'bye',
]);

/** Technical intents where social curiosity would be distracting. */
const TECHNICAL_INTENTS = new Set([
  'inform.explain',
  'create.transform',
  'create.generate',
  'decide.support',
  'act.perform',
]);

/** Minimum words to consider a short direct answer vs trivial. */
const SHORT_ANSWER_MAX_WORDS = 6;
const SHORT_ANSWER_MAX_CHARS = 40;

// --- helpers ----------------------------------------------------------------

function normalize(text) {
  return String(text || '').trim().toLowerCase().replace(/[.!?,]+$/g, '').replace(/\s+/g, ' ').trim();
}

function isTrivial(text) {
  const n = normalize(text);
  if (!n) return true;
  if (TRIVIAL_NORM.has(n)) return true;
  // single punctuation / emoji-only trivial
  if (/^[.!?]+$/.test(n)) return true;
  // very short single-word filler not in set but length 1-2 chars
  if (n.length <= 2 && n.split(/\s+/).length === 1) return true;
  return false;
}

function wordCount(text) {
  const t = String(text || '').trim();
  if (!t) return 0;
  return t.split(/\s+/).filter(Boolean).length;
}

function isDutch(text) {
  const t = String(text || '').toLowerCase();
  // simple heuristic: Dutch-specific words / characters
  return /(?:\b(ik|mijn|waar|ben|je|nu|in|met|voor|heb|heeft|eindelijk|klaar|website|nummer|afgemaakt|vandaag|brengt|daar|hoe|wat)\b|[ëïéè])/i.test(t);
}

function isQuestion(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (t.includes('?')) return true;
  // Dutch/English interrogative starts without question mark (fallback)
  return /^(waar|wat|wie|wanneer|waarom|hoe|welke|is|ben|heb|heb je|kun je|where|what|who|when|why|how|which|are you|do you|can you)\b/i.test(t);
}

function lastAssistantQuestion(conversationContext) {
  if (!Array.isArray(conversationContext) || conversationContext.length < 2) return null;
  // Find last user index
  let lastUserIdx = -1;
  for (let i = conversationContext.length - 1; i >= 0; i -= 1) {
    if (conversationContext[i] && conversationContext[i].role === 'user') { lastUserIdx = i; break; }
  }
  if (lastUserIdx <= 0) return null;
  // Walk backwards from just before last user to find previous assistant
  for (let i = lastUserIdx - 1; i >= 0; i -= 1) {
    const m = conversationContext[i];
    if (m && m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) {
      if (isQuestion(m.content)) return m.content.trim();
      return null; // previous assistant turn existed but wasn't a question
    }
  }
  return null;
}

function questionSubject(question) {
  const q = String(question || '').toLowerCase();
  if (/waar ben je/.test(q) || /where are you/.test(q)) return "user's current location";
  if (/waar.*ben je/.test(q)) return "user's current location";
  if (/how are you|hoe gaat het|hoe is het/.test(q)) return "user's wellbeing";
  // generic: strip question mark, truncate
  const s = String(question || '').replace(/[?]+$/g, '').trim();
  if (s.length <= 60) return s;
  return `${s.slice(0, 57)}…`;
}

function containsPersonalDetail(text) {
  const t = String(text || '');
  const lower = t.toLowerCase();
  // Achievement / personal milestone markers (bilingual)
  const patterns = [
    /eindelijk/i,
    /klaar met/i,
    /afgemaakt/i,
    /eerste nummer/i,
    /first (song|track|number)/i,
    /mijn (website|nummer|song|project|boek|album)/i,
    /my (website|song|track|project|book|album)/i,
    /ik heb vandaag/i,
    /\bik ben\b.*\b(klaar|trots|blij)\b/i,
  ];
  return patterns.some((p) => p.test(t)) && lower.length > 15;
}

function containsRichPersonalContext(text) {
  const t = String(text || '');
  if (t.length < 80) return false;
  if (!/\b(ik|mijn|mij|we|ons)\b/i.test(t)) return false;
  const personalMarkers = (t.match(/\b(ouders|relatie|partner|huis|papegaai|papegaaien|Ierland|Maarn|jaar|jaren|familie|relatie gehad)\b/gi) || []).length;
  const capitalizedNames = (t.match(/\b[A-Z][a-z]{2,}\b/g) || []).length;
  const hasNames = capitalizedNames >= 3;
  const hasRelationship = personalMarkers >= 1;
  const hasEmotionalDuration = /\b\d+\s*jaar\b/i.test(t) || /relatie gehad/i.test(t);
  // Rich if: multiple names + relationship, or markers + duration
  return (hasNames && hasRelationship) || (personalMarkers >= 2) || hasEmotionalDuration;
}

function isLongAnswerToLocationQuestion(text, prevQuestion) {
  if (!prevQuestion) return false;
  if (!/waar ben je|where are you/i.test(String(prevQuestion).toLowerCase())) return false;
  const trimmed = String(text || '').trim();
  // Starts with location answer even if long: "In Maarn, in het huis van ..."
  if (/^in\s+[A-Z][a-z]+/i.test(trimmed)) return true;
  // Or contains location + house context
  if (/in\s+Maarn/i.test(trimmed) && /huis van/i.test(trimmed)) return true;
  return false;
}

function isTechnicalTask(intentDecision, text) {
  const t = String(text || '').toLowerCase();
  const technicalKeywords = ['css', 'werkt niet', 'werkt nog steeds niet', 'error', 'bug', 'code', 'function', 'api', 'deploy', 'fout'];
  const hasTechKeyword = technicalKeywords.some((kw) => t.includes(kw));
  if (hasTechKeyword) return true;
  if (!intentDecision || !intentDecision.intent) return false;
  if (!TECHNICAL_INTENTS.has(intentDecision.intent)) return false;
  if (intentDecision.sourceOfTruth === 'external_knowledge' || intentDecision.sourceOfTruth === 'tool') return true;
  return true;
}

function isShortDirectAnswer(text, prevQuestion) {
  if (!prevQuestion) return false;
  const wc = wordCount(text);
  const len = String(text || '').trim().length;
  if (wc === 0) return false;
  // Short answer heuristic: few words, limited length, not trivial filler
  if (wc <= SHORT_ANSWER_MAX_WORDS && len <= SHORT_ANSWER_MAX_CHARS && !isTrivial(text)) return true;
  // Also location-like: "In Maarn." -> 2 words, preposition + place
  if (/^in\s+\w+/i.test(String(text || '').trim()) && wc <= 4) return true;
  return false;
}

// --- main evaluation --------------------------------------------------------

/**
 * @param {{
 *   text: string,
 *   conversationContext?: Array<{role: string, content: string}>,
 *   intentDecision?: object|null,
 * }} input
 * @returns {{
 *   present: boolean,
 *   strength: number,
 *   subject: string|null,
 *   reason: string|null,
 *   naturalResponse: 'none'|'acknowledgement'|'curiosity'|'empathy'|'celebration'|'reflection',
 *   suggestedFollowUp: string|null
 * }}
 */
function evaluateConversationalOpportunity(input) {
  const text = String(input.text || '').trim();
  const conversationContext = Array.isArray(input.conversationContext) ? input.conversationContext : [];
  const intentDecision = input.intentDecision || null;

  // --- 0. trivial / empty --------------------------------------------------
  if (!text || isTrivial(text)) {
    return {
      present: false,
      strength: 0,
      subject: null,
      reason: 'trivial response carries no meaningful detail to respond to',
      naturalResponse: 'none',
      suggestedFollowUp: null,
    };
  }

  const prevQuestion = lastAssistantQuestion(conversationContext);
  const isAnswer = isShortDirectAnswer(text, prevQuestion) || isLongAnswerToLocationQuestion(text, prevQuestion);
  const hasPersonal = containsPersonalDetail(text);
  const hasRichContext = containsRichPersonalContext(text);
  const dutch = isDutch(text) || (prevQuestion && isDutch(prevQuestion));

  // --- 1. task-focused: stay on task, do not introduce curiosity --------
  // But: answering a previous location question is NOT a technical task, even
  // if intent mis-routes short answer as unknown — prioritize answer detection
  if (isAnswer) {
    // Long rich answer: reflect the full context, not just location curiosity
    if (hasRichContext || String(text).length > 80) {
      return {
        present: true,
        strength: 0.88,
        subject: "user's house-sitting context in Maarn",
        reason: 'User answered Gaia\'s location question with extensive volunteered personal context (people, relationships, house and pets).',
        naturalResponse: 'reflection',
        suggestedFollowUp: null,
      };
    }
    const subj = questionSubject(prevQuestion);
    const followUp = dutch ? 'Wat brengt je daar?' : 'What brings you there?';
    // If the answer is to a location question, curiosity is natural
    if (/location/i.test(subj)) {
      return {
        present: true,
        strength: 0.82,
        subject: subj,
        reason: 'The user answered a question Gaia previously asked with a concrete personal detail.',
        naturalResponse: 'curiosity',
        suggestedFollowUp: followUp,
      };
    }
    // Generic answer to previous question -> acknowledgement or curiosity, not interrogation
    return {
      present: true,
      strength: 0.72,
      subject: subj,
      reason: 'The user answered a question Gaia previously asked.',
      naturalResponse: 'acknowledgement',
      suggestedFollowUp: null,
    };
  }

  // Technical tasks override personal curiosity only when not already an answer
  if (isTechnicalTask(intentDecision, text)) {
    return {
      present: false,
      strength: 0,
      subject: null,
      reason: 'Conversation is primarily task-focused; social curiosity would be distracting.',
      naturalResponse: 'none',
      suggestedFollowUp: null,
    };
  }

  // --- 2. rich volunteered personal context (without needing specific achievement marker) ----
  if (hasRichContext) {
    return {
      present: true,
      strength: 0.85,
      subject: "user's volunteered personal context",
      reason: 'User voluntarily shared rich personal context with multiple people, relationships and details.',
      naturalResponse: 'reflection',
      suggestedFollowUp: null,
    };
  }

  // --- 3. personally meaningful detail ------------------------------------
  if (hasPersonal) {
    const lower = text.toLowerCase();
    // Celebration: finally finished something, first creation
    if (/eindelijk|afgemaakt|eerste nummer|first.*song/i.test(lower)) {
      // Decide between celebration and curiosity based on tone
      // "Ik ben eindelijk klaar met mijn website." -> celebration, maybe curiosity
      const isWebsite = /website/i.test(lower);
      const isSong = /nummer|song|track/i.test(lower);
      if (isWebsite) {
        return {
          present: true,
          strength: 0.78,
          subject: 'user finishing their website',
          reason: 'User shared a personally meaningful completion with emotional weight ("eindelijk").',
          naturalResponse: 'celebration',
          suggestedFollowUp: dutch ? 'Hoe is het geworden?' : 'How did it turn out?',
        };
      }
      if (isSong) {
        return {
          present: true,
          strength: 0.80,
          subject: "user's first finished song",
          reason: 'User shared a personally significant creative milestone.',
          naturalResponse: 'celebration',
          suggestedFollowUp: dutch ? 'Hoe voelt het om hem eindelijk af te hebben?' : 'How does it feel to finally have it finished?',
        };
      }
      return {
        present: true,
        strength: 0.75,
        subject: 'personal achievement',
        reason: 'User shared a personally meaningful achievement.',
        naturalResponse: 'celebration',
        suggestedFollowUp: null,
      };
    }
    return {
      present: true,
      strength: 0.68,
      subject: 'personal detail',
      reason: 'User shared a personally meaningful detail that invites acknowledgement.',
      naturalResponse: 'acknowledgement',
      suggestedFollowUp: null,
    };
  }

  // --- 4. no natural opening -----------------------------------------------
  // Check for already sufficiently explored or no opening
  // For now, default to no opportunity when no signal above fires
  return {
    present: false,
    strength: 0,
    subject: null,
    reason: 'No distinct personal or contextual detail invites a natural show of interest.',
    naturalResponse: 'none',
    suggestedFollowUp: null,
  };
}

function clampStrength(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function coerceOpportunity(value) {
  if (!value || typeof value !== 'object') return null;
  const present = Boolean(value.present);
  const strength = clampStrength(value.strength);
  const subject = typeof value.subject === 'string' && value.subject.trim() ? value.subject.trim() : null;
  const reason = typeof value.reason === 'string' && value.reason.trim() ? value.reason.trim() : null;
  const naturalResponse = NATURAL_RESPONSES.includes(value.naturalResponse) ? value.naturalResponse : (present ? 'acknowledgement' : 'none');
  const suggestedFollowUp = typeof value.suggestedFollowUp === 'string' && value.suggestedFollowUp.trim() ? value.suggestedFollowUp.trim() : null;
  // Enforce: if not present, naturalResponse must be none and suggestedFollowUp null
  if (!present) {
    return { present: false, strength: 0, subject: null, reason, naturalResponse: 'none', suggestedFollowUp: null };
  }
  return { present, strength, subject, reason, naturalResponse, suggestedFollowUp };
}

/**
 * Renders an advisory system message for the generation layer.
 * Returns null when there is no opportunity or guidance would be forced.
 * Advisory, never an instruction.
 * @param {{ present: boolean, strength: number, subject: string|null, reason: string|null, naturalResponse: string, suggestedFollowUp: string|null }|null} opp
 * @returns {string|null}
 */
function renderOpportunityGuidance(opp) {
  if (!opp || !opp.present) return null;
  // Keep guidance brief and advisory, grounded in SOUL: calm, curious, honest
  const lines = [];
  lines.push('Advisory — conversational opportunity (never an instruction):');
  lines.push(`- subject: ${opp.subject || 'personal detail'}`);
  if (opp.reason) lines.push(`- reason: ${opp.reason}`);
  lines.push(`- natural response style: ${opp.naturalResponse} (acknowledgement, reflection, empathy, celebration, or curiosity — choose only what feels natural; a single brief sentence is often enough).`);
  if (opp.suggestedFollowUp) {
    lines.push(`- optional follow-up idea (use only if it feels natural, never to keep conversation going): "${opp.suggestedFollowUp}"`);
  } else {
    lines.push('- no follow-up question is needed; a brief acknowledgement or reflection is enough.');
  }
  lines.push('Respond to the HUMAN MEANING of what was shared, not merely that you parsed the facts. Notice something, make a natural observation, acknowledge significance, show gentle curiosity, or connect two things mentioned — then leave space.');
  lines.push('Do not mechanically summarize, confirm, classify or extract facts. Avoid formulations such as "That is a clear situation.", "I understand.", "So you are...", "You are therefore...", "This gives me a better understanding.", "Thank you for sharing." unless genuinely natural in this specific context.');
  lines.push('Would this sound natural if a person said it to another person? If the response mainly proves you understood the information rather than actually responding to it, it is not good enough.');
  lines.push('Do not manufacture a question. Do not be verbose. Interest ≠ questioning.');
  return lines.join('\n');
}

module.exports = {
  evaluateConversationalOpportunity,
  coerceOpportunity,
  renderOpportunityGuidance,
  NATURAL_RESPONSES,
  isTrivial, // exported for testing
};
