'use strict';

/**
 * The `web_search` tool — one verb, one shallow lookup.
 *
 * Gaia may reach for the live web on her own initiative when she needs a
 * current external fact she cannot know from what she already has: a price, a
 * date, a version, whether something still exists, what a page actually says
 * now. It is offered only when a search provider is configured at all
 * (server.js builds this tool from `createWebSearchFromEnv`), so she is never
 * told she can search when she cannot.
 *
 * Bounded on purpose: one call in, bounded text out, no agent, no chain, no
 * second search behind her back — the tool returns material, she writes the
 * answer. A failure is reported as a fact she can state plainly; it never
 * reaches the turn as a throw. For anything that needs depth, sources and
 * care, the honest answer is that this is a lookup, and the deep path is the
 * research job (see ./researchReach).
 *
 * The dispatcher follows the codebase convention: any name that is not ours
 * returns exactly `'Unknown action.'` so a composed dispatcher can hand it to
 * the next tool (see generation/gaiaGenerator.js).
 */

const WEB_SEARCH_TOOL = Object.freeze({
  type: 'function',
  function: {
    name: 'web_search',
    description: 'Look something up on the live web when you need a current external fact you cannot know or verify from what you already have — a price, a date, a version, a name, whether something still exists. This is a shallow lookup, not research: one search, a handful of results with their URLs, seconds. If the question needs depth and sources, say that instead.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'What to look up, phrased the way you would type it into a search box.',
        },
        reason: {
          type: 'string',
          description: 'Optional: why you need this, in a few words — kept in the turn log.',
        },
      },
      required: ['query'],
    },
  },
});

/**
 * @param {{ search: (query: string) => Promise<{results: Array<object>, text: string}>, logger?: object }} deps
 */
function createWebSearchTool({ search, logger = console } = {}) {
  if (!search || typeof search.search !== 'function') {
    throw new Error('createWebSearchTool requires a search client');
  }

  async function onToolCall(name, args = {}) {
    if (name !== 'web_search') return 'Unknown action.';
    const query = String((args && args.query) || '').trim();
    if (!query) return 'No search query was given, so nothing was looked up.';
    try {
      const result = await search.search(query);
      logger.info?.(`[websearch] "${query}" → ${result.results.length} result(s)`);
      return result.text;
    } catch (error) {
      logger.warn?.(`[websearch] failed for "${query}": ${error.message}`);
      return `The web lookup failed (${error.message}). Say plainly that you could not look it up.`;
    }
  }

  return { onToolCall, TOOLS: [WEB_SEARCH_TOOL], TOOL: WEB_SEARCH_TOOL };
}

module.exports = { createWebSearchTool, WEB_SEARCH_TOOL };
