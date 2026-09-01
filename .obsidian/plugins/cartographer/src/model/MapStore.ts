import { App, Notice, TFile, normalizePath } from "obsidian";
import {
	CARTOGRAPHER_FORMAT_VERSION,
	CHUNK_COUNT_WARNING_THRESHOLD,
	CartographerMapData,
	DEFAULT_METERS_PER_CELL,
	createDefaultMapData,
} from "./types";
import { MAP_FILE_EXTENSION } from "../constants";

export class MapStore {
	constructor(private app: App) {}

	async createMap(folder: string, name: string, metersPerCell?: number): Promise<TFile> {
		const data = createDefaultMapData(name, metersPerCell);

		const folderPath = folder.trim();
		if (folderPath && !this.app.vault.getAbstractFileByPath(folderPath)) {
			await this.app.vault.createFolder(folderPath);
		}

		const path = normalizePath(`${folderPath ? folderPath + "/" : ""}${name}.${MAP_FILE_EXTENSION}`);
		if (this.app.vault.getAbstractFileByPath(path)) {
			throw new Error(`A map already exists at ${path}`);
		}

		return await this.app.vault.create(path, JSON.stringify(data, null, "\t"));
	}

	async load(file: TFile): Promise<CartographerMapData> {
		const raw = await this.app.vault.read(file);
		const parsed = JSON.parse(raw) as CartographerMapData;
		return migrate(parsed);
	}

	async save(file: TFile, data: CartographerMapData): Promise<void> {
		this.warnIfLarge(data);
		await this.app.vault.modify(file, JSON.stringify(data, null, "\t"));
	}

	listMapFiles(): TFile[] {
		return this.app.vault
			.getFiles()
			.filter((f) => f.path.endsWith(`.${MAP_FILE_EXTENSION}`));
	}

	private lastWarnedAt = new WeakMap<CartographerMapData, number>();

	private warnIfLarge(data: CartographerMapData): void {
		const count = new Set([...Object.keys(data.heightChunks), ...Object.keys(data.terrainChunks)]).size;
		if (count < CHUNK_COUNT_WARNING_THRESHOLD) return;

		// Only re-notify every ~500 chunks past the threshold so this doesn't
		// spam a Notice on every autosave while painting near the boundary.
		const last = this.lastWarnedAt.get(data) ?? 0;
		if (count - last < 500) return;
		this.lastWarnedAt.set(data, count);

		new Notice(
			`Cartographer: this map now has ${count.toLocaleString()} painted chunks — the file is getting large. Rendering stays fast (only visible chunks draw), but saves/loads may slow down.`,
			8000
		);
	}
}

function migrate(data: CartographerMapData): CartographerMapData {
	if (data.version !== CARTOGRAPHER_FORMAT_VERSION) {
		// v1 maps used a fixed dense width/height grid; that format is dropped
		// in favor of the chunked infinite grid, so old maps can't be carried
		// over — start fresh rather than guess at a lossy conversion.
		return createDefaultMapData(data.name ?? "Untitled");
	}
	// metersPerCell and detailChunks were added after some v3 files already
	// existed — backfill rather than forcing another reset for purely
	// additive fields.
	if (data.metersPerCell === undefined) {
		data.metersPerCell = DEFAULT_METERS_PER_CELL;
	}
	if (data.detailChunks === undefined) {
		data.detailChunks = {};
	}
	if (data.props === undefined) {
		data.props = [];
	}
	return data;
}
