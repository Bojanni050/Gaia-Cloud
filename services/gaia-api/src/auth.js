'use strict';

/**
 * Bearer-token authentication for the Gaia API.
 *
 * Tokens come from the environment (comma-separated, so each client/device
 * can have its own). When no token is configured the server fails closed:
 * every request is refused. There is no anonymous access to Gaia.
 */
const crypto = require('crypto');

function parseTokens(raw) {
  return new Set(
    String(raw || '')
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
  );
}

const digest = (value) => crypto.createHash('sha256').update(String(value)).digest();

/**
 * Whether `candidate` is one of the configured tokens, compared in constant
 * time: both sides are hashed to the same length first (timingSafeEqual needs
 * equal lengths and would otherwise leak the length), and every token is
 * checked so the time taken does not say which one matched or how many
 * leading characters were right.
 */
function isKnownToken(tokens, candidate) {
  const wanted = digest(candidate);
  let known = false;
  for (const token of tokens) {
    if (crypto.timingSafeEqual(wanted, digest(token))) known = true;
  }
  return known;
}

function createAuthMiddleware(tokens) {
  return function auth(req, res, next) {
    if (tokens.size === 0) {
      return res.status(503).json({ error: 'server not configured' });
    }
    const header = req.headers.authorization || '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match || !isKnownToken(tokens, match[1].trim())) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    next();
  };
}

module.exports = { parseTokens, createAuthMiddleware };
