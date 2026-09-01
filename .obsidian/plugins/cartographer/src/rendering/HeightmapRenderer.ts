import { HeightChunk } from "../model/types";
import { ChunkedGridRenderer } from "./ChunkedGridRenderer";
import { SNOW_FULL } from "./palette";

// Unpainted cells are height 0 by definition (TerrainGrid's default), so the
// empty-chunk fill color matches heightToColor(0) exactly — an unpainted
// chunk looks identical to a painted, perfectly flat one.
const SEA_LEVEL_COLOR = "#5a5a5a";

// Height is unbounded meters, but this is a flat topo-style color ramp, so
// it needs a reference range to ramp across. Reuses the same "solid snow"
// elevation as the terrain banding — past this the cell is already
// rendered as pure white/deep-blue in every other view too.
const REFERENCE_METERS = SNOW_FULL;

export class HeightmapRenderer extends ChunkedGridRenderer<HeightChunk> {
	protected getChunkMap(): Record<string, HeightChunk> {
		return this.data.heightChunks;
	}

	protected cellColor(chunk: HeightChunk, localIndex: number): [number, number, number] {
		return heightToColor(chunk[localIndex]);
	}

	protected emptyColor(): string {
		return SEA_LEVEL_COLOR;
	}
}

// Below-sea-level cells lean blue, near-zero cells are mid-gray, and high
// elevation ramps toward white so the render doubles as a rough topo map.
function heightToColor(h: number): [number, number, number] {
	const norm = Math.max(-1, Math.min(1, h / REFERENCE_METERS));
	if (norm < 0) {
		const t = norm + 1; // 0 (deep) .. 1 (sea level)
		const dark = 20 + t * 60;
		const blue = 60 + t * 120;
		return [dark, dark + 10, blue];
	}
	const gray = Math.round(90 + norm * 165);
	return [gray, gray, gray];
}
