'use strict';

/**
 * Mastra tools for Gaia's research agent — the Gaia-side verbs a Mastra
 * research agent may call. Each tool wraps an existing Gaia subsystem
 * (web search, Hindsight recall, Foundation archive) behind a typed
 * Mastra `createTool` definition.
 *
 * Boundary: these tools are the ONLY way the Mastra agent reaches Gaia's
 * stores. The agent never talks to Hindsight, Foundation or the web search
 * client directly — it calls a tool, the tool calls Gaia, and the result
 * comes back as material, never as an answer. Gaia's voice stays Gaia's:
 * the research agent produces findings, the turn writes the reply.
 *
 * Why Mastra tools and not plain functions: Mastra's agent loop needs
 * schema-validated tools with `createTool()` (plain objects silently fail
 * to execute). Each tool declares its input/output with zod so the model
 * knows exactly what it may ask for.
 *
 * These are CommonJS — gaia-api is `"type": "commonjs"`. Mastra's own
 * packages are ESM-only, so the agent module dynamically imports them
 * (see mastraResearchAgent.js). The tools themselves stay dependency-free:
 * they only need the Gaia clients injected at construction time.
 */

const { z } = require('zod');

/**
 * Web search tool — the shallow live lookup, reused from Gaia's own
 * webSearchClient. One call, a handful of results, never the deep path.
 *
 * @param {{ webSearch: { search: (query: string) => Promise<{ results: Array<{ title: string, url: string, snippet: string }> }> } }} deps
 */
function createMastraWebSearchTool({ webSearch }) {
  if (!webSearch || typeof webSearch.search !== 'function') {
    return null;
  }
  return {
    id: 'gaia-web-search',
    description: 'Look something up on the live web for current external information. Returns a short list of results with titles, URLs and snippets.',
    inputSchema: z.object({
      query: z.string().describe('The search query — be specific, this is a single shallow lookup'),
    }),
    outputSchema: z.object({
      results: z.array(z.object({
        title: z.string(),
        url: z.string(),
        snippet: z.string(),
      })),
    }),
    execute: async ({ query }) => {
      const raw = await webSearch.search(String(query || ''));
      const results = Array.isArray(raw && raw.results) ? raw.results : [];
      return {
        results: results.slice(0, 8).map((r) => ({
          title: String(r.title || ''),
          url: String(r.url || ''),
          snippet: String(r.snippet || r.description || '').slice(0, 320),
        })),
      };
    },
  };
}

/**
 * Hindsight recall tool — Gaia's long-term memory, the derived store.
 * The research agent may look there for what Gaia already understands
 * about the person or the subject, so its findings build on what is
 * already known instead of starting from zero.
 *
 * @param {{ hindsight: { recall: (query: string) => Promise<Array<{ text: string, tags?: string[] }>> } }} deps
 */
function createMastraHindsightRecallTool({ hindsight }) {
  if (!hindsight || typeof hindsight.recall !== 'function') {
    return null;
  }
  return {
    id: 'gaia-memory-recall',
    description: "Recall what Gaia already understands from long-term memory — things she has come to know about the person or the subject. Returns relevant memories with their tags.",
    inputSchema: z.object({
      query: z.string().describe('What to recall — a concept, a person, a topic'),
    }),
    outputSchema: z.object({
      memories: z.array(z.object({
        text: z.string(),
        tags: z.array(z.string()).optional(),
      })),
    }),
    execute: async ({ query }) => {
      const raw = await hindsight.recall(String(query || ''));
      const items = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.memories) ? raw.memories : []);
      return {
        memories: items.slice(0, 10).map((m) => ({
          text: String((m && (m.text || m.content || m.memory)) || ''),
          tags: Array.isArray(m && m.tags) ? m.tags.map(String) : undefined,
        })).filter((m) => m.text.length > 0),
      };
    },
  };
}

