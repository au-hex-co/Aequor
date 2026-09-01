import { CartographerMapData, DEFAULT_DETAIL, DetailChunk, HeightChunk, TerrainChunk, TerrainType, chunkKey } from "./types";

// Notified just before a chunk in a given layer is about to be created or
// mutated, with the chunk's coordinates — lets a history/undo tracker
// capture a "before" snapshot without TerrainGrid needing to know anything
// about undo itself. Fired unconditionally on every write; the listener is
// responsible for deduping (e.g. "already captured this chunk this stroke").
export interface TerrainGridListener {
	beforeHeightWrite(chunkX: number, chunkY: number): void;
	beforeTerrainWrite(chunkX: number, chunkY: number): void;
	beforeDetailWrite(chunkX: number, chunkY: number): void;
}

// Absolute-coordinate accessor over the three sparse chunk maps (height,
// terrain, detail — kept independent, see the note on CartographerMapData).
// Cell coordinates are unbounded integers (can be negative) — there is no
// fixed grid extent. Reads never allocate; writes lazily create the chunk
// they land in, in whichever layer was actually written.
export class TerrainGrid {
	listener: TerrainGridListener | null = null;

	constructor(private data: CartographerMapData) {}

	get chunkSize(): number {
		return this.data.chunkSize;
	}

	private cellToChunk(cx: number, cy: number): { chunkX: number; chunkY: number; localX: number; localY: number } {
		const size = this.data.chunkSize;
		const chunkX = Math.floor(cx / size);
		const chunkY = Math.floor(cy / size);
		return { chunkX, chunkY, localX: cx - chunkX * size, localY: cy - chunkY * size };
	}

	hasHeightChunk(chunkX: number, chunkY: number): boolean {
		return this.data.heightChunks[chunkKey(chunkX, chunkY)] !== undefined;
	}

	hasTerrainChunk(chunkX: number, chunkY: number): boolean {
		return this.data.terrainChunks[chunkKey(chunkX, chunkY)] !== undefined;
	}

	getHeight(cx: number, cy: number): number {
		const { chunkX, chunkY, localX, localY } = this.cellToChunk(cx, cy);
		const chunk = this.data.heightChunks[chunkKey(chunkX, chunkY)];
		if (!chunk) return 0;
		return chunk[localY * this.data.chunkSize + localX];
	}

	// Height is stored in real-world meters, unbounded in either direction —
	// if a map wants a 10km mountain, that's a legitimate value, not a bug.
	setHeight(cx: number, cy: number, value: number): void {
		const { chunkX, chunkY, localX, localY } = this.cellToChunk(cx, cy);
		const chunk = this.getOrCreateHeightChunk(chunkX, chunkY);
		chunk[localY * this.data.chunkSize + localX] = value;
	}

	addHeight(cx: number, cy: number, delta: number): void {
		this.setHeight(cx, cy, this.getHeight(cx, cy) + delta);
	}

	blendHeight(cx: number, cy: number, target: number, amount: number): void {
		const current = this.getHeight(cx, cy);
		this.setHeight(cx, cy, current + (target - current) * amount);
	}

	getTerrain(cx: number, cy: number): TerrainType | null {
		const { chunkX, chunkY, localX, localY } = this.cellToChunk(cx, cy);
		const chunk = this.data.terrainChunks[chunkKey(chunkX, chunkY)];
		if (!chunk) return null;
		return chunk[localY * this.data.chunkSize + localX];
	}

	setTerrain(cx: number, cy: number, type: TerrainType | null): void {
		const { chunkX, chunkY, localX, localY } = this.cellToChunk(cx, cy);
		const chunk = this.getOrCreateTerrainChunk(chunkX, chunkY);
		chunk[localY * this.data.chunkSize + localX] = type;
	}

	getDetail(cx: number, cy: number): number {
		const { chunkX, chunkY, localX, localY } = this.cellToChunk(cx, cy);
		const chunk = this.data.detailChunks[chunkKey(chunkX, chunkY)];
		if (!chunk) return DEFAULT_DETAIL;
		return chunk[localY * this.data.chunkSize + localX];
	}

	setDetail(cx: number, cy: number, value: number): void {
		const { chunkX, chunkY, localX, localY } = this.cellToChunk(cx, cy);
		const chunk = this.getOrCreateDetailChunk(chunkX, chunkY);
		chunk[localY * this.data.chunkSize + localX] = Math.max(0, Math.min(1, value));
	}

	blendDetail(cx: number, cy: number, target: number, amount: number): void {
		const current = this.getDetail(cx, cy);
		this.setDetail(cx, cy, current + (target - current) * amount);
	}

	// Bilinear-sampled height at fractional cell coordinates, used by the
	// oblique Land Viewer projection and by brush falloff calculations.
	sampleHeight(fx: number, fy: number): number {
		const x0 = Math.floor(fx);
		const y0 = Math.floor(fy);
		const tx = fx - x0;
		const ty = fy - y0;

		const h00 = this.getHeight(x0, y0);
		const h10 = this.getHeight(x0 + 1, y0);
		const h01 = this.getHeight(x0, y0 + 1);
		const h11 = this.getHeight(x0 + 1, y0 + 1);

		const top = h00 + (h10 - h00) * tx;
		const bottom = h01 + (h11 - h01) * tx;
		return top + (bottom - top) * ty;
	}

	private getOrCreateHeightChunk(chunkX: number, chunkY: number): HeightChunk {
		this.listener?.beforeHeightWrite(chunkX, chunkY);
		const key = chunkKey(chunkX, chunkY);
		let chunk = this.data.heightChunks[key];
		if (!chunk) {
			chunk = new Array(this.data.chunkSize * this.data.chunkSize).fill(0);
			this.data.heightChunks[key] = chunk;
		}
		return chunk;
	}

	private getOrCreateTerrainChunk(chunkX: number, chunkY: number): TerrainChunk {
		this.listener?.beforeTerrainWrite(chunkX, chunkY);
		const key = chunkKey(chunkX, chunkY);
		let chunk = this.data.terrainChunks[key];
		if (!chunk) {
			chunk = new Array(this.data.chunkSize * this.data.chunkSize).fill(null);
			this.data.terrainChunks[key] = chunk;
		}
		return chunk;
	}

	private getOrCreateDetailChunk(chunkX: number, chunkY: number): DetailChunk {
		this.listener?.beforeDetailWrite(chunkX, chunkY);
		const key = chunkKey(chunkX, chunkY);
		let chunk = this.data.detailChunks[key];
		if (!chunk) {
			chunk = new Array(this.data.chunkSize * this.data.chunkSize).fill(DEFAULT_DETAIL);
			this.data.detailChunks[key] = chunk;
		}
		return chunk;
	}
}
