import { CartographerMapData, PropData, TerrainChunk } from "../model/types";
import { TerrainGrid } from "../model/TerrainGrid";
import { ChunkedGridRenderer } from "./ChunkedGridRenderer";
import { EMPTY_CELL_COLOR, HILLSHADE_REFERENCE_METERS, MOUNTAIN_START, bandedTerrainColor, hexToRgb, roadBaseColor, roadLaneCount, roadStyleFromDetail } from "./palette";
import { hashSeed, mulberry32 } from "./prng";
import { fbm2D } from "./noise";
import { Camera } from "./CanvasViewport";

// How strongly slope affects brightness, and the clamp range so shading
// stays a relief cue rather than blowing out to pure black/white.
const SHADE_STRENGTH = 0.9;
const MIN_SHADE = 0.65;
const MAX_SHADE = 1.3;

// Reads terrain type from its own chunk map but also consults the
// (independently sparse) height and detail layers per cell — height for
// elevation banding + hillshading, detail for how dense a forest/plains
// cell's vegetation is and how developed a road is. True geometric
// displacement (tall cells pushing into neighboring screen space) is the
// Land Viewer's job, not this one — this view has to keep cells at fixed
// screen positions so click-to-paint stays accurate.
export class TerrainRenderer extends ChunkedGridRenderer<TerrainChunk> {
	private grid: TerrainGrid;

	constructor(data: CartographerMapData) {
		super(data);
		this.grid = new TerrainGrid(data);
	}

	protected getChunkMap(): Record<string, TerrainChunk> {
		return this.data.terrainChunks;
	}

	protected cellColor(chunk: TerrainChunk, localIndex: number, chunkX: number, chunkY: number): [number, number, number] {
		const type = chunk[localIndex];
		if (!type) return hexToRgb(EMPTY_CELL_COLOR);

		const { cx, cy } = this.absoluteCell(localIndex, chunkX, chunkY);
		const height = this.grid.getHeight(cx, cy);
		const shade = this.hillshade(cx, cy);

		const [r, g, b] = type === "road" ? roadBaseColor(this.grid.getDetail(cx, cy)) : bandedTerrainColor(type, height);
		return [clamp255(r * shade), clamp255(g * shade), clamp255(b * shade)];
	}

	protected emptyColor(): string {
		return EMPTY_CELL_COLOR;
	}

	protected decorate(ctx: CanvasRenderingContext2D, chunk: TerrainChunk, chunkX: number, chunkY: number, pxPerCell: number): void {
		for (let localIndex = 0; localIndex < chunk.length; localIndex++) {
			const type = chunk[localIndex];
			if (!type) continue;

			const { cx, cy, localX, localY } = this.absoluteCell(localIndex, chunkX, chunkY);
			const originX = localX * pxPerCell;
			const originY = localY * pxPerCell;

			switch (type) {
				case "forest":
					this.drawTrees(ctx, cx, cy, originX, originY, pxPerCell);
					break;
				case "plains":
					this.drawGrass(ctx, cx, cy, originX, originY, pxPerCell);
					break;
				case "road":
					this.drawRoadDetail(ctx, cx, cy, originX, originY, pxPerCell);
					break;
				case "mountain":
					this.drawRock(ctx, cx, cy, originX, originY, pxPerCell);
					break;
				case "sand":
					this.drawPebbles(ctx, cx, cy, originX, originY, pxPerCell);
					break;
				case "river":
					this.drawFlow(ctx, cx, cy, originX, originY, pxPerCell);
					break;
				case "water":
					this.drawRipple(ctx, cx, cy, originX, originY, pxPerCell);
					break;
				case "snow":
					this.drawSnowTexture(ctx, cx, cy, originX, originY, pxPerCell);
					break;
			}
		}
	}

