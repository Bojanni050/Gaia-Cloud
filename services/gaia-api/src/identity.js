'use strict';

/**
 * Gaia Identity — single authoritative source for conversational participants.
 *
 * Architecture: Gaia ↔ User. Hermes is a capability, never the conversational
 * identity. This module owns both sides of the conversation identity so no
 * other module (Hindsight adapter, memory provider, document builder, session
 * builder, Hermes, response engine) needs to hardcode or derive them
 * independently.
 *
 * Development: user is Bojan (bankId `bojan`).
 * Production: user is dynamically derived from the authenticated user's
 * configured display name.
 *
 * Assistant identity is always Gaia, never the capability currently being
 * used (Hermes, etc.).
 */

const ASSISTANT_DISPLAY_NAME = 'Gaia';
const ASSISTANT_ID = 'gaia';
const DEFAULT_USER_DISPLAY_NAME = 'Bojan';

/**
 * @returns {{ displayName: string, id: string }}
 */
function getAssistantIdentity() {
  return { displayName: ASSISTANT_DISPLAY_NAME, id: ASSISTANT_ID };
}

/**
 * Returns the current user's identity.
 *
 * Resolution order (single source, no duplication):
 * 1. Explicit override passed by caller (for tests or multi-user request context)
 *    - options.displayName / options.userDisplayName
 *    - options.user?.displayName
 *    - options.req?.headers['x-user-display-name'] (future multi-user header)
 * 2. Environment variable GAIA_USER_DISPLAY_NAME (production configuration)
 * 3. Default for development (Bojan)
 *
 * The bankId is not the source of truth for display name; it is an
 * infrastructure detail. The display name is the user-facing identity.
 *
 * @param {{ displayName?: string, userDisplayName?: string, user?: { displayName?: string }, req?: { headers?: Record<string,string> }, authToken?: string }} [options]
 * @returns {{ displayName: string, id: string }}
 */
function getUserIdentity(options = {}) {
  let displayName = null;

  if (options && typeof options.displayName === 'string' && options.displayName.trim()) {
    displayName = options.displayName.trim();
  } else if (options && typeof options.userDisplayName === 'string' && options.userDisplayName.trim()) {
    displayName = options.userDisplayName.trim();
  } else if (options && options.user && typeof options.user.displayName === 'string' && options.user.displayName.trim()) {
    displayName = options.user.displayName.trim();
  } else if (options && options.req && options.req.headers) {
    const h = options.req.headers['x-user-display-name'] || options.req.headers['X-User-Display-Name'] || options.req.headers['x-user-displayname'];
    if (typeof h === 'string' && h.trim()) displayName = h.trim();
  }

  if (!displayName) {
    const envName = process.env.GAIA_USER_DISPLAY_NAME;
    if (typeof envName === 'string' && envName.trim()) displayName = envName.trim();
  }

  if (!displayName) displayName = DEFAULT_USER_DISPLAY_NAME;

  return { displayName, id: displayName.toLowerCase() };
}

/**
 * @param {{ userDisplayName?: string, user?: { displayName?: string }, req?: object }} [options]
 * @returns {string} e.g. "conversation between Gaia and Bojan"
 */
function getConversationContext(options = {}) {
  const assistant = getAssistantIdentity().displayName;
  const user = getUserIdentity(options).displayName;
  return `conversation between ${assistant} and ${user}`;
}

module.exports = {
  ASSISTANT_DISPLAY_NAME,
  ASSISTANT_ID,
  DEFAULT_USER_DISPLAY_NAME,
  getAssistantIdentity,
  getUserIdentity,
  getConversationContext,
};
