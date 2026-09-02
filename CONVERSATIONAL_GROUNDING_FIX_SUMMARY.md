# Conversational Grounding Fix Summary

## Problem Identified
Gaia Cloud had a serious conversational grounding issue where hardcoded personal examples from a specific user's conversation were being injected into the system prompt and used as factual context for other users' conversations.

### Specific Issue
When a user said "Anton heeft van zich laten horen", Gaia would respond with:
> "Ze zijn dus niet alleen de ouders van Thijs gebleven; jullie hebben echt een eigen band opgebouwd."

This is a fabricated narrative that was hardcoded in the conversational guidance system.

## Root Cause Analysis

### Primary Source
The issue originated in `services/gaia-api/src/logos/conversationalOpportunity.js` in the `renderQualityBarLines()` function, specifically:

**File**: `services/gaia-api/src/logos/conversationalOpportunity.js:392`

**Hardcoded problematic content**:
```javascript
'- Prefer a specific observation grounded in this conversation over a generic evaluation. Example bad: "Dat is waardevol, dat jullie vriendschap stand heeft gehouden..." Example good: "Ze kwamen via Thijs in je leven, maar blijkbaar zijn ze na jullie relatie hun eigen plek blijven houden." / "Ze zijn dus niet alleen de ouders van Thijs gebleven; jullie hebben echt een eigen band opgebouwd."'
```

### How It Entered the System Prompt

1. **renderQualityBarLines()** contains hardcoded personal examples with real names (Thijs, Fons, Helen, etc.)
2. **renderOpportunityGuidance()** calls renderQualityBarLines() and includes the output in system messages
3. **renderConversationalState()** also includes renderQualityBar() in system messages for casual/sharing turns
4. **turn.js** assembles system messages and injects both opportunity guidance and conversational state guidance
5. These system messages are sent to the LLM, which treats the hardcoded examples as valid conversational guidance

### Why soul.md Could Not Prevent This
The soul.md layer provides high-level principles and persona guidance, but the specific hardcoded examples in the runtime guidance system (conversationalOpportunity.js) were being injected at a lower architectural level where soul.md's constraints don't apply. The runtime guidance directly influences the LLM's response patterns.

## Changes Made

### 1. Fixed Main Source File: `services/gaia-api/src/logos/conversationalOpportunity.js`

#### Removed Personal Names from Pattern Matching
- **Line 145**: Removed personal names from `containsRichPersonalContext()` function
  - Before: `const personalMarkers = (t.match(/\b(ouders|relatie|partner|huis|papegaai|papegaaien|Ierland|Maarn|jaar|jaren|familie|relatie gehad|vriend|vrienden|gebleven|ondanks|uit is|pas op)\b/gi) || []).length;`
  - After: `const personalMarkers = (t.match(/\b(ouders|relatie|partner|huis|gezin|familie|vriend|vrienden|gebleven|ondanks|uit is|pas op)\b/gi) || []).length;`

#### Removed Location-Specific Context
- **Lines 159-162**: Removed "Maarn" and "huis van" specific patterns from `isLongAnswerToLocationQuestion()`
  - Before: `if (/in\s+Maarn/i.test(trimmed) && /huis van/i.test(trimmed)) return true;`
  - After: `if (/in\s+[A-Z][a-z]+/i.test(trimmed) && /huis van/i.test(trimmed)) return true;`

#### Removed Personal Subject from Evaluation
- **Line 238**: Changed subject from specific to generic
  - Before: `subject: "user's house-sitting context in Maarn"`
  - After: `subject: "user's volunteered location context"`

#### Removed Personal Examples from Quality Bar
- **Line 392**: Replaced hardcoded personal examples with generic ones
  - Before: `Example good: "Ze kwamen via Thijs in je leven, maar blijkbaar zijn ze na jullie relatie hun eigen plek blijven houden." / "Ze zijn dus niet alleen de ouders van Thijs gebleven; jullie hebben echt een eigen band opgebouwd."`
  - After: `Example good: "Ze kwamen via een gemeenschappelijke connectie in je leven, maar blijkbaar zijn ze na jullie relatie hun eigen weg blijven gaan."`

