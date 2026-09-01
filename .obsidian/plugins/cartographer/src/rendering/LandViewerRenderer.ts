import { CartographerMapData, chunkKey } from "../model/types";
import { TerrainGrid } from "../model/TerrainGrid";
import { Camera } from "./CanvasViewport";
import { EMPTY_CELL_COLOR, HILLSHADE_REFERENCE_METERS, MOUNTAIN_START, SNOW_FULL, bandedTerrainColor, hexToRgb } from "./palette";
import { hashSeed, mulberry32 } from "./prng";

// Oblique/cavalier projection: every cell is displaced along a fixed
// viewing-angle vector proportional to its own height, and a shaded "riser"
// face connects the shifted top back down to the flat footprint — the
// pushed-up relief look from the spec. Chunks still cache to a bitmap like
// the other renderers (for the same visible-area-only cost), but the
// bitmap now includes padding for the upward shear, and chunks are blitted
// in back-to-front (cy ascending) order so near, tall terrain correctly
// overlaps what's behind it — the painter's-algorithm requirement that
// comes with this projection choice.
const SHEAR_ANGLE = Math.PI / 3; // 60° from horizontal
const SHEAR_DIR_X = Math.cos(SHEAR_ANGLE);
const SHEAR_DIR_Y = -Math.sin(SHEAR_ANGLE); // screen-up
const HEIGHT_EXAGGERATION = 4; // cells of displacement at DISPLAY_HEIGHT_CAP
// Height is unbounded meters now (a painted mountain can be 10km tall), but
// this is a fixed-size cached bitmap with padding sized for a maximum shear
// — so the *displayed* shear saturates at this elevation (same point real
// terrain is solid snow/rock anyway) while the actual stored height, the
// Heightmap view, and the 3D view all remain uncapped.
const DISPLAY_HEIGHT_CAP = SNOW_FULL;

interface ChunkBitmapEntry {
	bmp: HTMLCanvasElement;
	offsetX: number;
	offsetY: number;
}

export class LandViewerRenderer {
	private grid: TerrainGrid;
	private chunkBitmaps = new Map<string, ChunkBitmapEntry>();
	private waterChunks = new Set<string>();
	private shimmerPhase = 0;

	constructor(private data: CartographerMapData) {
		this.grid = new TerrainGrid(data);
		this.scanWaterChunks();
	}

	// Called on a timer while this mode is active — only water/river chunks
	// get their cache dropped, so shimmer animation doesn't force a full
	// terrain repaint every tick.
	advanceShimmer(): void {
		this.shimmerPhase += 1;
		for (const key of this.waterChunks) this.chunkBitmaps.delete(key);
	}

	draw(ctx: CanvasRenderingContext2D, camera: Camera, viewW: number, viewH: number): void {
		const size = this.data.chunkSize;
		const cellSize = this.data.cellSize;
		const chunkWorldSize = size * cellSize;
		const maxShearPx = cellSize * HEIGHT_EXAGGERATION;
		const padTop = Math.ceil(Math.abs(SHEAR_DIR_Y) * maxShearPx) + cellSize;
		const padSide = Math.ceil(Math.abs(SHEAR_DIR_X) * maxShearPx) + cellSize;

		const worldMinX = camera.x - padSide;
		const worldMinY = camera.y - padTop;
		const worldMaxX = camera.x + viewW / camera.zoom + padSide;
		const worldMaxY = camera.y + viewH / camera.zoom;

		const minChunkX = Math.floor(worldMinX / chunkWorldSize) - 1;
		const maxChunkX = Math.floor(worldMaxX / chunkWorldSize) + 1;
		const minChunkY = Math.floor(worldMinY / chunkWorldSize) - 1;
		const maxChunkY = Math.floor(worldMaxY / chunkWorldSize) + 1;

		for (let cy = minChunkY; cy <= maxChunkY; cy++) {
			for (let cx = minChunkX; cx <= maxChunkX; cx++) {
				const key = chunkKey(cx, cy);
				if (this.data.terrainChunks[key] === undefined && this.data.heightChunks[key] === undefined) continue;

				const entry = this.getOrPaintChunk(cx, cy, padTop, padSide);
				if (entry) {
					ctx.drawImage(entry.bmp, cx * chunkWorldSize - entry.offsetX, cy * chunkWorldSize - entry.offsetY);
				}
			}
		}
	}

	private scanWaterChunks(): void {
		this.waterChunks.clear();
		for (const [key, chunk] of Object.entries(this.data.terrainChunks)) {
			if (chunk.some((t) => t === "water" || t === "river")) this.waterChunks.add(key);
		}
	}

