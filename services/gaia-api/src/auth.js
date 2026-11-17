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

/**
 * The operator surface's own token — deliberately **not** `GAIA_API_TOKEN`.
 *
 * Every client and every device holds an API token, so that token cannot be the
 * thing that opens `/admin`: provider keys, model choices, the durable Logos
 * decision log, skill telemetry and the background-pass surface all sit behind
 * those routes, and one leaked client configuration would then be operator
 * access (`docs/advice.md` C3).
 *
 * Unset is a real state and not something to paper over by falling back to the
 * token every client already has: no `GAIA_ADMIN_TOKEN` means nobody is the
 * operator, so `/admin/api/*` answers 503 and names the missing variable. That
 * is louder — and more useful — than a 401 that reads as "wrong token". The log
 * line fires the first time somebody actually needs admin, not at every boot,
 * so a deployment that never uses the operator surface stays quiet.
 *
 * The HTML shell (`GET /admin`) stays unauthenticated on purpose: a browser
 * cannot send a Bearer header on a plain navigation, the page holds no data by
 * itself, and every call it makes carries the operator token from its own input.
 */
function createOperatorAuth(raw, { logger = console } = {}) {
  const tokens = parseTokens(raw);
  const check = createAuthMiddleware(tokens);
  let warned = false;
  return function operatorAuth(req, res, next) {
    if (tokens.size === 0) {
      if (!warned) {
        warned = true;
        logger.warn?.('[admin] GAIA_ADMIN_TOKEN is unset — /admin/api/* answers 503 until it is');
      }
      return res.status(503).json({ error: 'no admin token configured' });
    }
    return check(req, res, next);
  };
}

module.exports = { parseTokens, createAuthMiddleware, createOperatorAuth };
