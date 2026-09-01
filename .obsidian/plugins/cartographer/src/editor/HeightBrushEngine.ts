import { TerrainGrid } from "../model/TerrainGrid";
import { CellRect } from "./CellRect";

export type HeightBrushMode = "raise" | "lower" | "smooth" | "flatten" | "set";

export interface HeightBrushSettings {
	mode: HeightBrushMode;
	radius: number;
	// Meters. For raise/lower this is the total elevation change a single
	// stroke adds relative to each cell's height when the stroke started —
	// painting Strength 30 over a 3m spot brings it to 33m at the brush's
	// full-strength plateau, tapering to less of a change near the edge, no
	// matter how many times the stroke sweeps back over that cell (see
	// strokeBaseHeights). For flatten/smooth/set it's instead used as a
	// blend-rate fraction toward the target elevation, clamped to 1 (full
	// snap in one stamp) since those modes converge rather than add.
	strength: number;
	// Absolute target elevation (meters) for "set" mode only.
	targetHeight: number;
}

export const DEFAULT_HEIGHT_BRUSH: HeightBrushSettings = {
	mode: "raise",
	radius: 4,
	strength: 0.4,
	targetHeight: 0,
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
	// Height each cell had when the *current* stroke started, recorded the
	// first time raise/lower touches it. Raise/lower target this base plus
	// or minus Strength meters rather than adding Strength on every stamp,
	// so sweeping back over the same spot repeatedly during one drag can't
	// run the height past base±strength — it converges there and stays,
	// with the brush's edge falloff naturally softening the change near the
	// boundary. A fresh stroke (new click) resets the base, so raising
	// again afterward adds another full Strength on top as expected.
	private strokeBaseHeights: Map<string, number> | null = null;

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
		this.strokeBaseHeights = this.settings.mode === "raise" || this.settings.mode === "lower" ? new Map() : null;
		return this.stamp(grid, fx, fy);
	}

	continueStroke(grid: TerrainGrid, fx: number, fy: number): CellRect {
		return this.stamp(grid, fx, fy);
	}

	endStroke(): void {
		this.strokeBaseHeights = null;
	}

	private stamp(grid: TerrainGrid, fx: number, fy: number): CellRect {
		const { mode, strength, targetHeight } = this.settings;
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
					case "raise": {
						if (!this.strokeBaseHeights) this.strokeBaseHeights = new Map();
						const key = `${cx},${cy}`;
						let base = this.strokeBaseHeights.get(key);
						if (base === undefined) {
							base = grid.getHeight(cx, cy);
							this.strokeBaseHeights.set(key, base);
						}
						const target = base + falloff * strength;
						grid.setHeight(cx, cy, Math.max(grid.getHeight(cx, cy), target));
						break;
					}
					case "lower": {
						if (!this.strokeBaseHeights) this.strokeBaseHeights = new Map();
						const key = `${cx},${cy}`;
						let base = this.strokeBaseHeights.get(key);
						if (base === undefined) {
							base = grid.getHeight(cx, cy);
							this.strokeBaseHeights.set(key, base);
						}
						const target = base - falloff * strength;
						grid.setHeight(cx, cy, Math.min(grid.getHeight(cx, cy), target));
						break;
					}
					case "set":
						grid.blendHeight(cx, cy, targetHeight, Math.min(1, falloff * strength));
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
