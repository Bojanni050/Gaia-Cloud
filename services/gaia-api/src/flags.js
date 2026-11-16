'use strict';

/**
 * Flags — one reader for every behaviour flag.
 *
 * Why this exists: the same intent was written four different ways
 * (`=== 'true'`, `!== 'false'`, `=== 'on'`, `(env.X || 'true') !== 'true'`), and
 * three of those turned a documented value into a silent *disable*:
 * `GAIA_HYPOTHESIS_EXPIRY=on` or `GAIA_RESEARCH_REACH=true` switched a pass off
 * without a word — and a quiet background pass is invisible until its store is
 * empty weeks later (docs/advice.md C4).
 *
 * The contract, identical for every flag:
 *
 *   unset / empty         → the flag's documented default
 *   true | on | 1 | yes   → on
 *   false | off | 0 | no  → off
 *   anything else         → the default, with a warning naming flag and value
 *
 * The last line is deliberate: an unrecognised value is a deployment mistake,
 * not a third state. It takes the default — a typo in `.env` must not take the
 * API down — and says so in the log, so the mistake is visible instead of
 * silent. The default is per flag and is documented, with its read site, in the
 * switches table of docs/architecture.md; this module never guesses one.
 *
 * Not every environment variable is a flag. Paths, tokens, intervals, timeouts
 * and the one enum (`GAIA_HYPOTHESIS_FORMATION`) are not booleans and are read
 * where they belong.
 */

const TRUTHY = new Set(['true', 'on', '1', 'yes']);
const FALSY = new Set(['false', 'off', '0', 'no']);

/**
 * @param {Record<string, string|undefined>} env
 * @param {string} name the flag as it appears in the environment
 * @param {{ default?: boolean, warn?: Function|null }} [options]
 * @returns {boolean}
 */
function flag(env, name, { default: fallback = false, warn = console.warn } = {}) {
  const raw = env ? env[name] : undefined;
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;

  const value = String(raw).trim().toLowerCase();
  if (TRUTHY.has(value)) return true;
  if (FALSY.has(value)) return false;

  if (typeof warn === 'function') {
    warn(`[flags] ${name}="${raw}" is not a boolean — using its default (${fallback ? 'on' : 'off'})`);
  }
  return fallback;
}

module.exports = { flag, TRUTHY, FALSY };
