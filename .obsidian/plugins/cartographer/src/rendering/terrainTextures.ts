import { TerrainType } from "../model/types";
import { MOUNTAIN_START, SNOW_START, SNOW_FULL, roadStyleFromDetail } from "./palette";

// Which discrete "material" a vertex should render as in the 3D view. The
// actual pixel-scale look of each material (grain, mottling, streaking) is
// computed live in Land3DView's terrain fragment shader from real noise
// functions evaluated per-fragment — not from a baked raster image — so
// there is no fixed texel resolution to ever look pixelated no matter how
// close the camera gets, and no external asset file either (matching the
// "no external asset" rule the rest of the plugin follows, see Land3DView's
// file header). Selection here is still per-VERTEX and deliberately
// discrete, not a smooth per-pixel blend between materials — like
// Minecraft's per-block texture convention, one material wins outright
// rather than smearing together at a boundary. The existing height/
// elevation-band TINT (see palette.ts's bandedTerrainColor, baked into the
// mesh's vertex "color" attribute) is multiplied on top in the shader, so
// color still grades smoothly across a hill->mountain->snow transition even
// though the underlying material pattern switches at a hard edge.
export const TERRAIN_TILE = {
	grass: 0,
	forest: 1,
	sand: 2,
	rock: 3,
	snow: 4,
	dirtRoad: 5,
	cobbleRoad: 6,
	pavedRoad: 7,
	bareDirt: 8,
} as const;

// Mirrors palette.ts's bandedTerrainColor thresholds so the material switch
// lines up with the color band it already draws (hill/mountain/snow) — see
// that function's comments for why these particular thresholds exist.
export function terrainTileIndex(type: TerrainType | null, height: number, detail: number): number {
	if (!type) return TERRAIN_TILE.bareDirt;
	if (type === "water" || type === "river") return TERRAIN_TILE.bareDirt; // riverbed, hidden under the water plane
	if (type === "road") {
		const style = roadStyleFromDetail(detail);
		if (style === "dirt") return TERRAIN_TILE.dirtRoad;
		if (style === "cobblestone") return TERRAIN_TILE.cobbleRoad;
		return TERRAIN_TILE.pavedRoad;
	}
	if (type === "snow") return TERRAIN_TILE.snow;

	const baseTile = type === "plains" ? TERRAIN_TILE.grass : type === "forest" ? TERRAIN_TILE.forest : TERRAIN_TILE.sand;
	// "mountain" starts life already at the rock tile — see palette.ts's note
	// that its base color sits near MOUNTAIN_COLOR, so it fast-forwards into
	// the same bands the other types climb into as they're raised.
	const climbedTile = type === "mountain" ? TERRAIN_TILE.rock : baseTile;
	if (height >= (SNOW_START + SNOW_FULL) / 2) return TERRAIN_TILE.snow;
	if (height >= MOUNTAIN_START) return TERRAIN_TILE.rock;
	return climbedTile;
}