	private getOrPaintChunk(chunkX: number, chunkY: number, padTop: number, padSide: number): ChunkBitmapEntry | null {
		const key = chunkKey(chunkX, chunkY);
		const cached = this.chunkBitmaps.get(key);
		if (cached) return cached;

		const size = this.data.chunkSize;
		const cellSize = this.data.cellSize;
		const bmp = document.createElement("canvas");
		bmp.width = size * cellSize + padSide * 2;
		bmp.height = size * cellSize + padTop;

		const ctx = bmp.getContext("2d");
		if (!ctx) return null;
		ctx.imageSmoothingEnabled = false;

		// Row order (ly ascending) matters: a cell's shear only ever bleeds
		// upward into the row above it, so drawing rows top-to-bottom means
		// each later (nearer) row correctly paints over the previous row's
		// upward bleed.
		for (let ly = 0; ly < size; ly++) {
			for (let lx = 0; lx < size; lx++) {
				const cx = chunkX * size + lx;
				const cy = chunkY * size + ly;
				this.drawCell(ctx, cx, cy, lx * cellSize + padSide, ly * cellSize + padTop, cellSize);
			}
		}

		const entry: ChunkBitmapEntry = { bmp, offsetX: padSide, offsetY: padTop };
		this.chunkBitmaps.set(key, entry);
		return entry;
	}

	private drawCell(ctx: CanvasRenderingContext2D, cx: number, cy: number, baseX: number, baseY: number, cellSize: number): void {
		const type = this.grid.getTerrain(cx, cy);
		const height = this.grid.getHeight(cx, cy);
		if (!type && height === 0) return;

		const [r, g, b] = type ? bandedTerrainColor(type, height) : hexToRgb(EMPTY_CELL_COLOR);
		const shade = this.hillshade(cx, cy);
		let sr = clamp255(r * shade);
		let sg = clamp255(g * shade);
		let sb = clamp255(b * shade);

		if (type === "water" || type === "river") {
			const shimmer = Math.sin(this.shimmerPhase * 0.4 + (cx * 0.6 + cy * 0.9)) * 18;
			sr = clamp255(sr + shimmer);
			sg = clamp255(sg + shimmer);
			sb = clamp255(sb + shimmer * 1.4);
		}

		const clampedHeight = Math.max(-DISPLAY_HEIGHT_CAP, Math.min(DISPLAY_HEIGHT_CAP, height));
		const magnitude = (clampedHeight / DISPLAY_HEIGHT_CAP) * cellSize * HEIGHT_EXAGGERATION;
		const dx = SHEAR_DIR_X * magnitude;
		const dy = SHEAR_DIR_Y * magnitude;

		if (Math.abs(dy) > 0.5) {
			ctx.fillStyle = `rgb(${Math.round(sr * 0.55)}, ${Math.round(sg * 0.55)}, ${Math.round(sb * 0.55)})`;
			ctx.beginPath();
			ctx.moveTo(baseX + dx, baseY + dy + cellSize);
			ctx.lineTo(baseX + dx + cellSize, baseY + dy + cellSize);
			ctx.lineTo(baseX + cellSize, baseY + cellSize);
			ctx.lineTo(baseX, baseY + cellSize);
			ctx.closePath();
			ctx.fill();
		}

		ctx.fillStyle = `rgb(${sr}, ${sg}, ${sb})`;
		ctx.fillRect(baseX + dx, baseY + dy, cellSize, cellSize);

		if (type === "forest" && height < MOUNTAIN_START) {
			this.drawTrees(ctx, cx, cy, baseX + dx, baseY + dy, cellSize);
		}
	}

	private drawTrees(ctx: CanvasRenderingContext2D, cx: number, cy: number, originX: number, originY: number, cellSize: number): void {
		const density = this.grid.getDetail(cx, cy);
		const rng = mulberry32(hashSeed(cx, cy, 1337));
		const treeCount = Math.round(1 + density * 5);
		for (let i = 0; i < treeCount; i++) {
			const tx = originX + rng() * cellSize;
			const ty = originY + rng() * cellSize;
			const radius = cellSize * (0.16 + rng() * 0.14);
			const tone = 0.7 + rng() * 0.5;
			ctx.beginPath();
			ctx.fillStyle = `rgb(${Math.round(28 * tone)}, ${Math.round(72 * tone)}, ${Math.round(32 * tone)})`;
			ctx.arc(tx, ty - radius * 0.6, radius, 0, Math.PI * 2);
			ctx.fill();
		}
	}

	private hillshade(cx: number, cy: number): number {
		const gx = this.grid.getHeight(cx + 1, cy) - this.grid.getHeight(cx - 1, cy);
		const gy = this.grid.getHeight(cx, cy + 1) - this.grid.getHeight(cx, cy - 1);
		const shade = 1 - ((gx + gy) / HILLSHADE_REFERENCE_METERS) * 0.9;
		return Math.max(0.65, Math.min(1.3, shade));
	}
}

function clamp255(v: number): number {
	return Math.max(0, Math.min(255, Math.round(v)));
}
