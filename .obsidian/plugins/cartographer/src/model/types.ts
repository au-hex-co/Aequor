// Paintable surface materials. Plain "hill"/"mountain"/"snow" look is still
// mostly a consequence of elevation, not material (paint plains/forest and
// raise it — see rendering/palette.ts's elevation banding) — but "mountain"
// and "snow" are themselves paintable too, for the two cases banding can't
// cover: instantly sculpting a whole noise-shaped ridge line in one stroke
// (see BrushEngine's per-cell noise target for "mountain"), and dusting
// snow somewhere that isn't actually high enough to earn it naturally.
export type TerrainType = "forest" | "water" | "river" | "sand" | "plains" | "road" | "mountain" | "snow";

export interface TerrainHeightRange {
	min: number;
	max: number;
}

// Default height contribution (in meters) each terrain type pushes a
// painted cell toward. Painting blends the existing height toward this
// range rather than clamping to it outright. These are deliberately
// modest — real elevation comes from the Heightmap Editor, not from picking
// a "tall" material.
export const TERRAIN_HEIGHT_RANGES: Record<TerrainType, TerrainHeightRange> = {
	water: { min: -1, max: -0.35 },
	river: { min: -0.6, max: -0.15 },
	sand: { min: -0.1, max: 0.1 },
	plains: { min: -0.05, max: 0.15 },
	forest: { min: 0.05, max: 0.3 },
	road: { min: -0.02, max: 0.05 },
	// The full range a "mountain" stroke can reach — BrushEngine doesn't
	// blend every cell toward the midpoint like the other types, it shapes
	// each cell somewhere in this band with ridged noise, so a wide stroke
	// comes out as an actual ridge line instead of a flat-topped plateau.
	mountain: { min: 55, max: 230 },
	// Barely touches height on purpose — snow is a paintable coverage, not a
	// landform; the ground underneath keeps roughly the shape it had.
	snow: { min: -0.05, max: 0.15 },
};

export interface TerrainStrokePoint {
	x: number;
	y: number;
	pressure?: number;
}

export interface TerrainStroke {
	id: string;
	type: TerrainType;
	seed: number;
	radius: number;
	falloff: number;
	opacity: number;
	points: TerrainStrokePoint[];
	erase?: boolean;
}

export type SettlementEra =
	| "stone-age"
	| "bronze-age"
	| "iron-age"
	| "medieval"
	| "renaissance"
	| "industrial"
	| "modern"
	| "cyberpunk";

export type SettlementSize = "hamlet" | "village" | "town" | "city" | "metropolis";

export interface SettlementData {
	id: string;
	x: number;
	y: number;
	era: SettlementEra;
	size: SettlementSize;
	seed: number;
	radius: number;
	name: string;
	notePath?: string;
}

// One-off landmark features — a single named massive tree, a placed
// artifact — that don't belong to any one cell the way painted terrain
// does. Like everything else in this file, only the seed and a scale are
// kept; the actual shape (canopy layers, root flare, gem facets) is drawn
// fresh from those two numbers every render, never stored.
export type PropType = "massive-tree" | "artifact";

export interface PropData {
	id: string;
	x: number; // cell coordinates, same space as TerrainStroke points
	y: number;
	type: PropType;
	seed: number;
	// Meters of height for a massive-tree; a relative 0..1 "presence" size
	// for an artifact (how large its glow/gem reads at the default zoom).
	scale: number;
	name?: string;
	notePath?: string;
}

export type ViewModeId =
	| "terrain-editor"
	| "terrain-viewer"
	| "heightmap-viewer"
	| "land-viewer"
	| "3d-viewer";