	// Nothing about a tree is stored beyond this cell's density/height — its
	// height in meters, canopy size, and layering are all derived right here
	// from a deterministic per-cell hash, the same way every decoration in
	// this renderer regenerates from the sparse chunk data instead of being
	// saved itself.
	private drawTrees(ctx: CanvasRenderingContext2D, cx: number, cy: number, originX: number, originY: number, pxPerCell: number): void {
		const density = this.grid.getDetail(cx, cy);
		const height = this.grid.getHeight(cx, cy);
		const rng = mulberry32(hashSeed(cx, cy, 1337));

		// Treeline taper: thin out and shrink gradually over the 15m below
		// MOUNTAIN_START instead of stopping dead at the threshold.
		const taper = clamp01(1 - Math.max(0, height - (MOUNTAIN_START - 15)) / 15);
		if (taper <= 0.02) return;
		const treeCount = Math.round((1 + density * 5) * taper);

		for (let i = 0; i < treeCount; i++) {
			const tx = originX + rng() * pxPerCell;
			const ty = originY + rng() * pxPerCell;

			const treeHeightM = (4 + density * 14 + rng() * 6) * (0.5 + taper * 0.5);
			const canopyR = pxPerCell * (0.1 + Math.min(treeHeightM / 40, 0.28));
			const trunkLen = canopyR * 0.9;
			const tone = 0.7 + rng() * 0.45;

			ctx.strokeStyle = `rgb(${Math.round(66 * tone)}, ${Math.round(47 * tone)}, ${Math.round(32 * tone)})`;
			ctx.lineWidth = Math.max(1, canopyR * 0.18);
			ctx.beginPath();
			ctx.moveTo(tx, ty + canopyR * 0.25);
			ctx.lineTo(tx, ty + canopyR * 0.25 + trunkLen);
			ctx.stroke();

			// Two or three vertically-offset canopy blobs read as foliage
			// depth instead of one flat disc — taller trees get a third layer.
			const layers = treeHeightM > 12 ? 3 : 2;
			for (let l = 0; l < layers; l++) {
				const lt = layers > 1 ? l / (layers - 1) : 0;
				const lr = canopyR * (1 - lt * 0.35);
				const ly = ty - lt * canopyR * 0.55;
				const lx = tx + (rng() - 0.5) * canopyR * 0.3;

				ctx.beginPath();
				ctx.fillStyle = `rgb(${Math.round((24 + lt * 8) * tone)}, ${Math.round((66 + lt * 14) * tone)}, ${Math.round((30 + lt * 6) * tone)})`;
				ctx.arc(lx, ly, lr, 0, Math.PI * 2);
				ctx.fill();
			}
		}
	}

	// Plains texture: blade count and length scale with density, blades
	// curve and lean toward a shared low-frequency wind direction (instead
	// of leaning randomly per blade) so a whole patch reads as wind moving
	// across it, and a couple of muted tones keep it from looking flat.
	private drawGrass(ctx: CanvasRenderingContext2D, cx: number, cy: number, originX: number, originY: number, pxPerCell: number): void {
		const density = this.grid.getDetail(cx, cy);
		if (density < 0.08) return;

		const rng = mulberry32(hashSeed(cx, cy, 4242));
		const bladeCount = Math.round(density * 10);
		const bladeHeight = pxPerCell * (0.12 + density * 0.22);
		const windAngle = (fbm2D(cx * 0.04, cy * 0.04, 7001, 2) - 0.5) * Math.PI * 0.9;

		ctx.lineWidth = Math.max(1, pxPerCell * 0.04);
		for (let i = 0; i < bladeCount; i++) {
			const bx = originX + rng() * pxPerCell;
			const by = originY + rng() * pxPerCell;
			const jitter = (rng() - 0.5) * 0.4;
			const lean = Math.sin(windAngle + jitter) * bladeHeight * 0.6;
			const tone = 0.75 + rng() * 0.4;
			const warmth = rng() * 0.3;

			ctx.strokeStyle = `rgb(${Math.round((62 + warmth * 40) * tone)}, ${Math.round((118 + warmth * 8) * tone)}, ${Math.round(50 * tone)})`;
			ctx.beginPath();
			ctx.moveTo(bx, by);
			ctx.quadraticCurveTo(bx + lean * 0.5, by - bladeHeight * 0.55, bx + lean, by - bladeHeight);
			ctx.stroke();
		}

		if (density > 0.6) {
			const shrubCount = 1 + Math.floor(((density - 0.6) / 0.4) * 2);
			for (let i = 0; i < shrubCount; i++) {
				const sx = originX + rng() * pxPerCell;
				const sy = originY + rng() * pxPerCell;
				const radius = pxPerCell * (0.12 + rng() * 0.08);

				ctx.beginPath();
				ctx.fillStyle = "rgb(58, 96, 48)";
				ctx.arc(sx, sy, radius, 0, Math.PI * 2);
				ctx.fill();
			}
		}
	}