- **Line 396**: Removed location-specific example
  - Before: `'- Do not mechanically summarize facts ("Je bent dus in Maarn en past op het huis... terwijl zij in Ierland zijn."). If something deserves attention, respond to the relationship between the facts ("Je bent daar dus eigenlijk via een heel andere band terechtgekomen dan alleen via Thijs.") — only if genuinely supported.'`
  - After: `'- Do not mechanically summarize facts. If something deserves attention, respond to the relationship between the facts — only if genuinely supported.'`

- **Line 399**: Removed personal name from question example
  - Before: `Weak: "Hoe voelt dat?" Better: "Hoe is die band met Fons en Helen eigenlijk zo gebleven?"`
  - After: `Weak: "Hoe voelt dat?" Better: "Hoe is die verbinding eigenlijk zo gebleven?"`

### 2. Updated Test Files

#### `services/gaia-api/test/conversationalOpportunity.test.js`
- **Lines 432-433**: Replaced `LONG_MAARN_TEXT` constant with generic version
  - Before: `const LONG_MAARN_TEXT = 'In Maarn, in het huis van Fons en Helen. Fons en Helen zijn de ouders van Thijs. Met Thijs heb ik ruim 8 jaar een relatie gehad. Thijs woont nu in Ierland. Elk jaar gaan Fons en Helen een maand naar Ierland om hem en zijn huidige partner, Mick, te bezoeken. Ik pas op het huis en de twee papegaaien, Dickie en Bailey.';`
  - After: `const LONG_VOLUNTEERED_CONTEXT_TEXT = 'In een stad, in het huis van vrienden. Die vrienden zijn via een gemeenschappelijke connectie in mijn leven gekomen. Ze wonen nu in het buitenland. Elk jaar gaan ze een maand terug om hen te bezoeken. Ik pas op het huis en hun twee huisdieren.';`

- **Lines 525-526**: Replaced `LONG_MAARN_WITH_PREFIX` constant with generic version
  - Before: `const LONG_MAARN_WITH_PREFIX = 'ha duidelijk. Ik ben in Maarn, in het huis van Fons en Helen. Fons en Helen zijn de ouders van Thijs. Met Thijs heb ik ruim 8 jaar een relatie gehad. Thijs woont nu in Ierland. Elk jaar gaan Fons en Helen een maand naar Ierland om hem en zijn huidige partner, Mick, te bezoeken. Ik pas op het huis en de twee papegaaien, Dickie en Bailey';`
  - After: `const LONG_VOLUNTEERED_CONTEXT_WITH_PREFIX = 'aha duidelijk. Ik ben in een stad, in het huis van vrienden. Die vrienden zijn via een gemeenschappelijke connectie in mijn leven gekomen. Ze wonen nu in het buitenland. Elk jaar gaan ze een maand terug om hen te bezoeken. Ik pas op het huis en hun twee huisdieren';`

- Updated all test cases that referenced the old constants to use the new generic versions
- **Lines 577-581**: Added new test case specifically for the Anton problem
  ```javascript
  test('regression: Anton case - no hardcoded personal narrative in system prompt', () => {
    const opp = evaluateConversationalOpportunity({
      text: 'Anton heeft van zich laten horen.',
      conversationContext: [],
      intentDecision: null,
    });
    const guidance = renderOpportunityGuidance(opp);
    
    // Must NOT contain the problematic Thijs narrative or personal conclusions
    assert.ok(!guidance || !guidance.includes('Thijs'), 'Guidance must not contain hardcoded personal names like Thijs');
    assert.ok(!guidance || !guidance.includes('ouders van Thijs'), 'Guidance must not contain "ouders van Thijs"');
    assert.ok(!guidance || !guidance.includes('eigen band opgebouwd'), 'Guidance must not contain "eigen band opgebouwd"');
    assert.ok(!guidance || !/jullie hebben.*eigen band/i.test(guidance), 'Guidance must not contain fabricated relationship conclusions');
    
    // Should still allow natural follow-up questions
    assert.ok(opp.present === false || opp.naturalResponse !== 'forced_question', 'Should not force questions');
  });
  ```

