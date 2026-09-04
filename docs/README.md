---
title: Gaia — Foundation Index
document: index
version: 1.0.0
status: foundation
last_updated: 2026-06-01
owner: Gaia Product Foundation
framing: "Gaia is a lifelong personal intelligence designed to grow through understanding."
---

# Gaia — Foundation Documents

> **Gaia is a lifelong personal intelligence designed to grow through understanding.**

This is the long-term foundation for Gaia. Every document reinforces the same product philosophy: Gaia is the agency, not a shell around any one capability, and she preserves a clean separation between **identity, cognition, memory, capability, and experience**. When any decision is unclear, defer to `vision.md`.

## The Documents

| # | Document | Defines |
|---|----------|---------|
| 1 | [vision.md](./vision.md) | What/why/who Gaia is, philosophy, values, success criteria, what she must never become |
| 2 | [architecture.md](./architecture.md) | System boundaries (SOUL · Logos · Hindsight · Capabilities [Hermes, Melodiq, SongCompanion, MCP, …] · Gaia Desktop), flows, streaming lifecycle, storage abstraction, model agnosticism |
| 3 | [design-language.md](./design-language.md) | How Gaia feels daily; visual, spatial, motion, and communication philosophy |
| 4 | [personality.md](./personality.md) | Gaia as a person-like presence; style, initiative, boundaries, trust, consistency |
| 5 | [roadmap.md](./roadmap.md) | V1→V3→Long-term, MoSCoW, intentionally small V1, maturity path |
| 6 | [coding-standards.md](./coding-standards.md) | Structure, contracts, state, testing, dependency governance, maintainability |
| 7 | [ui-principles.md](./ui-principles.md) | Conversation-first, calm, silence, motion-as-meaning, legible growth |
| 8 | [split-plan.md](./split-plan.md) | Boundaries between Gaia Cloud / Web / Desktop in the current monorepo and the phased plan to split them into three independent repositories |
| 9 | [operations.md](./operations.md) | *(not a foundation document — a living reference)* Where things actually run: the admin interface, deployment addresses, how to reach each service |

## Gaia's Structure

- **Gaia** → the agency herself — acts, decides, maintains continuity. **Runs in Gaia Cloud.**
- **SOUL** → Identity  ·  **Logos** → Cognition (`intentIQ` + `reasonIQ`, Gaia's own reasoning faculty)  ·  **Hindsight** → Memory, load-bearing for continuity, never optional
- **Capabilities** → optional instruments Gaia reaches for when they serve her goals — Hermes (reasoning), Melodiq (music), SongCompanion (song work), MCP (actions), and others  ·  **Gaia Desktop** → Experience, and her first **client**

These remain separate over time. No system absorbs another's role. No capability — Hermes included — is a default; Gaia decides, turn by turn, whether one is needed at all. No client — Gaia Desktop included — hosts Gaia; every client reaches her over the Gaia API. Clients are representations of Gaia, never instances of her.

## Resolved Open Questions (stances documented)

- **Where does Gaia run?** → Gaia Cloud, from V1 — not a desktop-hosted brain (architecture §2, "Deployment Topology").
- **Offline-first?** → Network-dependent initially with an offline-graceful shell (architecture §11).
- **Memory provenance visibility?** → Always available on demand, never omnipresent (architecture §8, ui-principles §9).
- **Proactivity level?** → Earned, tiered, reversible; ceiling is "never noisy" (personality §2, roadmap §8).
- **Personality variability?** → Stable core, subtle contextual expression (personality §10).
- **Infrastructure beyond Gaia Cloud?** → Only on a proven need the baseline Gaia Cloud runtime cannot own (architecture §9).
