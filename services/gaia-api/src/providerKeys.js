'use strict';

// Where a provider's API key may come from besides the admin page.
//
// The admin page stores a key in data/provider-config.json (see providerStore).
// A key can equally live in the environment: services/gaia-api/.env is read by
// docker compose, so a key placed there survives a redeploy and never has to be
// typed into the page again.
//
// The store always wins. A key saved on the page is the person's most recent
// choice; the environment only fills the gap when nothing was saved. Names
// follow <PROVIDER>_API_KEY, and the table below spells out the providers the
// page offers. A provider missing from it still resolves through the generic
// rule, so adding one to the page never needs a change here.
//
// Base URLs work the same way (see baseEnvNameFor / providerBaseFromEnv): the
// page normally stores the base URL, but an operator can leave it in the
// environment instead. Names follow <PROVIDER>_BASE_URL, with the explicit
// table for providers whose deployment chose a different variable name
// (hopscotch's deploy .env spells it HOPSKOTCH_BASE).

const PROVIDER_KEY_ENV = Object.freeze({
  edenai: 'EDENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  deepinfra: 'DEEPINFRA_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  xiaomi: 'XIAOMI_API_KEY',
  alibaba: 'ALIBABA_API_KEY',
  nvidia: 'NVIDIA_API_KEY',
  opencode: 'OPENCODE_API_KEY',
  commandcode: 'COMMANDCODE_API_KEY',
  litellm: 'LITELLM_API_KEY',
  elevenlabs: 'ELEVENLABS_API_KEY',
  fishaudio: 'FISHAUDIO_API_KEY',
  hopscotch: 'HOPSCOTCH_KEY',
});

// Providers whose base URL lives under a variable name that does not follow
// the generic <PROVIDER>_BASE_URL rule. The store wins here too: a base URL
// saved on the page is the person's most recent choice.
const PROVIDER_BASE_ENV = Object.freeze({
  hopscotch: 'HOPSKOTCH_BASE',
});

// The environment variable that would hold this provider's base URL, or ''
// when the provider is not named well enough to guess one.
function baseEnvNameFor(provider) {
  const id = String(provider || '').trim().toLowerCase();
  if (!id) return '';
  if (PROVIDER_BASE_ENV[id]) return PROVIDER_BASE_ENV[id];
  const generic = `${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_BASE_URL`;
  return generic === '_BASE_URL' ? '' : generic;
}

// The base URL the environment offers for this provider, or '' when none is set.
function providerBaseFromEnv(provider, env = process.env) {
  const name = baseEnvNameFor(provider);
  if (!name) return '';
  const value = env && env[name];
  return typeof value === 'string' ? value.trim() : '';
}

// The environment variable that would hold this provider's key, or '' when the
// provider is not named well enough to guess one.
function keyEnvNameFor(provider) {
  const id = String(provider || '').trim().toLowerCase();
  if (!id) return '';
  if (PROVIDER_KEY_ENV[id]) return PROVIDER_KEY_ENV[id];
  const generic = `${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;
  return generic === '_API_KEY' ? '' : generic;
}

// The key the environment offers for this provider, or '' when none is set.
function providerKeyFromEnv(provider, env = process.env) {
  const name = keyEnvNameFor(provider);
  if (!name) return '';
  const value = env && env[name];
  return typeof value === 'string' ? value.trim() : '';
}

module.exports = { PROVIDER_KEY_ENV, PROVIDER_BASE_ENV, keyEnvNameFor, providerKeyFromEnv, baseEnvNameFor, providerBaseFromEnv };
