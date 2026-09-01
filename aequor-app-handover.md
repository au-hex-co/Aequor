

## What prompted the most recent work: a 3D map view

The user pointed out the website had no 3D map. Investigation found:

- The app's original plan included only a flat 2D "upload image, drop pins" map — never built (unused `maps`/`map_pins` SQLite tables).
- Separately, the user had already built a real 3D map elsewhere: a custom Obsidian plugin called **Cartographer**, at `Aequor/.obsidian/plugins/cartographer/` — an infinite chunked terrain painter with a genuine orbit-able Three.js 3D view (procedural GLSL3 shader materials, instanced trees, animated water). There's a real painted map file with actual content at `Aequor/world/Map.cartomap` (17MB, 1184 height chunks, 47 terrain chunks) — **this file is untouched, still exists, was never part of the deletion**.
- The user asked for the website's map to work "as currently being done in the plugin."

An implementation plan was written and approved: **C:\Users\OLA\.claude\plans\starry-foraging-catmull.md** — port the *read-only* half of Cartographer's 3D viewer (navigate/orbit/fly, terrain, trees, water — not the paint/sculpt editing tools, which stay exclusive to Obsidian) into a new "Map" view in the web app, served live from `Aequor/world/Map.cartomap`.

## Progress on that plan when the deletion request arrived

Confirmed via `grep`: everything under the plugin's `src/model/` and `src/rendering/` folders (the data model + renderers, including the 3D view `Land3DView.ts`) has **zero dependency on the `obsidian` package** — only `main.ts`, `model/MapStore.ts`, `views/*`, and `ui/*` do. That's what made a clean port possible.

**Done** (now deleted along with the rest of `aequor-app/`, not preserved anywhere):

- Created `aequor-app/packages/client/src/map3d/` containing:
  - `types.ts`, `TerrainGrid.ts` — copied unchanged from the plugin's `model/`
  - `palette.ts`, `noise.ts`, `prng.ts`, `terrainTextures.ts` — copied from the plugin's `rendering/`, with import paths fixed (`../model/types` → `./types`, since the plugin's `model/`+`rendering/` split was flattened into one `map3d/` folder)
  - `grassSprites.ts` — copied unchanged but never wired up (see finding below)
  - `MapViewer.ts` — new, hand-trimmed port of the plugin's `rendering/Land3DView.ts`: strips all paint/sculpt/brush code (`BrushEngine`, `HeightBrushEngine`, `HistoryManager`, `CellRect`, raycast-for-painting), keeps `OrbitControls` navigation, WASD fly, Shift+scroll look-around, the chunked terrain mesh + procedural shader materials, instanced trees, and the animated water shader.

**A real finding worth keeping regardless of what happens to the app**: the plugin's own `Land3DView.ts` calls `this.rebuildGrass()` from `buildScene()`, but neither `rebuildGrass()` nor `buildGrassCardGeometry()` (also only referenced in a comment) are actually defined anywhere in the plugin's source (`Aequor/.obsidian/plugins/cartographer/src/rendering/Land3DView.ts`). The "streaming grass" feature the plugin's own README describes appears to be incomplete/dead code — opening the 3D view in Obsidian may currently throw `rebuildGrass is not a function`. **Worth checking/fixing in the Cartographer plugin itself**, independent of the web app work. The terrain shader's procedural `grassColor()` still textures grass cells fine without it; it's just the close-up instanced grass-blade layer that's missing.

**Not started**: the rest of the approved plan —

1. Server route `GET /api/map/world` (gzip-stream `Aequor/world/Map.cartomap` with Last-Modified/304 caching), registered in `packages/server/src/index.ts`.
2. `views/MapView.svelte` (fetch + loading state + dynamic `import("three")`/`import("../map3d/MapViewer.js")` + dispose).
3. Router/nav wiring in `router.ts` + `App.svelte`.
4. Add `three`/`@types/three` to `packages/client/package.json`, `npm install`.
5. End-to-end verification (`npm run dev`, orbit/fly/look-around, 304 reload check, `npm run check-types`).

None of this was ever run or tested — no `npm install` for `three` happened, the server route was never written.

## If this gets rebuilt later

- The source of truth for the map is `Aequor/world/Map.cartomap` (still on disk, untouched).
- The source of truth for the 3D rendering approach is `Aequor/.obsidian/plugins/cartographer/src/rendering/Land3DView.ts` (still on disk, untouched) — the trimming approach described above (drop everything under "paint/sculpt", keep everything under "navigate") is the fastest path back to where this was.
- The full plan with exact file-by-file steps is preserved at `C:\Users\OLA\.claude\plans\starry-foraging-catmull.md`.
- The original aequor-app architecture/design plan is preserved at `C:\Users\OLA\.claude\plans\alright-big-req-make-harmonic-tiger.md`.

