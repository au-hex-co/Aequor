import { TerrainGrid } from "../model/TerrainGrid";
import { CartographerMapData, TERRAIN_HEIGHT_RANGES, TerrainStroke, TerrainType } from "../model/types";
import { CellRect, mergeCellRect } from "./CellRect";
import { ridgedFbm2D } from "../rendering/noise";

export interface BrushSettings {
	type: TerrainType;
	radius: number; // in cells
	falloff: number; // 0 (soft/wide gradient) .. 1 (hard edge)
	opacity: number; // 0..1, overall strength multiplier
	// 0..1 "how much" — read contextually per type by the renderer: tree
	// density for forest, shrub/grass density+height for plains, and
	// lane count + surface style (dirt/cobblestone/paved) for road.
	density: number;
	erase: boolean;
}

export const DEFAULT_BRUSH: BrushSettings = {
	type: "plains",
	radius: 3,
	falloff: 0.5,
	opacity: 0.85,
	density: 0.5,
	erase: false,
};

const MAX_APPLIED_RADIUS = 400;

// Handles one paint drag: samples pointer motion into a TerrainStroke and
// stamps soft-edged falloff onto both the terrain-type grid and the
// heightmap so a stroke blends into its neighbors instead of hard-filling
// a pixel block. Cell coordinates are unbounded — there is no grid edge to
// clip against.
export class BrushEngine {
	private activeStroke: TerrainStroke | null = null;
	private lastPoint: { x: number; y: number } | null = null;
	// Pre-stroke height per touched cell, keyed "cx,cy" — see the isRiver
	// branch in stamp(). Only ever populated/read while type is "river"; a
	// fresh Map per stroke is what keeps repeated overlapping stamps from
	// digging the channel deeper than one pass's depth.
	private strokeBaseHeights: Map<string, number> | null = null;

	constructor(private settings: BrushSettings) {}

	updateSettings(patch: Partial<BrushSettings>): void {
		Object.assign(this.settings, patch);
	}

	getSettings(): BrushSettings {
		return this.settings;
	}

