# foundation ingestion — what does not happen

| Wat níet gebeurt | Waarom |
| --- | --- |
| Nooit automatisch tot feit/hypothesis gepromoveerd | Absolute Override — alleen menselijke validatie (`POST /cognition/hypotheses/:id/confirm`) schrijft `confirmed` |
| Foundation schrijft niks naar Hindsight | De jobs (reflection, promotion, sync) zijn verhuisd naar Logos; het is nu een pure opslag + ingest-gateway ("de stekkerdoos") |
| Naar Hindsight gaan afgeleide records via Cognition, niet rauwe captures | Cognition is de bron van afgeleide kennis; de sync (`cognitionSync`) mirror't die naar Hindsight onder `gaia:*` |
| Geen automatisch kenmerk/persona-extractie uit episodes | `persona_kenmerk`-pad (insight/) zit aan de client/Chronicle-kant, niet achter de gateway |
| Observations blijven in Foundation (rauw) | Ze zijn de ongewijzigde bron; afgeleide duiding hoort in Cognition |
