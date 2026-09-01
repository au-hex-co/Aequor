import { CartographerMapData, chunkKey } from "../model/types";
import { Camera } from "./CanvasViewport";

// Shared draw loop for both the Terrain and Heightmap renderers: only
// chunks intersecting the camera's current view are painted or blitted, so
// cost tracks visible area, not total painted area — the piece that makes
// an unbounded, ever-expandable grid actually render at any scale. Each
// chunk is rasterized once into its own small bitmap and cached; a brush
// stroke invalidates just the chunks it touched.
//
// Generic over TChunk so each subclass reads its own independent chunk map
// (heightChunks or terrainChunks) — a renderer never needs the other
// layer's data, matching how TerrainGrid stores them separately.
export abstract class ChunkedGridRenderer<TChunk> {
	private chunkBitmaps = new Map<string, HTMLCanvasElement>();

	constructor(protected data: CartographerMapData) {}

	protected abstract getChunkMap(): Record<string, TChunk>;
	protected abstract cellColor(chunk: TChunk, localIndex: number, chunkX: number, chunkY: number): [number, number, number];
	protected abstract emptyColor(): string;

	// Optional second pass drawn with the normal 2D canvas API (arcs, paths)
	// on top of the already-committed per-cell pixel fill — e.g. procedural
	// tree canopies. No-op by default.
	protected decorate(_ctx: CanvasRenderingContext2D, _chunk: TChunk, _chunkX: number, _chunkY: number, _pxPerCell: number): void {
		// intentionally empty
	}

	invalidateCellRect(minCx: number, minCy: number, maxCx: number, maxCy: number): void {
		const size = this.data.chunkSize;
		const minChunkX = Math.floor(minCx / size);
		const maxChunkX = Math.floor(maxCx / size);
		const minChunkY = Math.floor(minCy / size);
		const maxChunkY = Math.floor(maxCy / size);
		for (let cy = minChunkY; cy <= maxChunkY; cy++) {
			for (let cx = minChunkX; cx <= maxChunkX; cx++) {
				this.chunkBitmaps.delete(chunkKey(cx, cy));
			}
		}
	}

	invalidateAll(): void {
		this.chunkBitmaps.clear();
	}

	draw(ctx: CanvasRenderingContext2D, camera: Camera, viewW: number, viewH: number): void {
		const chunkWorldSize = this.data.chunkSize * this.data.cellSize;
		const worldMinX = camera.x;
		const worldMinY = camera.y;
		const worldMaxX = camera.x + viewW / camera.zoom;
		const worldMaxY = camera.y + viewH / camera.zoom;

		const minChunkX = Math.floor(worldMinX / chunkWorldSize) - 1;
		const maxChunkX = Math.floor(worldMaxX / chunkWorldSize) + 1;
		const minChunkY = Math.floor(worldMinY / chunkWorldSize) - 1;
		const maxChunkY = Math.floor(worldMaxY / chunkWorldSize) + 1;

		const chunkMap = this.getChunkMap();

		for (let cy = minChunkY; cy <= maxChunkY; cy++) {
			for (let cx = minChunkX; cx <= maxChunkX; cx++) {
				const worldX = cx * chunkWorldSize;
				const worldY = cy * chunkWorldSize;
				const chunk = chunkMap[chunkKey(cx, cy)];

				if (chunk) {
					const bmp = this.getOrPaintChunk(cx, cy, chunk);
					ctx.drawImage(bmp, worldX, worldY, chunkWorldSize, chunkWorldSize);
				} else {
					ctx.fillStyle = this.emptyColor();
					ctx.fillRect(worldX, worldY, chunkWorldSize, chunkWorldSize);
				}
			}
		}
	}

	private getOrPaintChunk(chunkX: number, chunkY: number, chunk: TChunk): HTMLCanvasElement {
		const key = chunkKey(chunkX, chunkY);
		const cached = this.chunkBitmaps.get(key);
		if (cached) return cached;

		const size = this.data.chunkSize;
		const pxPerCell = this.data.cellSize;
		const bmp = document.createElement("canvas");
		bmp.width = size * pxPerCell;
		bmp.height = size * pxPerCell;

		const ctx = bmp.getContext("2d");
		if (ctx) {
			const imageData = ctx.createImageData(bmp.width, bmp.height);
			const pixels = imageData.data;

			for (let ly = 0; ly < size; ly++) {
				for (let lx = 0; lx < size; lx++) {
					const [r, g, b] = this.cellColor(chunk, ly * size + lx, chunkX, chunkY);
					for (let py = 0; py < pxPerCell; py++) {
						const rowStart = ((ly * pxPerCell + py) * bmp.width + lx * pxPerCell) * 4;
						for (let px = 0; px < pxPerCell; px++) {
							const offset = rowStart + px * 4;
							pixels[offset] = r;
							pixels[offset + 1] = g;
							pixels[offset + 2] = b;
							pixels[offset + 3] = 255;
						}
					}
				}
			}

			ctx.putImageData(imageData, 0, 0);
			this.decorate(ctx, chunk, chunkX, chunkY, pxPerCell);
		}

		this.chunkBitmaps.set(key, bmp);
		return bmp;
	}
}