	startStroke(grid: TerrainGrid, fx: number, fy: number): CellRect {
		this.activeStroke = {
			id: `stroke-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
			type: this.settings.type,
			seed: Math.floor(Math.random() * 1e9),
			radius: this.settings.radius,
			falloff: this.settings.falloff,
			opacity: this.settings.opacity,
			points: [{ x: fx, y: fy }],
			erase: this.settings.erase,
		};
		this.lastPoint = { x: fx, y: fy };
		this.strokeBaseHeights = new Map();
		return this.stamp(grid, fx, fy);
	}

	continueStroke(grid: TerrainGrid, fx: number, fy: number): CellRect | null {
		if (!this.activeStroke || !this.lastPoint) return null;
		this.activeStroke.points.push({ x: fx, y: fy });

		// Interpolate between the last sampled point and this one so fast
		// pointer motion doesn't leave gaps in the stroke.
		const dx = fx - this.lastPoint.x;
		const dy = fy - this.lastPoint.y;
		const dist = Math.hypot(dx, dy);
		const step = Math.max(this.settings.radius * 0.35, 0.5);
		const steps = Math.max(1, Math.ceil(dist / step));

		let combined: CellRect | null = null;
		for (let i = 1; i <= steps; i++) {
			const t = i / steps;
			const rect = this.stamp(grid, this.lastPoint.x + dx * t, this.lastPoint.y + dy * t);
			combined = mergeCellRect(combined, rect);
		}

		this.lastPoint = { x: fx, y: fy };
		return combined;
	}

	endStroke(data: CartographerMapData): TerrainStroke | null {
		const stroke = this.activeStroke;
		this.activeStroke = null;
		this.lastPoint = null;
		this.strokeBaseHeights = null;
		if (stroke) data.terrainStrokes.push(stroke);
		return stroke;
	}

	private stamp(grid: TerrainGrid, fx: number, fy: number): CellRect {
		const { type, falloff, opacity, density, erase } = this.settings;
		// No UI-imposed max on brush size, but a stamp's cost is O(radius^2) —
		// silently cap the radius actually applied so an extreme typed value
		// can't freeze the tab. The size field itself still accepts any number.
		const radius = Math.min(this.settings.radius, MAX_APPLIED_RADIUS);
		const exponent = 0.4 + falloff * 2.6;
		const range = TERRAIN_HEIGHT_RANGES[type];
		const flatTargetHeight = (range.min + range.max) / 2;

		// "mountain" is the one type that doesn't blend every cell toward the
		// same flat average: it shapes each cell toward a ridged-noise height
		// within its range instead, so a wide stroke reads as an actual ridge
		// line (peaks and saddles) rather than a flat-topped plateau. The
		// noise is keyed off the stroke's own seed (stable for the whole
		// drag — see startStroke) and world cell coordinates, never stored,
		// so the same spot always reshapes the same way across repeated
		// passes instead of jittering. Density doubles as "ruggedness" here:
		// low density softens the ridge contrast, high density sharpens it.
		const isMountain = type === "mountain" && !erase;
		const seed = this.activeStroke?.seed ?? 0;
		const noiseScale = 1 / Math.max(4, radius * 0.6);
		const ruggedness = 0.5 + density * 1.5;

		// Unlike every other type, "river" doesn't flatten toward one fixed
		// absolute elevation — it carves a shallow, roughly constant-depth
		// channel into whatever ground is already there, so a river painted
		// down a hillside follows the hill's existing slope (and actually
		// drops in elevation going downhill) instead of leveling it into a
		// flat shelf. That real per-cell slope is what lets Land3DView detect
		// steep runs and render them as a waterfall instead of flat water.
		// The depth is captured once per touched cell at its PRE-stroke
		// height (see strokeBaseHeights, populated lazily below) rather than
		// re-read fresh every stamp — re-reading would make repeated
		// overlapping stamps (normal for a dragged stroke) dig the channel
		// progressively deeper each pass instead of converging, the way
		// every other type's fixed target already does.
		const isRiver = type === "river" && !erase;
		const channelDepth = -flatTargetHeight; // flatTargetHeight is a small negative offset; this is its magnitude

		const minCx = Math.floor(fx - radius);
		const maxCx = Math.ceil(fx + radius);
		const minCy = Math.floor(fy - radius);
		const maxCy = Math.ceil(fy + radius);

		for (let cy = minCy; cy <= maxCy; cy++) {
			for (let cx = minCx; cx <= maxCx; cx++) {
				const dist = Math.hypot(cx + 0.5 - fx, cy + 0.5 - fy);
				if (dist > radius) continue;

				const t = 1 - dist / radius;
				const strength = Math.pow(t, exponent) * opacity;
				if (strength <= 0.02) continue;

				if (erase) {
					if (strength > 0.5) {
						grid.setTerrain(cx, cy, null);
					}
					grid.blendHeight(cx, cy, 0, strength);
					continue;
				}

				if (strength > 0.4) {
					grid.setTerrain(cx, cy, type);
				}

				let targetHeight = flatTargetHeight;
				if (isMountain) {
					const ridge = ridgedFbm2D(cx * noiseScale, cy * noiseScale, seed, 4);
					const shaped = Math.pow(ridge, 1 / ruggedness);
					targetHeight = range.min + shaped * (range.max - range.min);
				} else if (isRiver) {
					const key = `${cx},${cy}`;
					let base = this.strokeBaseHeights!.get(key);
					if (base === undefined) {
						base = grid.getHeight(cx, cy);
						this.strokeBaseHeights!.set(key, base);
					}
					targetHeight = base - channelDepth;
				}
				grid.blendHeight(cx, cy, targetHeight, strength);
				grid.blendDetail(cx, cy, density, strength);
			}
		}

		return { minCx, minCy, maxCx, maxCy };
	}
}
