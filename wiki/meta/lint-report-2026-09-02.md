---
type: meta
title: "Lint Report 2026-09-02"
created: 2026-09-02
updated: 2026-09-02
tags: [meta, lint]
status: developing
---

# Lint Report: 2026-09-02

First full lint pass over the vault. Scope: every file under `wiki/`.

## Summary
- Pages scanned: ~27 (pre-pass)
- Issues found: 19
- Fixed: 19
- Needs author review: 3 (flagged inline, not auto-resolved)

## Fixed

**Dead links (missing pages)**
- `[[Cosmology]]` — referenced by 8+ pages, never created. Added [[Cosmology]] with content drawn from the raw pitch doc's "The World" section.
- `[[The Protagonist]]` — referenced by Timeline, Core Gameplay, and the source pitch page. Added [[The Protagonist]] with the Cede Amare → Cedere → Caedere name arc, pulled from `.raw/Merchant_of_Fate_Pitch.docx`.

**Orphan / empty pages**
- `wiki/world/Characters/Nexus.md` was a completely empty file despite Nexus being a named, recurring character in [[Lore in order]]. Filled with a stub page and cross-links.

**Frontmatter gaps**
- [[Lore in order]], [[Silvia]], [[Sacrarium]] had no frontmatter block at all. Added `type`/`status`/`tags`/`created`/`updated`.

**Stale claims**
- [[Primum]] and [[Nectaris]] both carried a `[!gap]` callout asking "what/who is Vesta?" — stale, since [[Vesta]] is a fully developed page. Removed the callouts, replaced with a normal cross-link.
- [[Ferus]] and [[Timeline of the Aetas]] both flagged a `[!contradiction]` between the clan name "Ferrin" and the character name "Ferus." [[The clans]] (see below) now resolves this in-fiction — softened both callouts to `[!key-insight]` pointing at the new page, and noted it's still worth confirming the reading with the author.

**Missing cross-references**
- [[Anima]] didn't link to [[Sacrarium]] despite being its direct origin (his heart → the orb → the Sacrarium). Added.
- [[Silvia]] didn't link to [[Nexus]] or [[The clans]]. Added, plus a proper See Also section.
- [[Sacrarium]] had no See Also section at all. Added.

**Structural**
- `wiki/world/Charaters/` (typo) renamed to `wiki/world/Characters/`. Filenames unchanged, so no wikilinks broke.
- Retired three superseded lore drafts — `Aetas of creation.md`, `Maiden of fog.md`, `The Aetas of Humanity.md` — now fully covered, cleaned up, and told in order by [[Lore in order]]. Confirmed with the author before deleting; recoverable from git history if ever needed.

**Missing indexes**
- Added `_index.md` for every folder that lacked one: `characters/`, `characters/Lore/`, `concepts/`, `gameplay/`, `timeline/`, `world/`, `world/Characters/`.
- Added `wiki/index.md` as the top-level, plain-markdown entry point (distinct from `wiki/overview.md`, which stays a visual Excalidraw board per the author's preference).

**Content trapped in Excalidraw canvases**
- Four files (`wiki/overview.md`, `wiki/world/The clans.md`, `wiki/characters/Aequor (Ingame).md`, `wiki/characters/Cedere.md`) are Excalidraw drawings saved under page-like names. Per the author's direction, these stayed as Excalidraw (not converted to plain markdown) and were extended in place:
  - **overview.md** — added a Cosmology / Timeline / The clans branch off the existing "Lore" node, a Relics / Nectaris branch off "Gameplay," and a The Protagonist branch off "Charaters," plus a note explaining the in-game-vs-lore folder split.
  - **The clans.md** — built out a full extended family tree for all 16 clans (founder generation + two children each, with a third generation for the three clans tied to existing canon characters — see below), Latin-rooted names in the same style as the existing cast, each person with a one-line role and wikilinks where they connect to real pages. Every original brainstorm bubble now has an arrow into its structured tree.
  - **Aequor (Ingame).md** — linked to the lore deity [[Aequor]] and [[Cosmology]], plus an honest note that its in-game role (relic, ability, patron era) is still undeveloped.
  - **Cedere.md** — added the Cede Amare → Cedere → Caedere name-arc diagram, linked to the new [[The Protagonist]] page for full detail.

## The clans: family tree design notes

Three clans got a third generation because they tie directly into existing canon rather than being invented from scratch:
- **Ferrin** — founder is [[Ferus]] himself; resolves the Ferrin/Ferus naming question in-fiction (see above).
- **Silvanus** — founder is [[Silvia]]; the tree follows the [[Sacrarium]]'s mother-to-daughter inheritance rule into a granddaughter, "carries the Sacrarium into the Current Era."
- **Nexin** — founder is [[Nexus]]; a grandchild still carries his unexplained teal-eyed resemblance to [[Aequor]].

The other 13 founders (Leorin, Atlan, Animus, Cerin, Serane, Regulus, Cassian, Octin, Valerin, Vitalis, Lucin, Natalin, Aurelin) are new names invented for this pass, each rooted in an actual Latin word matching the existing naming convention (Primum, Vesta, Tellus, Aequor, Anima, Silvia are all direct Latin nouns repurposed as names) and given a role that ties back into the Timeline where a natural hook existed (Atlan → Aetas of Atlan explorers, Cassian → Aetas of War, Regulus/Serane → Aetas of Peace and city-building, Vitalis/Natalin → Sacrarium stewardship, Aurelin → the game's gold/merchant motif).

> [!gap] These 13 founders and their children are new inventions, not drawn from any source document
> Flagging clearly so they don't get mistaken for pre-existing canon later. Fine to treat as placeholder color to be overwritten, or to keep as-is — that's an author call.

## Needs author review (not auto-resolved)
- **Ferrin vs. Ferus**: now resolved in-fiction via [[The clans]], but still worth an explicit confirmation that this is the intended reading and not a leftover spelling inconsistency in the source pitch.
- **Aequor (the god)**: still has no confirmed gift, relic, or era of worship anywhere in the source material (see the `[!gap]` on [[Aequor]] itself) — pre-existing gap, not introduced by this pass.
- **The Protagonist's name-arc triggers**: what actually moves the player between Cede Amare / Cedere / Caedere (run count? specific choices? story beats?) is undefined — flagged as a `[!gap]` on the new [[The Protagonist]] page.

## Address Validation
Not applicable — this vault has not adopted DragonScale addressing (no `scripts/allocate-address.sh`, no `.vault-meta/address-counter.txt`).

## Semantic Tiling
Not run — no local ollama / `nomic-embed-text` detected in this environment.
