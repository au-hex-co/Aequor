import { TerrainType } from "../model/types";

// Flat placeholder colors for the Terrain Editor/Viewer. Step 9 (Map Themes)
// replaces this with theme-driven palettes; step 4 layers procedural
// texture on top without changing these base tones.
export const TERRAIN_COLORS: Record<TerrainType, string> = {
	water: "#3a72b0",
	river: "#5aa0d8",
	sand: "#d9c48b",
	plains: "#9ac36c",
	forest: "#3f6b3f",
	road: "#8a7a5c",
	mountain: "#8f8578",
	snow: "#eef3f5",
};

export const EMPTY_CELL_COLOR = "#cfc6ae";

// Elevation-band tones. These aren't paintable materials — they're what
// solid ground (plains/forest/sand) shifts toward as its height rises, so
// painting grass and raising it turns it into a hill, then a rocky
// mountain, then a snow cap without a separate "mountain brush" ever
// existing. Water/river/road stay their own color at any height.
const HILL_COLOR: [number, number, number] = hexToRgb("#a3a86c");
const MOUNTAIN_COLOR: [number, number, number] = hexToRgb("#8a8078");
const SNOW_COLOR: [number, number, number] = hexToRgb("#f2f2f2");

// Height is stored in real meters and is unbounded (see TerrainGrid), so
// these bands are meter thresholds rather than fractions of a fixed max —
// a 10km peak just means most of it renders as solid snow/rock past
// SNOW_FULL, the same way a real mountain does.
export const HILL_START = 15;
export const MOUNTAIN_START = 60;
export const SNOW_START = 250;
export const SNOW_FULL = 600;

// Per-cell height delta (in meters) that reaches full hillshade swing.
// Real elevation data can differ by many meters between adjacent cells, so
// this has to be a meaningfully large reference or every slope saturates
// to solid black/white instead of reading as gradual shading.
export const HILLSHADE_REFERENCE_METERS = 8;

// "mountain" bands too — its base color already sits near MOUNTAIN_COLOR,
// so painting it just fast-forwards straight into the rocky/snow-capped
// bands its own height range reaches. "snow" deliberately doesn't: it's a
// manual coverage brush, not a landform, so it keeps its own color at any
// elevation the way water/river/road do.
const BANDED_TYPES: ReadonlySet<TerrainType> = new Set(["plains", "forest", "sand", "mountain"]);

export function terrainColor(type: TerrainType | null): string {
	if (!type) return EMPTY_CELL_COLOR;
	return TERRAIN_COLORS[type];
}

// Final render color for a cell given its painted material and its actual
// height. Only "solid ground" materials band toward hill/mountain/snow;
// water, river, and road hold their own color regardless of elevation.
export function bandedTerrainColor(type: TerrainType | null, height: number): [number, number, number] {
	if (!type) return hexToRgb(EMPTY_CELL_COLOR);
	const base = hexToRgb(TERRAIN_COLORS[type]);
	if (!BANDED_TYPES.has(type)) return base;

	if (height < HILL_START) return base;
	if (height < MOUNTAIN_START) {
		return lerpRgb(base, HILL_COLOR, (height - HILL_START) / (MOUNTAIN_START - HILL_START));
	}
	if (height < SNOW_START) {
		return lerpRgb(HILL_COLOR, MOUNTAIN_COLOR, (height - MOUNTAIN_START) / (SNOW_START - MOUNTAIN_START));
	}
	return lerpRgb(MOUNTAIN_COLOR, SNOW_COLOR, Math.min(1, (height - SNOW_START) / (SNOW_FULL - SNOW_START)));
}

export type RoadStyle = "dirt" | "cobblestone" | "paved";

const ROAD_STYLE_COLORS: Record<RoadStyle, string> = {
	dirt: "#8a6a45",
	cobblestone: "#8f8f8f",
	paved: "#3a3a3f",
};

// Road's detail value doubles as "how developed is this road" — a single
// knob spanning dirt track -> cobblestone -> paved, with lane count also
// derived from the same value once it's in paved territory.
export function roadStyleFromDetail(detail: number): RoadStyle {
	if (detail < 0.33) return "dirt";
	if (detail < 0.66) return "cobblestone";
	return "paved";
}

export function roadLaneCount(detail: number): number {
	return 1 + Math.round(Math.max(0, (detail - 0.66) / 0.34) * 3);
}

export function roadBaseColor(detail: number): [number, number, number] {
	return hexToRgb(ROAD_STYLE_COLORS[roadStyleFromDetail(detail)]);
}

export function hexToRgb(hex: string): [number, number, number] {
	const clean = hex.replace("#", "");
	const num = parseInt(clean, 16);
	return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function lerpRgb(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
	const clamped = Math.max(0, Math.min(1, t));
	return [
		Math.round(a[0] + (b[0] - a[0]) * clamped),
		Math.round(a[1] + (b[1] - a[1]) * clamped),
		Math.round(a[2] + (b[2] - a[2]) * clamped),
	];
}