	// Scree speckle plus the occasional boulder — density (painted as
	// "ruggedness" for this brush) controls both how much fine speckle and
	// how many boulders a cell gets.
	private drawRock(ctx: CanvasRenderingContext2D, cx: number, cy: number, originX: number, originY: number, pxPerCell: number): void {
		const roughness = this.grid.getDetail(cx, cy);
		const rng = mulberry32(hashSeed(cx, cy, 5151));

		const speckleCount = Math.round(5 + roughness * 9);
		for (let i = 0; i < speckleCount; i++) {
			const px = originX + rng() * pxPerCell;
			const py = originY + rng() * pxPerCell;
			const r = pxPerCell * (0.025 + rng() * 0.045);
			const tone = 0.55 + rng() * 0.55;
			ctx.beginPath();
			ctx.fillStyle = `rgba(${Math.round(92 * tone)}, ${Math.round(84 * tone)}, ${Math.round(74 * tone)}, 0.55)`;
			ctx.arc(px, py, r, 0, Math.PI * 2);
			ctx.fill();
		}

		if (roughness > 0.3) {
			const boulderCount = 1 + Math.floor(roughness * 2);
			for (let i = 0; i < boulderCount; i++) {
				const bx = originX + rng() * pxPerCell;
				const by = originY + rng() * pxPerCell;
				const r = pxPerCell * (0.11 + rng() * 0.1);
				const tone = 0.6 + rng() * 0.3;

				ctx.beginPath();
				ctx.fillStyle = "rgba(35, 30, 24, 0.22)";
				ctx.ellipse(bx + r * 0.18, by + r * 0.22, r * 0.95, r * 0.4, 0, 0, Math.PI * 2);
				ctx.fill();

				ctx.beginPath();
				ctx.fillStyle = `rgb(${Math.round(122 * tone)}, ${Math.round(113 * tone)}, ${Math.round(101 * tone)})`;
				ctx.ellipse(bx, by, r, r * (0.72 + rng() * 0.25), rng() * Math.PI, 0, Math.PI * 2);
				ctx.fill();
			}
		}
	}

	// Sand's own decoration — plain sand had none before. Small scattered
	// pebbles, each with a tiny highlight so they read as rounded stones
	// rather than flat dots.
	private drawPebbles(ctx: CanvasRenderingContext2D, cx: number, cy: number, originX: number, originY: number, pxPerCell: number): void {
		const density = this.grid.getDetail(cx, cy);
		if (density < 0.05) return;

		const rng = mulberry32(hashSeed(cx, cy, 7373));
		const count = Math.round(2 + density * 7);

		for (let i = 0; i < count; i++) {
			const px = originX + rng() * pxPerCell;
			const py = originY + rng() * pxPerCell;
			const r = pxPerCell * (0.035 + rng() * 0.05);
			const tone = 0.6 + rng() * 0.4;
			const angle = rng() * Math.PI;

			ctx.save();
			ctx.translate(px, py);
			ctx.rotate(angle);
			ctx.beginPath();
			ctx.fillStyle = `rgb(${Math.round(152 * tone)}, ${Math.round(138 * tone)}, ${Math.round(112 * tone)})`;
			ctx.ellipse(0, 0, r, r * (0.6 + rng() * 0.3), 0, 0, Math.PI * 2);
			ctx.fill();
			ctx.beginPath();
			ctx.fillStyle = `rgba(255, 255, 255, ${0.15 + rng() * 0.15})`;
			ctx.ellipse(-r * 0.25, -r * 0.25, r * 0.35, r * 0.2, 0, 0, Math.PI * 2);
			ctx.fill();
			ctx.restore();
		}
	}

	// River's flow direction is never stored either — it's read straight off
	// the live height gradient (steepest descent) each time a chunk repaints,
	// the same neighbor-sampling trick hillshade() below already uses. Flat
	// stretches (no clear downhill neighbor) fall back to a noise-derived
	// meander so the streaks don't all snap to one axis at a confluence.
	private drawFlow(ctx: CanvasRenderingContext2D, cx: number, cy: number, originX: number, originY: number, pxPerCell: number): void {
		const gx = this.grid.getHeight(cx + 1, cy) - this.grid.getHeight(cx - 1, cy);
		const gy = this.grid.getHeight(cx, cy + 1) - this.grid.getHeight(cx, cy - 1);
		const mag = Math.hypot(gx, gy);
		const angle = mag > 0.015 ? Math.atan2(gy, gx) : fbm2D(cx * 0.15, cy * 0.15, 9001, 2) * Math.PI * 2;

		const rng = mulberry32(hashSeed(cx, cy, 6262));
		const streakCount = 2 + Math.floor(rng() * 2);

		ctx.strokeStyle = "rgba(255, 255, 255, 0.32)";
		ctx.lineWidth = Math.max(1, pxPerCell * 0.035);
		for (let i = 0; i < streakCount; i++) {
			const ox = originX + pxPerCell * (0.2 + rng() * 0.6);
			const oy = originY + pxPerCell * (0.2 + rng() * 0.6);
			const len = pxPerCell * (0.28 + rng() * 0.22);
			const dx = Math.cos(angle) * len;
			const dy = Math.sin(angle) * len;

			ctx.beginPath();
			ctx.moveTo(ox - dx / 2, oy - dy / 2);
			ctx.lineTo(ox + dx / 2, oy + dy / 2);
			ctx.stroke();
		}
	}

