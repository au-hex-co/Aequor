import { Camera } from "./CanvasViewport";

// Converts a world-space pixel coordinate to the map's real-world meter
// scale — shared by the ruler and the hover readout so both always agree.
export function worldToMeters(worldPx: number, cellSize: number, metersPerCell: number): number {
	return (worldPx / cellSize) * metersPerCell;
}

export interface HoverWorldPoint {
	wx: number;
	wy: number;
}

const RULER_SIZE = 24;
const MIN_TICK_SPACING_PX = 90;
const NICE_STEPS = [1, 2, 5];

// Picks a round 1-2-5 step (in meters) so ruler ticks land on numbers like
// 10m/20m/50m/100m instead of whatever the zoom level happens to produce —
// the same convention CAD/3D viewport rulers (Fusion 360, Blender) use.
function niceStep(targetMeters: number): number {
	if (!(targetMeters > 0)) return 1;
	const magnitude = Math.pow(10, Math.floor(Math.log10(targetMeters)));
	for (const n of NICE_STEPS) {
		const step = n * magnitude;
		if (step >= targetMeters) return step;
	}
	return 10 * magnitude;
}

function formatMeters(m: number): string {
	const rounded = Math.round(m);
	if (Math.abs(rounded) >= 1000) {
		const km = rounded / 1000;
		return `${km % 1 === 0 ? km : km.toFixed(1)}km`;
	}
	return `${rounded}m`;
}

