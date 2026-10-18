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
  litellm: 'LITELLM_API_KEY',
  elevenlabs: 'ELEVENLABS_API_KEY',
  fishaudio: 'FISHAUDIO_API_KEY',
});

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

module.exports = { PROVIDER_KEY_ENV, keyEnvNameFor, providerKeyFromEnv };
