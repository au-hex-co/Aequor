import { Camera } from "./CanvasViewport";

// Converts a world-space pixel coordinate to the map's real-world meter
// scale — shared by the grid overlay's corner labels and the hover readout
// so both always agree.
export function worldToMeters(worldPx: number, cellSize: number, metersPerCell: number): number {
	return (worldPx / cellSize) * metersPerCell;
}

function formatMeters(m: number): string {
	return `${Math.round(m)}m`;
}

// Coordinate + chunk-boundary overlay: bold "segmentation" lines at chunk
// edges with the real-world (meter) coordinate labeled at each corner, plus
// fine cell gridlines once zoomed in enough to be legible. Since both maps
// share the same meters-per-cell scale convention, two separately-painted
// maps can be lined up like jigsaw pieces by matching numbers at the edges
// rather than eyeballing it.
export function drawCoordinateOverlay(
	ctx: CanvasRenderingContext2D,
	camera: Camera,
	viewW: number,
	viewH: number,
	cellSize: number,
	chunkSize: number,
	metersPerCell: number
): void {
	const chunkWorldSize = cellSize * chunkSize;
	const worldMinX = camera.x;
	const worldMinY = camera.y;
	const worldMaxX = camera.x + viewW / camera.zoom;
	const worldMaxY = camera.y + viewH / camera.zoom;

	const toScreenX = (wx: number) => (wx - camera.x) * camera.zoom;
	const toScreenY = (wy: number) => (wy - camera.y) * camera.zoom;

	ctx.save();

	// Fine cell gridlines — only drawn once cells are large enough on screen
	// to be worth showing, so a zoomed-out huge map doesn't turn to noise.
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

	// Chunk-boundary "segmentation" lines — always shown, bolder.
	const startChunkX = Math.floor(worldMinX / chunkWorldSize);
	const endChunkX = Math.ceil(worldMaxX / chunkWorldSize);
	const startChunkY = Math.floor(worldMinY / chunkWorldSize);
	const endChunkY = Math.ceil(worldMaxY / chunkWorldSize);

	ctx.strokeStyle = "rgba(255, 196, 64, 0.55)";
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

	// Absolute cell-coordinate label at each visible chunk corner.
	ctx.font = "11px var(--font-monospace, monospace)";
	ctx.textBaseline = "top";
	ctx.fillStyle = "rgba(255, 224, 140, 0.95)";
	for (let cy = startChunkY; cy <= endChunkY; cy++) {
		for (let cx = startChunkX; cx <= endChunkX; cx++) {
			const sx = toScreenX(cx * chunkWorldSize) + 3;
			const sy = toScreenY(cy * chunkWorldSize) + 2;
			if (sx < -80 || sx > viewW || sy < -16 || sy > viewH) continue;
			const mx = worldToMeters(cx * chunkWorldSize, cellSize, metersPerCell);
			const my = worldToMeters(cy * chunkWorldSize, cellSize, metersPerCell);
			ctx.fillText(`${formatMeters(mx)}, ${formatMeters(my)}`, sx, sy);
		}
	}

	ctx.restore();
}
