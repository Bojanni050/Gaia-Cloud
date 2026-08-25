'use strict';

/**
 * Memoryworthiness 0.1 evaluation dataset — deterministic, model-free.
 *
 * ~50 cases across the spec §18 categories. `expected` is the action a
 * careful human labeler would assign given ONLY the user turn plus the
 * listed existingMemorySignals. Borderline durable-but-modest cases are
 * labeled retain_low_priority rather than forced into a binary.
 *
 * Categories: greeting · acknowledgement · filler · explicit memory request
 * · preference · correction · personal fact · project decision · future
 * goal · temporary context · duplicate · new information · contradiction.
 */

const mem = (text) => ({ recalledReflections: [{ text }] });

const CASES = [
  // --- greeting (discard) ---
  { id: 'gr-01', category: 'greeting', input: 'Hoi Gaia', expected: 'discard' },
  { id: 'gr-02', category: 'greeting', input: 'Goedemorgen!', expected: 'discard' },
  { id: 'gr-03', category: 'greeting', input: 'Hey', expected: 'discard' },
  { id: 'gr-04', category: 'greeting', input: 'Hoi hoi, ben er weer', expected: 'discard' },

  // --- acknowledgement (discard) ---
  { id: 'ak-01', category: 'acknowledgement', input: 'Oké', expected: 'discard' },
  { id: 'ak-02', category: 'acknowledgement', input: 'Ja precies.', expected: 'discard' },
  { id: 'ak-03', category: 'acknowledgement', input: 'prima hoor', expected: 'discard' },
  { id: 'ak-04', category: 'acknowledgement', input: 'Ja dat klopt helemaal precies zo', expected: 'discard' },
  { id: 'ak-05', category: 'acknowledgement', input: 'Duidelijk, thanks!', expected: 'discard' },

  // --- filler / reaction (discard) ---
  { id: 'fi-01', category: 'filler', input: 'haha mooi gedaan', expected: 'discard' },
  { id: 'fi-02', category: 'filler', input: 'Lol oké dan', expected: 'discard' },
  { id: 'fi-03', category: 'filler', input: 'hmm interesting', expected: 'discard' },

  // --- explicit memory request (retain) ---
  { id: 'mr-01', category: 'explicit memory request', input: 'Onthoud dat ik maandag altijd laat werk.', expected: 'retain' },
  { id: 'mr-02', category: 'explicit memory request', input: 'Bewaar dit even: mijn klant heet Dura Vermeer.', expected: 'retain' },
  { id: 'mr-03', category: 'explicit memory request', input: 'Vanaf nu plan ik alles in Notion.', expected: 'retain' },
  { id: 'mr-04', category: 'explicit memory request', input: 'Vergeet mijn oude telefoonnummer maar.', expected: 'retain' },

  // --- preference (retain) ---
  { id: 'pf-01', category: 'preference', input: 'Ik wil voortaan korte antwoorden.', expected: 'retain' },
  { id: 'pf-02', category: 'preference', input: 'Ik heb liever dat je direct to the point komt.', expected: 'retain' },
  { id: 'pf-03', category: 'preference', input: 'Ik prefereer Nederlandse antwoorden boven Engelse.', expected: 'retain' },

  // --- correction (retain) ---
  { id: 'co-01', category: 'correction', input: 'Nee, dat klopt niet meer.', expected: 'retain' },
  { id: 'co-02', category: 'correction', input: 'Eigenlijk werk ik tegenwoordig in Amsterdam.', expected: 'retain' },
  { id: 'co-03', category: 'correction', input: 'Dat is fout, ik gebruik al lang geen Slack meer.', expected: 'retain' },

  // --- personal fact (retain) ---
  { id: 'pe-01', category: 'personal fact', input: 'Ik verhuis volgende maand.', expected: 'retain' },
  { id: 'pe-02', category: 'personal fact', input: 'Mijn dochter gaat in september naar de basisschool.', expected: 'retain' },
  { id: 'pe-03', category: 'personal fact', input: 'Ik ben sinds vandaag weer fulltime met Gaia bezig.', expected: 'retain' },
  { id: 'pe-04', category: 'personal fact', input: 'Ik woon nu in Den Bosch.', expected: 'retain' },

  // --- project decision (retain) ---
  { id: 'pd-01', category: 'project decision', input: 'We gaan voor Postgres in plaats van Mongo, definitief.', expected: 'retain' },
  { id: 'pd-02', category: 'project decision', input: 'Besloten: de deploy loopt vanaf nu via GitHub Actions.', expected: 'retain' },
  { id: 'pd-03', category: 'project decision', input: 'Er is een vaste afspraak: code review vóór elke merge.', expected: 'retain' },

  // --- future goal (retain) ---
  { id: 'fg-01', category: 'future goal', input: 'Mijn doel is eind Q3 live te gaan met Melodiq.', expected: 'retain' },
  { id: 'fg-02', category: 'future goal', input: 'Volgende maand ga ik beginnen met de mixage van het album.', expected: 'retain' },
  { id: 'fg-03', category: 'future goal', input: 'Ik ben van plan om dit jaar een tweede service toe te voegen.', expected: 'retain' },

  // --- temporary context (discard / low) ---
  { id: 'tc-01', category: 'temporary context', input: 'Ik ben even koffie halen.', expected: 'discard' },
  { id: 'tc-02', category: 'temporary context', input: 'Oké, ik ga koffie halen.', expected: 'discard' },
  { id: 'tc-03', category: 'temporary context', input: 'Momenteel even wat anders aan het doen, zo terug.', expected: 'discard' },
  { id: 'tc-04', category: 'temporary context', input: 'Ik pak er zo weer even bij.', expected: 'discard' },

  // --- duplicate (low priority / discard) ---
  { id: 'du-01', category: 'duplicate', input: 'Ik wil graag korte antwoorden.', existing: mem('Bo wil graag korte antwoorden'), expected: 'retain_low_priority' },
  { id: 'du-02', category: 'duplicate', input: 'ik werk aan melodiq', existing: mem('Bo werkt aan zijn Melodiq muziekproject in de avonduren'), expected: 'retain_low_priority' },
  { id: 'du-03', category: 'duplicate', input: 'Ik woon in Utrecht hoor.', existing: mem('Bo woont in Utrecht'), expected: 'retain_low_priority' },
  { id: 'du-04', category: 'duplicate', input: 'Zoals gezegd: ik werk het liefst savonds.', existing: mem('Bo werkt het liefst savonds aan creatieve projecten'), expected: 'retain_low_priority' },

  // --- new information on known topic (retain / low) ---
  { id: 'ni-01', category: 'new information', input: 'Vanaf deze week heb ik een vaste studio voor mijn Melodiq werk, elke dinsdag.', existing: mem('Bo werkt in de avonden aan Melodiq'), expected: 'retain' },
  { id: 'ni-02', category: 'new information', input: 'Mijn project heeft sinds gisteren een eigen VPS.', existing: mem('Bo werkt aan zijn Melodiq muziekproject'), expected: 'retain' },
  { id: 'ni-03', category: 'new information', input: 'Voor mijn werk ben ik nu ook verantwoordelijk voor het onboarding-proces.', existing: mem('Bo werkt fulltime als developer'), expected: 'retain' },

  // --- contradiction of existing memory (retain) ---
  { id: 'ct-01', category: 'contradiction', input: 'Eigenlijk wil ik juist uitgebreidere antwoorden.', existing: mem('Bo wil graag korte antwoorden'), expected: 'retain' },
  { id: 'ct-02', category: 'contradiction', input: 'Ik woon niet meer in Utrecht hoor, ik ben verhuisd.', existing: mem('Bo woont in Utrecht'), expected: 'retain' },

  // --- borderline conversational substance (low / discard) ---
  { id: 'bc-01', category: 'temporary context', input: 'Wat is de hoofdstad van Bolivia?', expected: 'discard' },
  { id: 'bc-02', category: 'acknowledgement', input: 'Kun je dat nog iets uitleggen?', expected: 'discard' },
  { id: 'bc-03', category: 'filler', input: 'De tests draaien allemaal weer groen na de refactor van vannacht.', expected: 'discard' },
  { id: 'bc-04', category: 'project decision', input: 'We besluiten de API op versie 2 te houden, er is geen budget voor meer.', expected: 'retain' },
];

module.exports = { CASES };
