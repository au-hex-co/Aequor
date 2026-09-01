import { Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { MAP_FILE_EXTENSION, TERRAIN_VIEW_TYPE } from "./constants";
import { TerrainView } from "./views/TerrainView";
import { MapStore } from "./model/MapStore";
import { NewMapModal } from "./ui/NewMapModal";
import { OpenMapModal } from "./ui/OpenMapModal";

export default class CartographerPlugin extends Plugin {
	mapStore!: MapStore;

	async onload(): Promise<void> {
		this.mapStore = new MapStore(this.app);

		this.registerView(TERRAIN_VIEW_TYPE, (leaf) => new TerrainView(leaf, this));
		this.registerExtensions([MAP_FILE_EXTENSION], TERRAIN_VIEW_TYPE);

		this.addRibbonIcon("map", "Open Cartographer", () => {
			this.activateTerrainView();
		});

		this.addCommand({
			id: "open-terrain-view",
			name: "Open terrain editor",
			callback: () => this.activateTerrainView(),
		});

		this.addCommand({
			id: "create-new-map",
			name: "Create new map",
			callback: () => this.createNewMap(),
		});

		this.addCommand({
			id: "open-map",
			name: "Open map…",
			callback: () => this.openMapPicker(),
		});

		// checkCallback reports "unavailable" whenever a Cartographer view
		// isn't the active leaf, so Ctrl+Z/Ctrl+Y fall through to Obsidian's
		// normal editor undo/redo everywhere else instead of being hijacked.
		this.addCommand({
			id: "undo-paint",
			name: "Undo terrain edit",
			hotkeys: [{ modifiers: ["Mod"], key: "z" }],
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(TerrainView);
				if (!view || !view.canUndo()) return false;
				if (!checking) view.undo();
				return true;
			},
		});

		this.addCommand({
			id: "redo-paint",
			name: "Redo terrain edit",
			hotkeys: [{ modifiers: ["Mod"], key: "y" }],
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(TerrainView);
				if (!view || !view.canRedo()) return false;
				if (!checking) view.redo();
				return true;
			},
		});
	}

	async onunload(): Promise<void> {
		this.app.workspace.detachLeavesOfType(TERRAIN_VIEW_TYPE);
	}

	async createNewMap(): Promise<void> {
		new NewMapModal(this.app, async (options) => {
			try {
				const file = await this.mapStore.createMap(options.folder, options.name, options.metersPerCell);
				await this.openMapInView(file);
			} catch (err) {
				new Notice(`Cartographer: ${(err as Error).message}`);
			}
		}).open();
	}

	openMapPicker(): void {
		const files = this.mapStore.listMapFiles();
		if (files.length === 0) {
			new Notice("Cartographer: no maps found in this vault yet. Create one first.");
			return;
		}
		new OpenMapModal(this.app, files, (file) => this.openMapInView(file)).open();
	}

	async openMapInView(file: TFile): Promise<void> {
		const leaf = await this.activateTerrainView();
		await leaf.openFile(file, { active: true });
	}

	private async activateTerrainView(): Promise<WorkspaceLeaf> {
		const { workspace } = this.app;

		const existing = workspace.getLeavesOfType(TERRAIN_VIEW_TYPE);
		let leaf: WorkspaceLeaf;

		if (existing.length > 0) {
			leaf = existing[0];
		} else {
			leaf = workspace.getLeaf("tab");
			await leaf.setViewState({ type: TERRAIN_VIEW_TYPE, active: true });
		}

		workspace.revealLeaf(leaf);
		return leaf;
	}
}
