import { TerrainGrid } from "../model/TerrainGrid";
import { CellRect } from "./CellRect";

export type HeightBrushMode = "raise" | "lower" | "smooth" | "flatten";

export interface HeightBrushSettings {
	mode: HeightBrushMode;
	radius: number;
	// Meters. For raise/lower this is added directly per full-falloff stamp
	// (repeated strokes keep accumulating — there's no ceiling, so a 10km
	// mountain is just a lot of strokes). For flatten/smooth it's instead
	// used as a blend-rate fraction toward the target elevation, clamped to
	// 1 (full snap in one stamp) since those modes converge rather than add.
	strength: number;
}

export const DEFAULT_HEIGHT_BRUSH: HeightBrushSettings = {
	mode: "raise",
	radius: 4,
	strength: 0.4,
};

const MAX_APPLIED_RADIUS = 400;

// Outer fraction of the brush radius that ramps down to the surrounding
// terrain. The inner (1 - EDGE_SOFTNESS) of the brush stays at full
// strength — a flat-topped plateau rather than a dome — so a Size-20
// brush at Strength 60 actually raises a 20-cell-wide area to 60m and
// only tapers right at the boundary, instead of peaking at 60m in the
// center cell and having already fallen off partway to the edge.
const EDGE_SOFTNESS = 0.25;
const PLATEAU_EDGE = 1 - EDGE_SOFTNESS;

function plateauFalloff(normalizedDist: number): number {
	if (normalizedDist <= PLATEAU_EDGE) return 1;
	const u = (normalizedDist - PLATEAU_EDGE) / EDGE_SOFTNESS;
	return 1 - u * u * (3 - 2 * u);
}

// Manual height sculpting independent of terrain type — raise/lower push
// toward the extremes, flatten blends toward the height sampled at stroke
// start, smooth blends each cell toward its live 3x3 neighborhood average.
export class HeightBrushEngine {
	private flattenReference = 0;

	constructor(private settings: HeightBrushSettings) {}

	updateSettings(patch: Partial<HeightBrushSettings>): void {
		Object.assign(this.settings, patch);
	}

	getSettings(): HeightBrushSettings {
		return this.settings;
	}

	startStroke(grid: TerrainGrid, fx: number, fy: number): CellRect {
		if (this.settings.mode === "flatten") {
			this.flattenReference = grid.sampleHeight(fx, fy);
		}
		return this.stamp(grid, fx, fy);
	}

	continueStroke(grid: TerrainGrid, fx: number, fy: number): CellRect {
		return this.stamp(grid, fx, fy);
	}

	endStroke(): void {
		// no persistent state between strokes yet
	}

	private stamp(grid: TerrainGrid, fx: number, fy: number): CellRect {
		const { mode, strength } = this.settings;
		// See BrushEngine's MAX_APPLIED_RADIUS note — same reasoning here.
		const radius = Math.min(this.settings.radius, MAX_APPLIED_RADIUS);

		const minCx = Math.floor(fx - radius);
		const maxCx = Math.ceil(fx + radius);
		const minCy = Math.floor(fy - radius);
		const maxCy = Math.ceil(fy + radius);

		for (let cy = minCy; cy <= maxCy; cy++) {
			for (let cx = minCx; cx <= maxCx; cx++) {
				const dist = Math.hypot(cx + 0.5 - fx, cy + 0.5 - fy);
				if (dist > radius) continue;

				const falloff = plateauFalloff(dist / radius);
				if (falloff <= 0.001) continue;

				switch (mode) {
					case "raise":
						grid.addHeight(cx, cy, falloff * strength);
						break;
					case "lower":
						grid.addHeight(cx, cy, -falloff * strength);
						break;
					case "flatten":
						grid.blendHeight(cx, cy, this.flattenReference, Math.min(1, falloff * strength));
						break;
					case "smooth": {
						let sum = 0;
						for (let dy = -1; dy <= 1; dy++) {
							for (let dx = -1; dx <= 1; dx++) {
								sum += grid.getHeight(cx + dx, cy + dy);
							}
						}
						grid.blendHeight(cx, cy, sum / 9, Math.min(1, falloff * strength));
						break;
					}
				}
			}
		}

		return { minCx, minCy, maxCx, maxCy };
	}
}