// Height and terrain live in two independent sparse chunk maps, not one
// combined chunk object, so a chunk touched by only one layer (e.g. the
// Heightmap Editor's raise/lower brush, which never paints terrain) doesn't
// also have to allocate a wasted array for the other layer. Both maps share
// the same chunkX,chunkY coordinate system so they stay spatially aligned.
// A chunk is only allocated the first time a cell inside it is written to —
// reading an untouched coordinate returns the default (height 0, terrain
// null) without allocating anything. This is what lets the map be an open,
// ever-expandable canvas instead of a fixed WxH array: a 10,000x10,000-cell
// world costs nothing until you actually paint in it.
export type HeightChunk = number[]; // chunkSize*chunkSize, row-major
export type TerrainChunk = (TerrainType | null)[]; // chunkSize*chunkSize, row-major
// 0..1 "how much" per cell — tree/shrub density for forest & plains, and
// lane-count/road-style bucket for road. A third independent sparse layer
// for the same reason height and terrain are split: a chunk only touched by
// one layer shouldn't have to allocate the others.
export type DetailChunk = number[]; // chunkSize*chunkSize, row-major

export interface ChunkBounds {
	minChunkX: number;
	minChunkY: number;
	maxChunkX: number;
	maxChunkY: number;
}

export interface CartographerMapData {
	version: number;
	name: string;
	cellSize: number; // world px per cell at zoom 1 (rendering scale, not real-world)
	metersPerCell: number; // real-world scale used for coordinate display, e.g. the grid overlay and hover readout
	chunkSize: number; // cells per chunk side, fixed per-map at creation
	heightChunks: Record<string, HeightChunk>; // key: `${chunkX},${chunkY}`
	terrainChunks: Record<string, TerrainChunk>; // key: `${chunkX},${chunkY}`
	detailChunks: Record<string, DetailChunk>; // key: `${chunkX},${chunkY}`
	terrainStrokes: TerrainStroke[];
	settlements: SettlementData[];
	props: PropData[];
	theme: string;
	viewMode: ViewModeId;
}

export const CARTOGRAPHER_FORMAT_VERSION = 3;
export const DEFAULT_CELL_SIZE = 16;
export const DEFAULT_CHUNK_SIZE = 32;
export const DEFAULT_METERS_PER_CELL = 5;
export const DEFAULT_DETAIL = 0.5;

// Soft warning only — painting this many distinct chunks (across either
// layer) means a lot of actual content, at which point the JSON file itself
// starts getting large. Not a cap.
export const CHUNK_COUNT_WARNING_THRESHOLD = 1500;

export function createDefaultMapData(name: string, metersPerCell = DEFAULT_METERS_PER_CELL): CartographerMapData {
	return {
		version: CARTOGRAPHER_FORMAT_VERSION,
		name,
		cellSize: DEFAULT_CELL_SIZE,
		metersPerCell,
		chunkSize: DEFAULT_CHUNK_SIZE,
		heightChunks: {},
		terrainChunks: {},
		detailChunks: {},
		terrainStrokes: [],
		settlements: [],
		props: [],
		theme: "parchment",
		viewMode: "terrain-editor",
	};
}

export function chunkKey(chunkX: number, chunkY: number): string {
	return `${chunkX},${chunkY}`;
}

export function parseChunkKey(key: string): { chunkX: number; chunkY: number } {
	const [x, y] = key.split(",").map(Number);
	return { chunkX: x, chunkY: y };
}

// Bounding box (in chunk coordinates) of every chunk that currently has
// data in either layer, or null for a brand-new empty map. Used to frame
// the camera.
export function computePaintedChunkBounds(data: CartographerMapData): ChunkBounds | null {
	const keys = new Set([...Object.keys(data.heightChunks), ...Object.keys(data.terrainChunks)]);
	if (keys.size === 0) return null;

	let minChunkX = Infinity;
	let minChunkY = Infinity;
	let maxChunkX = -Infinity;
	let maxChunkY = -Infinity;

	for (const key of keys) {
		const { chunkX, chunkY } = parseChunkKey(key);
		if (chunkX < minChunkX) minChunkX = chunkX;
		if (chunkY < minChunkY) minChunkY = chunkY;
		if (chunkX > maxChunkX) maxChunkX = chunkX;
		if (chunkY > maxChunkY) maxChunkY = chunkY;
	}

	return { minChunkX, minChunkY, maxChunkX, maxChunkY };
}
