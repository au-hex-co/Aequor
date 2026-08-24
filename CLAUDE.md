# Aequor: LLM Wiki

Mode: F (Book/Course), adapted for a game design bible
Purpose: Game design wiki for Merchant of Fate — world lore, timeline, characters, gameplay systems, relics.
Owner: luckytilakrao@gmail.com
Created: 2026-08-24

## Structure

```
Aequor/
├── .raw/            # immutable source documents (pitch doc, draft notes)
├── wiki/
│   ├── index.md     # master catalog
│   ├── log.md       # chronological record, newest entries at top
│   ├── hot.md       # ~500-word recent-context cache
│   ├── overview.md  # executive summary
│   ├── sources/     # one summary page per raw source
│   ├── world/       # gods, cosmology, peoples (Tellus, Anima, Aequor, Primum, Ferus)
│   ├── timeline/     # the Aetas
│   ├── characters/   # the protagonist's name arc
│   ├── gameplay/     # core systems
│   ├── concepts/     # relics and design philosophy
│   └── meta/         # dashboards, lint reports
└── CLAUDE.md
```

## Conventions

- All notes use YAML frontmatter: type, status, created, updated, tags (minimum).
- Wikilinks use `[[Note Name]]` format: filenames are unique, no paths needed.
- `.raw/` contains source documents: never modify them.
- `wiki/index.md` is the master catalog: update on every ingest.
- `wiki/log.md` is append-only: never edit past entries, new entries go at the TOP.
- `wiki/hot.md` is overwritten completely each session, not appended to.
- Use the custom callouts (`[!gap]`, `[!contradiction]`, `[!key-insight]`, `[!stale]`) to flag open questions instead of silently guessing. See a rendered example in [[Cosmology]] or [[Nectaris]].

## Operations

- Ingest: drop a source in `.raw/`, say "ingest [filename]"
- Query: ask any question — Claude reads `hot.md` then `index.md` first, then drills in
- Lint: say "lint the wiki" to run a health check
- Save: say "save this" to file a new insight or answer as a wiki page
