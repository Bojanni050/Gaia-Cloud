'use strict';

/**
 * Immediate conversational state — lightweight, fast, no Hindsight.
 * Describes what is happening in the conversation right now so the
 * response generator can act as a participant, not a task-solver.
 *
 * This is NOT a new engine, not a duplicate of IntentIQ/ReasonIQ, and
 * not a Hindsight retrieval. It reuses IntentIQ's output and the last
 * 1-2 turns to produce a 2-4 line advisory for the prompt.
 */
const { renderQualityBar } = require('./conversationalOpportunity');

function lastAssistantText(messages) {
  if (!Array.isArray(messages)) return null;
  let idx = messages.length - 1;
  while (idx >= 0 && messages[idx] && messages[idx].role !== 'user') idx -= 1;
  idx -= 1;
  while (idx >= 0 && messages[idx] && messages[idx].role !== 'assistant') idx -= 1;
  return idx >= 0 ? (messages[idx].content || null) : null;
}

function inferInteractionType({ intentDecision, userText, messages }) {
  const text = String(userText || '').trim();
  const prevAssistant = lastAssistantText(messages);
  const lower = text.toLowerCase();

  // Technical task has priority over casual/sharing when no strong personal narrative
  const technicalKeywords = ['server', '502', 'css', 'werkt niet', 'error', 'bug', 'code', 'function', 'api', 'deploy', 'fout'];
  const hasTechnicalKeyword = technicalKeywords.some((k) => lower.includes(k));
  const hasStrongPersonal = /\b(ik|mijn|we|ons)\b/i.test(text) && (text.match(/\b[A-Z][a-z]{2,}\b/g) || []).length >= 2;
  if (hasTechnicalKeyword && !hasStrongPersonal) {
    return 'request';
  }

  // Correction / feedback has priority — user is fixing Gaia
  if (/\b(nee,? zo bedoelde|dat is niet wat ik|je zit (verkeerd|ernaast)|je begrijpt me verkeerd)\b/i.test(text)) {
    return 'correction';
  }
  if (intentDecision && intentDecision.intent === 'meta.correction') return 'correction';
  if (intentDecision && intentDecision.intent === 'meta.question') return 'meta_question';

  // Answer to Gaia's previous question
  if (prevAssistant && /[?]$/.test(prevAssistant.trim()) && intentDecision && intentDecision.meta && intentDecision.meta.reason === 'answer_to_gaia_question') {
    return 'answer';
  }
  // Also detect answer via plain heuristic if intent missed it (e.g., short volunteered sharing after question)
  if (prevAssistant && prevAssistant.includes('?') && text.length > 0 && !text.includes('?') && !/^(zoek|maak|schrijf|leg uit|kun je)/i.test(text)) {
    // If previous was a question and user gave a declarative statement, treat as answer
    // But avoid overclassifying corrections already handled
    if (!lower.startsWith('nee')) return 'answer';
  }

  // Sharing / reflection — user voluntarily telling something
  if (intentDecision && intentDecision.meta && intentDecision.meta.reason === 'volunteered_personal_sharing') return 'sharing';
  if (intentDecision && intentDecision.intent === 'converse' && intentDecision.status === 'accepted') {
    // Distinguish sharing vs casual by length and personal markers
    if (text.length > 40 && /\b(ik|mijn|we|ons)\b/i.test(text)) return 'sharing';
    return 'casual';
  }

  // Question from user
  if (text.includes('?') || /^(waar|wat|wie|wanneer|waarom|hoe|welke|is|ben|heb|where|what|why|how)\b/i.test(text)) return 'question';

  // Task / request — check technical/request signals via intent
  if (intentDecision && ['inform.explain','create.generate','create.transform','decide.support','act.perform'].includes(intentDecision.intent)) return 'request';

  // Fallback: unknown but not a request → casual
  if (!intentDecision || intentDecision.intent === null) {
    if (text.length < 20) return 'casual';
    return 'sharing';
  }

  return 'casual';
}

const GREETING_TRIVIAL = new Set(['hi','hello','hey','hoi','hallo','goedemorgen','goedemiddag','goedenavond','bye','goodnight','night']);
function isTrivialGreeting(text) {
  const n = String(text||'').trim().toLowerCase().replace(/[.!?,]+$/g,'').trim();
  if (!n) return true;
  if (GREETING_TRIVIAL.has(n)) return true;
  if (n.length < 2) return true;
  return false;
}

function renderConversationalState({ intentDecision, messages, userText, opportunityPresent = false }) {
  if (isTrivialGreeting(userText)) return null;
  const type = inferInteractionType({ intentDecision, userText, messages });
  const prevAssistant = lastAssistantText(messages);

  // Task-oriented turns should not get casual advisory — stay task-focused
  if (type === 'request') return null;

  const lines = [];
  lines.push('Conversational state — immediate context (lightweight, no Hindsight needed):');

  if (type === 'answer' && prevAssistant) {
    lines.push(`- User is ANSWERING Gaia's previous question: "${prevAssistant.slice(0, 80)}" with "${String(userText).slice(0, 80)}"`);
    lines.push('- This is not a new request. No clarification needed. Respond to the answer itself.');
  } else if (type === 'correction') {
    lines.push(`- User is CORRECTING Gaia ("${String(userText).slice(0, 60)}") — acknowledge the correction and adjust, do not continue previous assumption.`);
  } else if (type === 'sharing') {
    lines.push(`- User is SHARING personal context voluntarily (no request, no question).`);
    lines.push('- No task to solve. Notice what matters in what was shared.');
  } else if (type === 'question') {
    lines.push('- User is ASKING a question — answer it directly.');
  } else if (type === 'casual') {
    lines.push(`- User said: "${String(userText).slice(0, 60)}" — casual continuation, no task.`);
    lines.push('- No request to fulfill. A brief natural contribution is enough.');
  } else if (type === 'meta_question') {
    lines.push('- User is asking about Gaia herself — answer about Gaia, not a task.');
  }

  // Common casual principles — only for non-task turns
  if (type === 'answer' || type === 'sharing' || type === 'casual' || type === 'correction') {
    lines.push('- Guidance: What would be a natural contribution from me right now? (not "what information should I provide?" or "how to keep user talking?")');
    lines.push('- Keep it light and short: 1 sentence for small turns, 1–3 for normal. No paragraphs for "haha ja"/"Ja."');
    lines.push('- Question discipline: only ask a question if earned by the conversation and grounded in specific details; never append a generic question to continue engagement.');
    lines.push('- Be specific to this conversation (could this response have been written without the preceding context? If yes, too generic). Do not over-interpret or invent hidden meaning/personality traits.');

    // The full anti-generic-empathy/paraphrase quality bar (conversationalOpportunity.js)
    // used to reach the model ONLY when evaluateConversationalOpportunity's narrow
    // achievement/rich-context/answer heuristics happened to fire — an ordinary
    // casual/sharing turn with none of those markers got none of this guidance at
    // all. This is the broader, always-applicable gate (any non-task turn), so
    // fold it in here too. Skipped when the opportunity block already included it
    // this turn (opportunityPresent) to avoid sending the same ~50 lines twice.
    if (!opportunityPresent) {
      lines.push('');
      lines.push(renderQualityBar());
    }
  }

  return lines.join('\n');
}

module.exports = { inferInteractionType, renderConversationalState, lastAssistantText };