	// Still water: sparse, gently curved ripples oriented by a slow noise
	// field rather than a real current, since open water has no single
	// downhill direction the way a river channel does.
	private drawRipple(ctx: CanvasRenderingContext2D, cx: number, cy: number, originX: number, originY: number, pxPerCell: number): void {
		const rng = mulberry32(hashSeed(cx, cy, 8181));
		if (rng() > 0.5) return;

		const angle = fbm2D(cx * 0.08, cy * 0.08, 4321, 3) * Math.PI * 2;
		const midX = originX + pxPerCell * 0.5;
		const midY = originY + pxPerCell * 0.5;
		const len = pxPerCell * 0.4;
		const dx = Math.cos(angle) * len * 0.5;
		const dy = Math.sin(angle) * len * 0.5;

		ctx.strokeStyle = "rgba(255, 255, 255, 0.16)";
		ctx.lineWidth = Math.max(1, pxPerCell * 0.03);
		ctx.beginPath();
		ctx.moveTo(midX - dx, midY - dy);
		ctx.quadraticCurveTo(midX - dy * 0.3, midY - pxPerCell * 0.08, midX + dx, midY + dy);
		ctx.stroke();
	}

	// Manually-painted snow: a scatter of bright sparkle points plus, where
	// coverage is thinner, faint cold-shadow dapples so a lightly-painted
	// patch reads as dusted rather than a flat white fill.
	private drawSnowTexture(ctx: CanvasRenderingContext2D, cx: number, cy: number, originX: number, originY: number, pxPerCell: number): void {
		const coverage = this.grid.getDetail(cx, cy);
		const rng = mulberry32(hashSeed(cx, cy, 3131));

		const sparkles = Math.round(3 + rng() * 5);
		for (let i = 0; i < sparkles; i++) {
			const px = originX + rng() * pxPerCell;
			const py = originY + rng() * pxPerCell;
			ctx.beginPath();
			ctx.fillStyle = `rgba(255, 255, 255, ${0.4 + rng() * 0.4})`;
			ctx.arc(px, py, pxPerCell * 0.02, 0, Math.PI * 2);
			ctx.fill();
		}

		if (coverage < 0.7) {
			const n = fbm2D(cx * 0.2, cy * 0.2, 2020, 3);
			if (n > 0.55) {
				ctx.beginPath();
				ctx.fillStyle = "rgba(150, 170, 190, 0.18)";
				ctx.ellipse(originX + pxPerCell * 0.5, originY + pxPerCell * 0.5, pxPerCell * 0.35, pxPerCell * 0.22, n * Math.PI, 0, Math.PI * 2);
				ctx.fill();
			}
		}
	}