/**
 * Foundation archive tool — the raw recorded reality, the archive
 * counterpart of Hindsight. Status-labelled results: what is recorded
 * as a confirmed fact, a hypothesis, an open question. Never a second
 * reflective memory.
 *
 * @param {{ foundation: { searchResults: (query: string) => Promise<Array<{ text: string, status?: string }>> } }} deps
 */
function createMastraFoundationSearchTool({ foundation }) {
  if (!foundation || typeof foundation.searchResults !== 'function') {
    return null;
  }
  return {
    id: 'gaia-archive-search',
    description: "Search what is RECORDED in the Foundation archive — raw observations, registered facts, hypotheses with their status. Always status-labelled.",
    inputSchema: z.object({
      query: z.string().describe('What to look up in the recorded archive'),
    }),
    outputSchema: z.object({
      results: z.array(z.object({
        text: z.string(),
        status: z.string().optional(),
      })),
    }),
    execute: async ({ query }) => {
      const raw = await foundation.searchResults(String(query || ''));
      const items = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.results) ? raw.results : []);
      return {
        results: items.slice(0, 10).map((r) => ({
          text: String((r && (r.text || r.content || r.statement)) || ''),
          status: r && r.status ? String(r.status) : undefined,
        })).filter((r) => r.text.length > 0),
      };
    },
  };
}

/**
 * Conversation search tool — the literal transcript of past conversations,
 * the honest counterpart to Hindsight. What was ACTUALLY said, by either
 * party, never the memory of it.
 *
 * @param {{ conversationSearch: { search: (query: string) => Promise<Array<{ snippet: string, conversationId?: string }>> } }} deps
 */
function createMastraConversationSearchTool({ conversationSearch }) {
  if (!conversationSearch || typeof conversationSearch.search !== 'function') {
    return null;
  }
  return {
    id: 'gaia-conversation-search',
    description: 'Search the literal text of past conversations — what was actually said, by either party. Use this when the question is about something said before.',
    inputSchema: z.object({
      query: z.string().describe('The literal text or topic to find in past conversations'),
    }),
    outputSchema: z.object({
      results: z.array(z.object({
        snippet: z.string(),
        conversationId: z.string().optional(),
      })),
    }),
    execute: async ({ query }) => {
      const raw = await conversationSearch.search(String(query || ''));
      const items = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.results) ? raw.results : []);
      return {
        results: items.slice(0, 8).map((r) => ({
          snippet: String((r && (r.snippet || r.text || r.content)) || '').slice(0, 400),
          conversationId: r && r.conversationId ? String(r.conversationId) : undefined,
        })).filter((r) => r.snippet.length > 0),
      };
    },
  };
}

/**
 * Builds the full tool set for the research agent. Absent subsystems
 * yield no tool — the agent simply does not get that verb, exactly like
 * Gaia's own tool wiring (memory tools are only present when the store
 * is wired).
 *
 * @param {{ webSearch?: object, hindsight?: object, foundation?: object, conversationSearch?: object }} deps
 * @returns {Record<string, object>} tool map keyed by tool id
 */
function buildResearchTools(deps = {}) {
  const tools = {};
  const webSearch = createMastraWebSearchTool({ webSearch: deps.webSearch });
  if (webSearch) tools[webSearch.id] = webSearch;
  const recall = createMastraHindsightRecallTool({ hindsight: deps.hindsight });
  if (recall) tools[recall.id] = recall;
  const archive = createMastraFoundationSearchTool({ foundation: deps.foundation });
  if (archive) tools[archive.id] = archive;
  const convSearch = createMastraConversationSearchTool({ conversationSearch: deps.conversationSearch });
  if (convSearch) tools[convSearch.id] = convSearch;
  return tools;
}

module.exports = {
  createMastraWebSearchTool,
  createMastraHindsightRecallTool,
  createMastraFoundationSearchTool,
  createMastraConversationSearchTool,
  buildResearchTools,
};
