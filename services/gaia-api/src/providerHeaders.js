'use strict';

/**
 * Extra request headers for providers that ask their clients to identify themselves.
 *
 * OpenCode (opencode.ai: Zen / Go) asks a client to
 *   - send its own User-Agent rather than a generic HTTP-library one, and
 *   - send a stable session id in `x-opencode-session` for each conversation, so it can optimise
 *     routing and prompt caching.
 * Both are sent to opencode.ai only: another provider has no use for a session id, and a
 * conversation id is not something to hand to a third party that did not ask for it.
 *
 * (OpenCode also expects typical coding-agent traffic. That is a property of what Gaia does, not of
 * a header — see the walkthrough.)
 */

const { version } = require('../package.json');

const USER_AGENT = `gaia-api/${version}`;

/**
 * @param {string} baseUrl the provider's base URL
 * @returns {boolean}
 */
function isOpenCodeHost(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === 'opencode.ai' || host.endsWith('.opencode.ai');
  } catch (_) {
    return false;
  }
}

/**
 * @param {string} baseUrl
 * @param {{ sessionId?: string|null }} [options] the conversation id, stable for the whole conversation
 * @returns {Record<string, string>} headers to add (empty for providers that did not ask for any)
 */
function identityHeadersFor(baseUrl, { sessionId } = {}) {
  if (!isOpenCodeHost(baseUrl)) return {};
  const headers = { 'User-Agent': USER_AGENT };
  if (sessionId) headers['x-opencode-session'] = String(sessionId);
  return headers;
}

module.exports = { identityHeadersFor, isOpenCodeHost, USER_AGENT };