	// Dirt: no extra texture beyond the base tint. Cobblestone: stippled
	// dots. Paved: dashed lane-divider lines, drawn along whichever axis the
	// road's neighbors suggest it runs — skipped for isolated/diagonal
	// cells since there's no sensible direction to draw them along.
	private drawRoadDetail(ctx: CanvasRenderingContext2D, cx: number, cy: number, originX: number, originY: number, pxPerCell: number): void {
		const detail = this.grid.getDetail(cx, cy);
		const style = roadStyleFromDetail(detail);

		if (style === "cobblestone") {
			const rng = mulberry32(hashSeed(cx, cy, 909));
			for (let i = 0; i < 10; i++) {
				const px = originX + rng() * pxPerCell;
				const py = originY + rng() * pxPerCell;
				const tone = 0.8 + rng() * 0.35;
				ctx.fillStyle = `rgba(${Math.round(150 * tone)}, ${Math.round(150 * tone)}, ${Math.round(150 * tone)}, 0.5)`;
				ctx.beginPath();
				ctx.arc(px, py, pxPerCell * 0.06, 0, Math.PI * 2);
				ctx.fill();
			}
			return;
		}

		if (style !== "paved") return;

		const north = this.grid.getTerrain(cx, cy - 1) === "road";
		const south = this.grid.getTerrain(cx, cy + 1) === "road";
		const east = this.grid.getTerrain(cx + 1, cy) === "road";
		const west = this.grid.getTerrain(cx - 1, cy) === "road";
		const vertical = (north || south) && !(east || west);
		const horizontal = (east || west) && !(north || south);
		if (!vertical && !horizontal) return;

		const lanes = roadLaneCount(detail);
		ctx.strokeStyle = "rgba(255, 255, 255, 0.75)";
		ctx.lineWidth = Math.max(1, pxPerCell * 0.05);
		ctx.setLineDash([pxPerCell * 0.18, pxPerCell * 0.14]);

		for (let lane = 1; lane < lanes; lane++) {
			const t = lane / lanes;
			ctx.beginPath();
			if (vertical) {
				const x = originX + pxPerCell * t;
				ctx.moveTo(x, originY);
				ctx.lineTo(x, originY + pxPerCell);
			} else {
				const y = originY + pxPerCell * t;
				ctx.moveTo(originX, y);
				ctx.lineTo(originX + pxPerCell, y);
			}
			ctx.stroke();
		}
		ctx.setLineDash([]);
	}

	private absoluteCell(localIndex: number, chunkX: number, chunkY: number): { cx: number; cy: number; localX: number; localY: number } {
		const size = this.data.chunkSize;
		const localX = localIndex % size;
		const localY = Math.floor(localIndex / size);
		return { cx: chunkX * size + localX, cy: chunkY * size + localY, localX, localY };
	}

	// Light-from-upper-left directional shading derived from the height
	// gradient: slopes facing the light brighten, slopes facing away darken.
	private hillshade(cx: number, cy: number): number {
		const gx = this.grid.getHeight(cx + 1, cy) - this.grid.getHeight(cx - 1, cy);
		const gy = this.grid.getHeight(cx, cy + 1) - this.grid.getHeight(cx, cy - 1);
		const shade = 1 - ((gx + gy) / HILLSHADE_REFERENCE_METERS) * SHADE_STRENGTH;
		return Math.max(MIN_SHADE, Math.min(MAX_SHADE, shade));
	}

	// Props (a hand-placed massive tree, an artifact marker) aren't part of
	// any chunk's cell data, so they're not covered by the chunk bitmap
	// cache above — drawn fresh on top every frame instead, straight from
	// the sparse data.props list. Cheap: a map has a handful of these, not
	// thousands.
	draw(ctx: CanvasRenderingContext2D, camera: Camera, viewW: number, viewH: number): void {
		super.draw(ctx, camera, viewW, viewH);
		const cellSize = this.data.cellSize;
		for (const prop of this.data.props ?? []) {
			const wx = prop.x * cellSize;
			const wy = prop.y * cellSize;
			if (prop.type === "massive-tree") this.drawMassiveTree(ctx, wx, wy, prop, cellSize);
			else if (prop.type === "artifact") this.drawArtifact(ctx, wx, wy, prop, cellSize);
		}
	}