// Viewport chrome: sparse ruler bars along the top (X) and left (Y) edges
// with round-number tick labels, plus bold chunk-boundary lines and a
// Blender-style red/green origin cross — instead of a coordinate label
// crammed at every chunk corner, which turns to noise on a large map. When
// a hover point is given, dashed guide lines drop from it straight to each
// ruler with a highlighted readout, the same "smart guide" convention most
// design/CAD tools use to call out a point's exact position.
export function drawCoordinateOverlay(
	ctx: CanvasRenderingContext2D,
	camera: Camera,
	viewW: number,
	viewH: number,
	cellSize: number,
	chunkSize: number,
	metersPerCell: number,
	hover?: HoverWorldPoint | null
): void {
	const chunkWorldSize = cellSize * chunkSize;
	const worldMinX = camera.x;
	const worldMinY = camera.y;
	const worldMaxX = camera.x + viewW / camera.zoom;
	const worldMaxY = camera.y + viewH / camera.zoom;

	const toScreenX = (wx: number) => (wx - camera.x) * camera.zoom;
	const toScreenY = (wy: number) => (wy - camera.y) * camera.zoom;

	ctx.save();

	// Fine cell gridlines — only once cells are large enough on screen to be
	// worth showing, so a zoomed-out huge map doesn't turn to noise.
	const cellScreenSize = cellSize * camera.zoom;
	if (cellScreenSize > 6) {
		const startCx = Math.floor(worldMinX / cellSize);
		const endCx = Math.ceil(worldMaxX / cellSize);
		const startCy = Math.floor(worldMinY / cellSize);
		const endCy = Math.ceil(worldMaxY / cellSize);

		ctx.strokeStyle = "rgba(255, 255, 255, 0.10)";
		ctx.lineWidth = 1;
		ctx.beginPath();
		for (let cx = startCx; cx <= endCx; cx++) {
			const x = Math.round(toScreenX(cx * cellSize)) + 0.5;
			ctx.moveTo(x, 0);
			ctx.lineTo(x, viewH);
		}
		for (let cy = startCy; cy <= endCy; cy++) {
			const y = Math.round(toScreenY(cy * cellSize)) + 0.5;
			ctx.moveTo(0, y);
			ctx.lineTo(viewW, y);
		}
		ctx.stroke();
	}

	// Chunk-boundary "segmentation" lines — always shown, bolder than the
	// cell grid but subtler than before now that the rulers carry the actual
	// coordinate numbers.
	const startChunkX = Math.floor(worldMinX / chunkWorldSize);
	const endChunkX = Math.ceil(worldMaxX / chunkWorldSize);
	const startChunkY = Math.floor(worldMinY / chunkWorldSize);
	const endChunkY = Math.ceil(worldMaxY / chunkWorldSize);

	ctx.strokeStyle = "rgba(255, 196, 64, 0.35)";
	ctx.lineWidth = 1;
	ctx.beginPath();
	for (let cx = startChunkX; cx <= endChunkX; cx++) {
		const x = Math.round(toScreenX(cx * chunkWorldSize)) + 0.5;
		ctx.moveTo(x, 0);
		ctx.lineTo(x, viewH);
	}
	for (let cy = startChunkY; cy <= endChunkY; cy++) {
		const y = Math.round(toScreenY(cy * chunkWorldSize)) + 0.5;
		ctx.moveTo(0, y);
		ctx.lineTo(viewW, y);
	}
	ctx.stroke();

	// Origin axis lines — Blender-style red X / green Y through the world
	// origin, so "where is 0,0" reads at a glance without a label.
	if (worldMinX <= 0 && 0 <= worldMaxX) {
		const x = Math.round(toScreenX(0)) + 0.5;
		ctx.strokeStyle = "rgba(224, 90, 90, 0.55)";
		ctx.lineWidth = 1;
		ctx.beginPath();
		ctx.moveTo(x, 0);
		ctx.lineTo(x, viewH);
		ctx.stroke();
	}
	if (worldMinY <= 0 && 0 <= worldMaxY) {
		const y = Math.round(toScreenY(0)) + 0.5;
		ctx.strokeStyle = "rgba(96, 200, 120, 0.55)";
		ctx.lineWidth = 1;
		ctx.beginPath();
		ctx.moveTo(0, y);
		ctx.lineTo(viewW, y);
		ctx.stroke();
	}

	// Hover drop-guides — dashed lines from the cursor to each ruler, drawn
	// before the ruler bars so the bars paint cleanly over their ends.
	if (hover) {
		const sx = toScreenX(hover.wx);
		const sy = toScreenY(hover.wy);
		ctx.setLineDash([4, 4]);
		ctx.strokeStyle = "rgba(255, 255, 255, 0.45)";
		ctx.lineWidth = 1;
		ctx.beginPath();
		ctx.moveTo(sx + 0.5, 0);
		ctx.lineTo(sx + 0.5, viewH);
		ctx.moveTo(0, sy + 0.5);
		ctx.lineTo(viewW, sy + 0.5);
		ctx.stroke();
		ctx.setLineDash([]);
	}

	// Ruler bars — the scale for the whole viewport, spaced to a legible
	// round-number step rather than one label per chunk corner.
	const worldPerMeter = cellSize / metersPerCell;
	const metersPerScreenPx = 1 / (worldPerMeter * camera.zoom);
	const step = niceStep(MIN_TICK_SPACING_PX * metersPerScreenPx);
	const stepWorld = step * worldPerMeter;

	ctx.fillStyle = "rgba(20, 20, 24, 0.72)";
	ctx.fillRect(0, 0, viewW, RULER_SIZE);
	ctx.fillRect(0, 0, RULER_SIZE, viewH);

	ctx.strokeStyle = "rgba(255, 255, 255, 0.35)";
	ctx.lineWidth = 1;
	ctx.font = "10px var(--font-monospace, monospace)";
	ctx.fillStyle = "rgba(230, 230, 235, 0.85)";
	ctx.textBaseline = "middle";
	ctx.textAlign = "left";

	const firstX = Math.floor(worldMinX / stepWorld) * stepWorld;
	for (let wx = firstX; wx <= worldMaxX; wx += stepWorld) {
		const sx = Math.round(toScreenX(wx)) + 0.5;
		if (sx < RULER_SIZE) continue;
		ctx.beginPath();
		ctx.moveTo(sx, RULER_SIZE - 6);
		ctx.lineTo(sx, RULER_SIZE);
		ctx.stroke();
		ctx.fillText(formatMeters(worldToMeters(wx, cellSize, metersPerCell)), sx + 3, RULER_SIZE / 2);
	}

	const firstY = Math.floor(worldMinY / stepWorld) * stepWorld;
	for (let wy = firstY; wy <= worldMaxY; wy += stepWorld) {
		const sy = Math.round(toScreenY(wy)) + 0.5;
		if (sy < RULER_SIZE) continue;
		ctx.beginPath();
		ctx.moveTo(RULER_SIZE - 6, sy);
		ctx.lineTo(RULER_SIZE, sy);
		ctx.stroke();
		ctx.save();
		ctx.translate(RULER_SIZE / 2, sy);
		ctx.rotate(-Math.PI / 2);
		ctx.textAlign = "center";
		ctx.fillText(formatMeters(worldToMeters(wy, cellSize, metersPerCell)), 0, 0);
		ctx.restore();
	}

	// Hover readout pills — the exact coordinate under the cursor, highlighted
	// on top of each ruler like a design tool's smart guide.
	if (hover) {
		const sx = Math.round(toScreenX(hover.wx));
		const sy = Math.round(toScreenY(hover.wy));
		const mx = formatMeters(worldToMeters(hover.wx, cellSize, metersPerCell));
		const my = formatMeters(worldToMeters(hover.wy, cellSize, metersPerCell));

		ctx.font = "11px var(--font-monospace, monospace)";

		if (sx >= RULER_SIZE) {
			const w = ctx.measureText(mx).width + 10;
			ctx.fillStyle = "rgba(255, 196, 64, 0.95)";
			ctx.fillRect(sx - w / 2, 1, w, RULER_SIZE - 2);
			ctx.fillStyle = "rgba(20, 20, 24, 0.95)";
			ctx.textAlign = "center";
			ctx.fillText(mx, sx, RULER_SIZE / 2);
		}
		if (sy >= RULER_SIZE) {
			const h = 14;
			ctx.fillStyle = "rgba(255, 196, 64, 0.95)";
			ctx.fillRect(1, sy - h / 2, RULER_SIZE - 2, h);
			ctx.save();
			ctx.translate(RULER_SIZE / 2, sy);
			ctx.rotate(-Math.PI / 2);
			ctx.fillStyle = "rgba(20, 20, 24, 0.95)";
			ctx.textAlign = "center";
			ctx.fillText(my, 0, 0);
			ctx.restore();
		}
	}

	// Corner square where the two rulers meet.
	ctx.fillStyle = "rgba(20, 20, 24, 0.85)";
	ctx.fillRect(0, 0, RULER_SIZE, RULER_SIZE);

	ctx.restore();
}
