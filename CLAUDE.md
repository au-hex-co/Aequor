# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

An Obsidian vault (`wiki/`, `world/`) for **Aequor**, a mythology-driven pirate roguelike, plus a zero-dependency static site generator (`site/`) that publishes that vault to GitHub Pages at https://au-hex-co.github.io/Aequor (served from `docs/`, which is committed — not gitignored).

## Commands

No `package.json`, no npm install — `site/` is plain Node ESM using only built-ins.

```sh
node site/build.mjs            # rebuild docs/ from wiki/ + world/
node site/build.mjs --watch    # rebuild on every change under wiki/ or the map source files
node site/serve.mjs            # serve docs/ at http://localhost:8080 (PORT env var to override)
```

There is no test suite and no lint config. The build itself is the correctness check — run it and confirm it exits cleanly and the page count in its log output looks right.

## Deploy flow

`.github/workflows/build-site.yml` runs `node site/build.mjs` on every push to `master` that touches `wiki/**`, `world/**`, `Isle of creation.cartographer.json`, or `site/**`, then commits the regenerated `docs/` back to the branch (`[skip ci]`) and pushes. **Never hand-edit anything under `docs/`** — it's entirely generated output and gets overwritten on the next build/push.

## Architecture

**Content pipeline:** `site/build.mjs` is the entry point and owns all page-assembly logic (section indexes, the timeline, the paginated story reader, the maps pages, search index, sitemap). It delegates to `site/lib/`:
- `vault.mjs` — walks `wiki/**/*.md`, parses frontmatter, resolves `[[wikilinks]]` and backlinks, maps vault folder structure to site URLs (`routeFor`). The vault's own folder layout (e.g. `world/Characters/`, a `Lore` subfolder under `characters/`) is intentionally flatter on the published site — don't assume one mirrors the other.
- `markdown.mjs` — the markdown → HTML renderer, including Obsidian callout syntax (`[!gap]`, `[!contradiction]`, `[!key-insight]`) which `build.mjs`'s `buildQuestionsIndex` pulls into the generated `/questions/` page.
- `maps.mjs` — reads the Cartographer plugin's map formats (`world/Map.cartomap`, `Isle of creation.cartographer.json`) and chunks them into `docs/data/maps/**` for the client-side 2D/3D viewers (`site/static/js/map-viewer.js`, `map3d-viewer.js`).
- `templates.mjs`, `frontmatter.mjs`, `excalidraw.mjs`, `og-image.mjs` — page shell/layout, YAML frontmatter parsing, Excalidraw canvas → SVG rendering, and OG image generation respectively.

**Terrain/map source of truth:** `world/Map.cartomap` is produced by a separate Obsidian plugin at `.obsidian/plugins/cartographer/` (its own TypeScript source, own README) — a chunked terrain painter with a Three.js 3D view. The website's map viewers are a read-only reimplementation of that plugin's rendering, not a shared library; changes to the plugin's terrain/rendering format need a matching update in `site/lib/maps.mjs` and the `map-viewer.js`/`map3d-viewer.js` client code. See `aequor-app-handover.md` for the history of a (since-deleted) attempt to port the plugin's 3D view into a separate web app — it documents exactly which files have zero dependency on the `obsidian` package and are safe to lift.

**Content conventions worth knowing before editing `wiki/`:**
- Only three beings (Tellus, Aequor, Anima) are deities; everyone downstream (Primum's line, the Fae kings) is mortal or Fae-tier even when frontmatter carries a `deity`-ish tag inherited from the Sacrarium. `build.mjs`'s `PANTHEON_ROLE` lookup is the explicit, hand-maintained source for this distinction — extend it rather than inferring role from tags/folders.
- `wiki/characters/Lore/Lore in order.md` is the single source file for the whole origin-myth story reader (`/story/*`); `build.mjs`'s `splitStoryChapters` splits it on `#### Chapter N: Title` / `### Chapter N: Title` headings, which are inconsistent in level and whose numbers repeat — that's a known content gap, not a bug to silently normalize.
- `_index.md` files are folder notes (manual link lists); `build.mjs` skips them when building per-page routes since the section's hand-built index page already supersedes them.