	// A landmark tree: same trunk + layered-canopy idea as the procedural
	// forest trees above, just bigger and drawn once at an exact point
	// instead of scattered per-cell — a root flare and a soft ground shadow
	// earn the extra draw call a single named tree deserves.
	private drawMassiveTree(ctx: CanvasRenderingContext2D, wx: number, wy: number, prop: PropData, cellSize: number): void {
		const rng = mulberry32(hashSeed(Math.round(prop.x * 4), Math.round(prop.y * 4), prop.seed || 1));
		const heightM = Math.max(20, prop.scale);
		const canopyR = cellSize * (0.9 + Math.min(heightM / 45, 2.2));
		const trunkLen = canopyR * 1.1;
		const trunkW = Math.max(2, canopyR * 0.12);

		ctx.beginPath();
		ctx.fillStyle = "rgba(20, 16, 10, 0.28)";
		ctx.ellipse(wx, wy + canopyR * 0.15, canopyR * 0.85, canopyR * 0.32, 0, 0, Math.PI * 2);
		ctx.fill();

		ctx.beginPath();
		ctx.fillStyle = "rgba(58, 40, 26, 0.9)";
		ctx.ellipse(wx, wy + canopyR * 0.1, trunkW * 1.8, trunkW * 0.7, 0, 0, Math.PI * 2);
		ctx.fill();

		ctx.strokeStyle = "rgb(64, 45, 30)";
		ctx.lineWidth = trunkW;
		ctx.beginPath();
		ctx.moveTo(wx, wy);
		ctx.lineTo(wx, wy - trunkLen);
		ctx.stroke();

		const layers = 5;
		for (let l = 0; l < layers; l++) {
			const lt = l / (layers - 1);
			const lr = canopyR * (1 - lt * 0.45);
			const ly = wy - trunkLen - lt * canopyR * 0.7;
			const lx = wx + (rng() - 0.5) * canopyR * 0.4;
			const tone = 0.75 + rng() * 0.3;

			ctx.beginPath();
			ctx.fillStyle = `rgb(${Math.round((26 + lt * 10) * tone)}, ${Math.round((70 + lt * 16) * tone)}, ${Math.round((32 + lt * 8) * tone)})`;
			ctx.arc(lx, ly, lr, 0, Math.PI * 2);
			ctx.fill();
		}

		if (prop.name) {
			ctx.font = `${Math.max(10, cellSize * 0.9)}px sans-serif`;
			ctx.textAlign = "center";
			ctx.fillStyle = "rgba(30, 24, 16, 0.85)";
			ctx.fillText(prop.name, wx, wy + canopyR * 0.55);
		}
	}

	// A placed artifact: a faceted gem over a soft radial glow, with a few
	// rune ticks around it so it reads as "notable" at a glance next to
	// ordinary terrain decoration.
	private drawArtifact(ctx: CanvasRenderingContext2D, wx: number, wy: number, prop: PropData, cellSize: number): void {
		const rng = mulberry32(hashSeed(Math.round(prop.x * 4), Math.round(prop.y * 4), prop.seed || 1));
		const size = cellSize * (0.6 + Math.max(0, Math.min(1, prop.scale)) * 1.4);

		const glow = ctx.createRadialGradient(wx, wy, 0, wx, wy, size * 2.2);
		glow.addColorStop(0, "rgba(255, 224, 140, 0.55)");
		glow.addColorStop(1, "rgba(255, 224, 140, 0)");
		ctx.fillStyle = glow;
		ctx.beginPath();
		ctx.arc(wx, wy, size * 2.2, 0, Math.PI * 2);
		ctx.fill();

		ctx.save();
		ctx.translate(wx, wy);
		ctx.beginPath();
		ctx.moveTo(0, -size);
		ctx.lineTo(size * 0.7, 0);
		ctx.lineTo(0, size);
		ctx.lineTo(-size * 0.7, 0);
		ctx.closePath();
		ctx.fillStyle = "rgb(196, 148, 62)";
		ctx.fill();
		ctx.beginPath();
		ctx.moveTo(0, -size);
		ctx.lineTo(size * 0.7, 0);
		ctx.lineTo(0, 0);
		ctx.closePath();
		ctx.fillStyle = "rgba(255, 235, 190, 0.55)";
		ctx.fill();
		ctx.restore();

		const tickCount = 6;
		ctx.strokeStyle = "rgba(196, 148, 62, 0.5)";
		ctx.lineWidth = Math.max(1, size * 0.06);
		for (let i = 0; i < tickCount; i++) {
			const angle = (i / tickCount) * Math.PI * 2 + rng() * 0.15;
			const r1 = size * 1.6;
			const r2 = size * 1.85;
			ctx.beginPath();
			ctx.moveTo(wx + Math.cos(angle) * r1, wy + Math.sin(angle) * r1);
			ctx.lineTo(wx + Math.cos(angle) * r2, wy + Math.sin(angle) * r2);
			ctx.stroke();
		}

		if (prop.name) {
			ctx.font = `${Math.max(10, cellSize * 0.9)}px sans-serif`;
			ctx.textAlign = "center";
			ctx.fillStyle = "rgba(60, 44, 16, 0.85)";
			ctx.fillText(prop.name, wx, wy + size * 2.4);
		}
	}
}

function clamp255(v: number): number {
	return Math.max(0, Math.min(255, Math.round(v)));
}

function clamp01(v: number): number {
	return Math.max(0, Math.min(1, v));
}
