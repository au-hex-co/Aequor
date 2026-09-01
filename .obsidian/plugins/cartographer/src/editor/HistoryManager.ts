import { CartographerMapData } from "../model/types";
import { TerrainGridListener } from "../model/TerrainGrid";

type Layer = "height" | "terrain" | "detail";

interface ChunkChange {
	layer: Layer;
	chunkX: number;
	chunkY: number;
	value: unknown; // deep-cloned chunk array, or undefined if the chunk didn't exist yet
}

const MAX_HISTORY_ENTRIES = 100;

// One undo/redo entry = one paint stroke, potentially spanning several
// chunks. Snapshots only the specific chunks a stroke actually touches (via
// TerrainGrid's write-listener hooks), captured once per chunk per layer
// right before its first mutation that stroke — so memory cost tracks
// edited area, not total map size, matching the rest of the plugin's
// "no cap, but don't scale with the whole world" approach.
export class HistoryManager implements TerrainGridListener {
	private undoStack: ChunkChange[][] = [];
	private redoStack: ChunkChange[][] = [];
	private currentStroke: Map<string, ChunkChange> | null = null;

	constructor(private data: CartographerMapData) {}

	beginStroke(): void {
		this.currentStroke = new Map();
	}

	endStroke(): void {
		if (!this.currentStroke) return;
		if (this.currentStroke.size > 0) {
			this.undoStack.push(Array.from(this.currentStroke.values()));
			if (this.undoStack.length > MAX_HISTORY_ENTRIES) this.undoStack.shift();
			this.redoStack = [];
		}
		this.currentStroke = null;
	}

	beforeHeightWrite(chunkX: number, chunkY: number): void {
		this.captureBefore("height", chunkX, chunkY, this.data.heightChunks);
	}

	beforeTerrainWrite(chunkX: number, chunkY: number): void {
		this.captureBefore("terrain", chunkX, chunkY, this.data.terrainChunks);
	}

	beforeDetailWrite(chunkX: number, chunkY: number): void {
		this.captureBefore("detail", chunkX, chunkY, this.data.detailChunks);
	}

	canUndo(): boolean {
		return this.undoStack.length > 0;
	}

	canRedo(): boolean {
		return this.redoStack.length > 0;
	}

	// Returns the set of chunk coordinates touched, so the caller can
	// invalidate just those chunks' cached render bitmaps.
	undo(): { chunkX: number; chunkY: number }[] | null {
		const entry = this.undoStack.pop();
		if (!entry) return null;
		const redoEntry = entry.map((change) => this.applyAndCaptureInverse(change));
		this.redoStack.push(redoEntry);
		return entry.map(({ chunkX, chunkY }) => ({ chunkX, chunkY }));
	}

	redo(): { chunkX: number; chunkY: number }[] | null {
		const entry = this.redoStack.pop();
		if (!entry) return null;
		const undoEntry = entry.map((change) => this.applyAndCaptureInverse(change));
		this.undoStack.push(undoEntry);
		return entry.map(({ chunkX, chunkY }) => ({ chunkX, chunkY }));
	}

	private captureBefore(layer: Layer, chunkX: number, chunkY: number, chunks: Record<string, unknown>): void {
		if (!this.currentStroke) return;
		const key = `${layer}:${chunkX},${chunkY}`;
		if (this.currentStroke.has(key)) return;
		const existing = chunks[`${chunkX},${chunkY}`];
		this.currentStroke.set(key, {
			layer,
			chunkX,
			chunkY,
			value: existing === undefined ? undefined : (existing as number[] | (string | null)[]).slice(),
		});
	}

	// Writes `change.value` into the data, returning a ChunkChange that
	// captures what was there immediately before — used to build the
	// opposite stack (undo produces a redo entry, and vice versa).
	private applyAndCaptureInverse(change: ChunkChange): ChunkChange {
		const chunks = this.chunksFor(change.layer);
		const key = `${change.chunkX},${change.chunkY}`;
		const previous = chunks[key];
		const inverse: ChunkChange = {
			layer: change.layer,
			chunkX: change.chunkX,
			chunkY: change.chunkY,
			value: previous === undefined ? undefined : (previous as number[] | (string | null)[]).slice(),
		};

		if (change.value === undefined) {
			delete chunks[key];
		} else {
			chunks[key] = change.value as never;
		}

		return inverse;
	}

	private chunksFor(layer: Layer): Record<string, unknown> {
		if (layer === "height") return this.data.heightChunks as unknown as Record<string, unknown>;
		if (layer === "terrain") return this.data.terrainChunks as unknown as Record<string, unknown>;
		return this.data.detailChunks as unknown as Record<string, unknown>;
	}
}
