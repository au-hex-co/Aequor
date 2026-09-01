# Cartographer

An Obsidian plugin for painting worldbuilding maps: an infinite, chunked terrain grid with procedural texture, a sculptable heightmap, an oblique relief view, and an orbit-able true 3D view — all stored as plain, portable JSON in your vault.

This is under active development against a larger original spec (a relational map canvas linking locations to notes, procedurally-generated settlements, and swappable map themes). What's below reflects what's actually built today, not the full plan.

## What's implemented

- **Infinite, chunked map.** No fixed width/height — the grid expands in any direction as you paint. Only chunks you've actually touched are stored or rendered; panning/zooming over empty space costs nothing.
- **Terrain Editor** — brush-paint six surface materials (plains, forest, water, river, sand, road), each with size (uncapped), falloff, opacity, and density controls. Density is contextual: tree density for forest, grass/shrub density for plains, and road development level (dirt → cobblestone → paved, with lane markings) for road.
- **Elevation banding + hillshading.** There's no separate "mountain" or "hill" brush — paint plains or forest and raise it with the Heightmap Editor, and it visually becomes a hill, then a rocky mountain, then gets a snow cap, with real directional shading from the height gradient.
- **Heightmap Editor** — raise/lower/smooth/flatten brushes for sculpting elevation independent of terrain type. Elevation is stored in real-world meters with no ceiling — Strength is meters added per stamp for Raise/Lower, so there's nothing stopping a 10km mountain besides how long you're willing to paint.
- **Land Viewer** — an oblique/cavalier 2.5D relief render: tall terrain visibly pushes its footprint up and toward the viewer, with a shaded "riser" face and animated water. Read-only.
- **3D View** — a real orbit-able Three.js scene: a triangulated heightmap mesh, instanced procedural trees, and an animated shader-driven water surface. Built from a snapshot of the current map (there's a "Rebuild 3D" button rather than live updates, since regenerating the mesh on every brush stroke would be too expensive). Zooming into a plains cell also shows real instanced 3D grass (see "Grass & uneven ground" below).

### Grass & uneven ground

Plains cells with painted grass/shrub density render real standing grass clumps in the 3D View — small "cross card" billboards textured with CC0 blade-cutout sprites (Kenney's [Foliage Sprites](https://kenney.nl/assets/foliage-sprites) pack), tinted per-instance and swaying in a cheap wind shader. This is the plugin's second deliberate exception to the "no external asset" rule (the first being three.js itself, see Development below) — a few noise octaves can't read as convincingly organic up close as a real photographed/rendered blade silhouette can.

Grass is a purely cosmetic, unsaved concept layer, not map data:

- It's placed within a radius of wherever the camera is currently looking (streaming/re-centering as you fly), not across the whole map at once — an unbounded plains area could have far more painted cells than are worth rendering blades for at once.
- Placement (and the terrain shader's matching fine-grained "uneven ground" bump shading, a normal-map-style lighting trick rather than real added geometry) is reseeded from `Math.random()` every time the 3D View is opened, so it looks a little different on every open. None of it is written to the `.cartomap` file.
- **Undo/redo** — Ctrl+Z / Ctrl+Y (Cmd on Mac), scoped to whichever Cartographer map is focused; falls through to Obsidian's normal undo everywhere else.
- **Coordinate tools** — a toggleable grid overlay (chunk-boundary "segmentation" lines + corner coordinates) and a toggleable hover readout, both in real-world meters (configurable per map at creation) so two maps built at the same scale can be lined up edge-to-edge.
- **File Explorer integration** — maps are `.cartomap` files (plain JSON), registered so they show up in and open directly from the File Explorer.

## Not yet built

From the original spec: the relational canvas (location nodes linking to vault notes), the Settlement Painter (procedural buildings by era), Map Themes, and the Terrain Viewer (read-only flat mode) are all still open.

## Usage

- Ribbon icon (map icon) or command palette → **Cartographer: Create new map** / **Open map…** / **Open terrain editor**.
- Toolbar mode buttons switch between Terrain Editor, Heightmap, Land Viewer, and 3D View.
- **Grid** and **Coords** toolbar toggles control the coordinate overlay and hover readout.
- Pan: middle-mouse drag, or hold Space + left-drag. Zoom: Ctrl/Cmd + scroll (or pinch). Plain scroll pans. Left-click-drag paints.
- Ctrl+Z / Ctrl+Y undo and redo the last paint stroke.
- **3D View**: left-drag orbits, right-drag pans, plain scroll zooms (dolly) — standard Three.js orbit controls. Shift + scroll also looks around (orbits the camera horizontally), for mouse-only navigation without a click-drag.

## File format

Each map is a `.cartomap` file (JSON) containing three independent sparse chunk layers — `heightChunks`, `terrainChunks`, `detailChunks` — keyed by `"chunkX,chunkY"`, plus map-level settings (`cellSize`, `metersPerCell`, `chunkSize`, `theme`, `viewMode`). The layers are kept separate on purpose: a chunk only touched by one layer (e.g. sculpting height without painting terrain) doesn't have to allocate the others.

The format has changed shape a few times during early development (bumping `version`); each bump has been a clean break rather than a lossy migration, since there wasn't yet meaningful map data to preserve.

## Development

```
npm install
npm run dev      # esbuild watch mode
npm run build    # typecheck + production bundle
```

Standard Obsidian plugin layout (`manifest.json`, `esbuild.config.mjs`, `main.js` built from `src/main.ts`). The 3D view depends on `three` (bundled into `main.js`, not loaded externally) — that's the one deliberate exception to keeping the plugin dependency-free, since a real orbit-able 3D scene isn't practical to hand-roll in raw WebGL within reasonable scope.

## Known limitations

- Very large maps (tens of thousands of painted chunks) will slow down saves/loads — Cartographer warns past a soft threshold but doesn't cap map size.
- Road lane markings only draw where a road cell has road neighbors on a clear horizontal or vertical axis; isolated or diagonal road cells just show the base surface color.
- The 3D mesh downsamples automatically for very large painted areas (capped at 220 vertices per side) and only refreshes when you hit "Rebuild 3D."