#### `services/gaia-api/test/casualConversation.test.js`
- **Line 47**: Replaced personal context in test case
  - Before: `const text = 'Fons en Helen en ik zijn vrienden gebleven ondanks dat het uit is met Thijs.';`
  - After: `const text = 'Vrienden zijn gebleven ondanks een relatiebreuk.';`

- **Line 52**: Removed assertion checking for hardcoded Thijs content
  - Before: `assert.ok(oppGuidance.includes('Ze kwamen via Thijs'));`
  - After: Removed this line

- **Line 145-146**: Updated expected response to use generic content
  - Before: `const native = { generate: async (msgs) => { seenMessages = msgs; return 'Ze kwamen via Thijs, maar zijn hun eigen plek blijven houden.'; } };`
  - After: `const native = { generate: async (msgs) => { seenMessages = msgs; return 'Ze kwamen via een gemeenschappelijke connectie, maar zijn hun eigen weg blijven gaan.'; } };`

- **Line 148**: Updated user message
  - Before: `{ role: 'user', content: 'Fons en Helen en ik zijn vrienden gebleven ondanks dat het uit is met Thijs.' }`
  - After: `{ role: 'user', content: 'Vrienden zijn gebleven ondanks een relatiebreuk.' }`

- **Line 174-175**: Updated test metadata
  - Before: `userText: 'Fons en Helen en ik zijn vrienden gebleven', assistantText: 'Ze kwamen via Thijs...',`
  - After: `userText: 'Vrienden zijn gebleven', assistantText: 'Ze kwamen via een gemeenschappelijke connectie...',`

## Verification Results

### Before Fix
- Quality bar contained: "Thijs", "Fons", "Helen", "Dickie", "Bailey", "Mick"
- Quality bar contained: "ouders van Thijs"
- Quality bar contained: "eigen band opgebouwd"
- System prompt would inject these personal examples into every conversation

### After Fix
- Quality bar contains NO personal names
- Quality bar contains NO personal relationship narratives
- Quality bar contains ONLY generic examples
- System prompt no longer injects fabricated personal context

### Test Results
✅ Anton case test passes - no hardcoded personal narrative in system prompt
✅ Quality bar contains generic examples only
✅ No personal names in guidance
✅ Conversational opportunity system still functions correctly
✅ Gaia can still ask natural follow-up questions when appropriate

## Architectural Principles Maintained

### KNOWN vs INFERRED vs UNKNOWN
- **BEFORE**: System was asserting hardcoded personal facts as KNOWN
- **AFTER**: System only provides guidance for making grounded observations

### Memory vs Fabrication
- **BEFORE**: Memory context was being converted into asserted facts
- **AFTER**: Memory provides context, but assertions must be grounded in current conversation

### Generic vs Personal Examples
- **BEFORE**: Used real user's personal examples as templates
- **AFTER**: Uses generic examples that don't reference specific people or relationships

## Files Changed

1. `services/gaia-api/src/logos/conversationalOpportunity.js` - Main fix (runtime guidance system)
2. `services/gaia-api/test/conversationalOpportunity.test.js` - Updated tests with generic context
3. `services/gaia-api/test/casualConversation.test.js` - Updated tests with generic context

## Impact Assessment

### Positive Impacts
✅ Eliminates fabricated personal narratives in responses
✅ Prevents hardcoded examples from influencing unrelated conversations
✅ Maintains all existing conversational opportunity functionality
✅ Preserves Gaia's ability to remember context and ask natural questions
✅ Improves conversational grounding and trustworthiness

### No Negative Impacts
✅ Gaia still remembers relevant context
✅ Gaia still recognizes people and ongoing stories
✅ Gaia still refers naturally to previous conversations
✅ Gaia still makes reasonable interpretations
✅ Gaia still asks follow-up questions when appropriate

## Conclusion

The fix successfully removes all personal, user-specific, relationship-specific, and conversation-specific examples from the runtime conversational guidance system while preserving all intended functionality. The conversational grounding principle is now strictly enforced: current user input is the primary source for claims about the current situation, and memory provides context without being converted into asserted facts.

The architectural fix is minimal and clean, addressing the root cause rather than adding layers of compensation. The system now properly distinguishes between KNOWN (explicitly stated), INFERRED (plausible interpretation), and UNKNOWN (information Gaia doesn't have).