/**
 * Thin client back to the real Hindsight instance — used only for the
 * "confirm a hypothesis" step, which retains the confirmed statement as a
 * real Hindsight memory (architecture.md §6.1: confirmed hypotheses promote
 * into facts through the normal memory-policy path).
 */
const HINDSIGHT_URL = (process.env.HINDSIGHT_URL || 'http://100.65.0.15:8888').replace(/\/+$/, '');

/**
 * Retains one item into Hindsight. Hindsight's retain response never
 * includes the created memory unit's ID — sync or async, it only reports
 * success/counts (confirmed against the live OpenAPI schema). The only
 * durable handle we get back is the document_id we set ourselves, which
 * is queryable later via Hindsight's /documents/{document_id} endpoints.
 */
async function retainMemory(bankId, item) {
  const res = await fetch(`${HINDSIGHT_URL}/v1/default/banks/${bankId}/memories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ async: true, items: [item] }),
  });
  if (!res.ok) {
    throw new Error(`hindsight retain failed: ${res.status}`);
  }
  await res.json();
  return { documentId: item.document_id };
}

module.exports = { retainMemory };
