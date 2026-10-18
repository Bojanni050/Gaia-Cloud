'use strict';

/**
 * Memory retraction API — the explicit route the clients' "dit klopt niet"
 * button posts to, so a person can take back something Gaia said from memory
 * without having to talk her into it. The same machinery the in-conversation
 * `retract_memory` tool uses (reasoning/memoryRetraction.js), reached directly
 * instead of through a turn.
 *
 * Why a route and not just the tool: the tool only fires when Gaia decides to
 * call it, which is exactly the judgement that failed when she recited a
 * memory the person then said was untrue. The button is the human's own path
 * and does not depend on her choosing it.
 *
 * Routes (mounted under /memory, Bearer-auth required):
 *   POST /memory/retract  { quote, correction? } -> 200 { status, message, ... }
 *   POST /memory/forget   { quote }              -> 200 { status, message, ... }
 *
 * `quote` is the remembered sentence as it was said — the client sends the
 * text the person pointed at, not a summary. `correction` is optional and, when
 * given, is kept as the true version (`gaia:correction`), so the retraction
 * fills the gap instead of only opening it.
 *
 * `/forget` is the other half: no correction, no verdict on truth. It exists
 * because "take this out of your memory" is not the same request as "this is
 * not true", and a memory can be true and still not belong in recall. Without
 * it, the only route out of the store forced the person's own history to be
 * called a lie.
 *
 * Four outcomes, all 200, all answerable to a person:
 *   { status: 'retracted', message, retracted: {bank,id,text,invalidated},
 *     source, kept }               — taken back, and the derived statement it
 *                                    came from retired when there was one
 *   { status: 'forgotten', message, forgotten: {bank,id,text,invalidated},
 *     source }                     — the same withdrawal with nothing kept
 *   { status: 'ambiguous',   message, candidates } — more than one memory fits;
 *                                    the client shows them and re-posts with
 *                                    the chosen text as the exact `quote`
 *   { status: 'not_found',   message, candidates: [] } — nothing matched closely
 *                                    enough; NOTHING was touched
 *
 * Not an error path: "nothing matched" and "which one?" are answers the person
 * needs to hear, not failures of the request, so they ride on 200 with the
 * receipt wording the tool itself would have spoken. 400 only when the request
 * itself is empty, 503 when no bank is wired to search.
 *
 * `message` is rendered by the same renderers the tools use —
 * one wording, so the button and a spoken retraction never disagree.
 */
const express = require('express');
const {
  retractMemory,
  forgetMemory,
  renderRetractionReceipt,
  renderForgetReceipt,
} = require('./reasoning/memoryRetraction');

/**
 * @param {{
 *   banks?: Array<{ name: string, client: object }>,
 *   home?: { name: string, client: object } | null,
 *   cognition?: object | null,
 *   sync?: object | null,
 *   auth?: import('express').RequestHandler,
 * }} deps
 */
function createMemoryRouter({ banks = [], home = null, cognition = null, sync = null, auth } = {}) {
  const router = express.Router();
  if (auth) router.use(auth);

  router.post('/retract', async (req, res) => {
    const quote = typeof req.body?.quote === 'string'
      ? req.body.quote.replace(/\s+/g, ' ').trim()
      : '';
    if (!quote) {
      return res.status(400).json({ error: 'quote is required' });
    }
    if (!Array.isArray(banks) || banks.length === 0) {
      return res.status(503).json({ error: 'memory retraction is not available' });
    }
    const correction = typeof req.body?.correction === 'string' ? req.body.correction : '';

    // Never throws: every step of a retraction is independently guarded, so a
    // store that is slow or down degrades into a partial answer rather than an
    // error the person cannot act on. The catch is for the module's own
    // surprises, not for a store being unavailable.
    try {
      const receipt = await retractMemory({ banks, home, cognition, sync, quote, correction, now: Date.now() });
      res.json({ ...receipt, message: renderRetractionReceipt(receipt) });
    } catch (_) {
      res.status(500).json({ error: 'could not take that back' });
    }
  });

  router.post('/forget', async (req, res) => {
    const quote = typeof req.body?.quote === 'string'
      ? req.body.quote.replace(/\s+/g, ' ').trim()
      : '';
    if (!quote) {
      return res.status(400).json({ error: 'quote is required' });
    }
    if (!Array.isArray(banks) || banks.length === 0) {
      return res.status(503).json({ error: 'memory forgetting is not available' });
    }

    // Same shape and same guarantees as /retract — the only difference is that
    // no correction is taken and nothing is kept in the memory's place.
    try {
      const receipt = await forgetMemory({ banks, cognition, sync, quote, now: Date.now() });
      res.json({ ...receipt, message: renderForgetReceipt(receipt) });
    } catch (_) {
      res.status(500).json({ error: 'could not forget that' });
    }
  });

  return router;
}

module.exports = { createMemoryRouter };
