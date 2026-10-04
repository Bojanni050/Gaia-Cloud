'use strict';

/**
 * Cognition client — Gaia-Cloud's thin REST client to the Cognition service
 * (services/cognition): the store of DERIVED knowledge (hypotheses, patterns,
 * candidate mental models / relationships) with its lifecycle.
 *
 * This client only reads and writes records; it never reasons and never
 * touches Hindsight. The Cognition → Hindsight mirror lives in
 * cognitionSync.js.
 *
 * Config: COGNITION_URL (default http://100.65.0.15:8890) and
 * COGNITION_BANK_ID (default 'gaia'). Cognition is Tailscale-bound and
 * unauthenticated, like Hindsight.
 */

const DEFAULT_BASE_URL = 'http://100.65.0.15:8890';
const DEFAULT_BANK_ID = 'gaia';
const DEFAULT_TIMEOUT_MS = 8000;

function readCognitionConfig(env = process.env) {
  return {
    baseUrl: String(env.COGNITION_URL || DEFAULT_BASE_URL).trim(),
    bankId: String(env.COGNITION_BANK_ID || DEFAULT_BANK_ID).trim(),
    timeoutMs: Number(env.COGNITION_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
  };
}

/**
 * @param {{ baseUrl?: string, bankId?: string, fetchImpl?: Function, timeoutMs?: number }} [options]
 */
function createCognitionClient({
  baseUrl = DEFAULT_BASE_URL, bankId = DEFAULT_BANK_ID, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const root = String(baseUrl).replace(/\/+$/, '');
  const bank = String(bankId);
  const base = `${root}/v1/banks/${encodeURIComponent(bank)}`;

  async function request(method, path, body) {
    let response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method,
        headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // Never leak host/stack upstream; the caller logs the calm message.
      throw new Error(`cognition ${method} ${path} unreachable`);
    }
    if (response.status === 404) {
      const err = new Error(`cognition ${method} ${path} not found`);
      err.status = 404;
      throw err;
    }
    if (!response.ok) {
      const err = new Error(`cognition ${method} ${path} responded ${response.status}`);
      err.status = response.status;
      throw err;
    }
    if (response.status === 204) return null;
    return response.json();
  }

  // --- Hypotheses / derived statements ---
  const listHypotheses = (query = {}) => {
    const params = new URLSearchParams();
    if (query.status) params.set('status', query.status);
    if (query.kind) params.set('kind', query.kind);
    const suffix = params.toString() ? `?${params}` : '';
    return request('GET', `/hypotheses${suffix}`).then((r) => (r && r.hypotheses) || []);
  };
  const getHypothesis = (id) => request('GET', `/hypotheses/${encodeURIComponent(id)}`);
  const proposeHypothesis = (record) => request('POST', '/hypotheses', record);
  const updateHypothesis = (id, patch) => request('PATCH', `/hypotheses/${encodeURIComponent(id)}`, patch);
  const markTesting = (id) => request('POST', `/hypotheses/${encodeURIComponent(id)}/test`);
  const applyEvidence = (id, { relation, evidenceId, confidenceDelta, rationale } = {}) => request('POST', `/hypotheses/${encodeURIComponent(id)}/evidence`, {
    relation,
    ...(evidenceId !== undefined ? { evidence_id: evidenceId } : {}),
    ...(confidenceDelta !== undefined ? { confidence_delta: confidenceDelta } : {}),
    ...(rationale !== undefined ? { rationale } : {}),
  });
  const markCorroborated = (id) => request('POST', `/hypotheses/${encodeURIComponent(id)}/corroborate`);
  const confirmHypothesis = (id, { statement } = {}) => request(
    'POST',
    `/hypotheses/${encodeURIComponent(id)}/confirm`,
    (typeof statement === 'string' && statement.trim()) ? { statement: statement.trim() } : undefined,
  );
  const rejectHypothesis = (id, { reason, verwerpBron } = {}) => request('POST', `/hypotheses/${encodeURIComponent(id)}/reject`, {
    ...(reason !== undefined ? { reason } : {}),
    ...(verwerpBron !== undefined ? { verwerp_bron: verwerpBron } : {}),
  });
  const supersedeHypothesis = (id, { supersededById, reason } = {}) => request('POST', `/hypotheses/${encodeURIComponent(id)}/supersede`, {
    superseded_by_id: supersededById,
    ...(reason !== undefined ? { reason } : {}),
  });

  // --- Patterns ---
  const listPatterns = () => request('GET', '/patterns').then((r) => (r && r.patterns) || []);
  const getPattern = (id) => request('GET', `/patterns/${encodeURIComponent(id)}`);
  const createPattern = (record) => request('POST', '/patterns', record);
  const updatePattern = (id, patch) => request('PATCH', `/patterns/${encodeURIComponent(id)}`, patch);

  return {
    bankId: bank,
    listHypotheses,
    getHypothesis,
    proposeHypothesis,
    updateHypothesis,
    markTesting,
    applyEvidence,
    markCorroborated,
    confirmHypothesis,
    rejectHypothesis,
    supersedeHypothesis,
    listPatterns,
    getPattern,
    createPattern,
    updatePattern,
  };
}

function createFromEnv(env = process.env) {
  const config = readCognitionConfig(env);
  return createCognitionClient(config);
}

module.exports = { readCognitionConfig, createCognitionClient, createFromEnv };
