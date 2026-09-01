import { FileView, TFile, WorkspaceLeaf } from "obsidian";
import { TERRAIN_VIEW_TYPE } from "../constants";
import { CartographerMapData, ViewModeId, computePaintedChunkBounds } from "../model/types";
import { TerrainGrid } from "../model/TerrainGrid";
import { HeightmapRenderer } from "../rendering/HeightmapRenderer";
import { TerrainRenderer } from "../rendering/TerrainRenderer";
import { LandViewerRenderer } from "../rendering/LandViewerRenderer";
import { Land3DView } from "../rendering/Land3DView";
import { CanvasViewport } from "../rendering/CanvasViewport";
import { drawCoordinateOverlay, worldToMeters } from "../rendering/GridOverlay";
import { BrushEngine, DEFAULT_BRUSH } from "../editor/BrushEngine";
import { CellRect } from "../editor/CellRect";
import { BrushToolbar } from "../editor/BrushToolbar";
import { HeightBrushEngine, DEFAULT_HEIGHT_BRUSH } from "../editor/HeightBrushEngine";
import { HeightBrushToolbar } from "../editor/HeightBrushToolbar";
import { HistoryManager } from "../editor/HistoryManager";
import { Land3DPaintMode } from "../rendering/Land3DView";
import { PropData, PropType } from "../model/types";
import type CartographerPlugin from "../main";

const VIEW_MODES: { id: ViewModeId; label: string; implemented: boolean }[] = [
	{ id: "terrain-editor", label: "Terrain Editor", implemented: true },
	{ id: "terrain-viewer", label: "Terrain Viewer", implemented: false },
	{ id: "heightmap-viewer", label: "Heightmap", implemented: true },
	{ id: "land-viewer", label: "Land Viewer", implemented: true },
	{ id: "3d-viewer", label: "3D View", implemented: true },
];

const SAVE_DEBOUNCE_MS = 900;
const SHIMMER_INTERVAL_MS = 150;

// World-space padding shown around a brand-new, unpainted map so there's a
// framed area to start painting in instead of an unbounded blank void.
const STARTER_CHUNK_RADIUS = 2;

// Extends FileView (not plain ItemView) so double-clicking a .cartomap file
// in the File Explorer opens it directly — Obsidian routes registered
// extensions (see main.ts's registerExtensions call) through onLoadFile.
export class TerrainView extends FileView {
	private data: CartographerMapData | null = null;
	private grid: TerrainGrid | null = null;
	private viewMode: ViewModeId = "terrain-editor";

	private statusEl: HTMLElement | null = null;
	private modeButtons = new Map<ViewModeId, HTMLButtonElement>();

	private viewport: CanvasViewport | null = null;
	private land3DView: Land3DView | null = null;
	private brushEngine: BrushEngine = new BrushEngine({ ...DEFAULT_BRUSH });
	private heightBrushEngine: HeightBrushEngine = new HeightBrushEngine({ ...DEFAULT_HEIGHT_BRUSH });
	private history: HistoryManager | null = null;
	private activeRenderer: { invalidateCellRect(minCx: number, minCy: number, maxCx: number, maxCy: number): void } | null = null;
	private showGridOverlay = true;
	private showHoverCoords = true;
	private hoverReadoutEl: HTMLElement | null = null;
	// Tracked independently of showHoverCoords — the ruler drop-guides drawn
	// by drawCoordinateOverlay follow the cursor whenever the grid overlay is
	// on, regardless of whether the small DOM readout pill is toggled.
	private hoverWorld: { wx: number; wy: number } | null = null;
	// When set, the next canvas click drops a landmark prop instead of
	// starting a brush stroke — see wirePainting()'s onPointerDown.
	private placingProp: PropType | null = null;
	private propButtons = new Map<PropType, HTMLButtonElement>();

	// What left-drag does in the 3D View — persists across "Rebuild 3D"
	// clicks (which tear down and recreate Land3DView) so the user doesn't
	// have to reselect Sculpt/Paint every time.
	private threeDMode: Land3DPaintMode = "navigate";
	private threeDModeButtons = new Map<Land3DPaintMode, HTMLButtonElement>();
	private threeDHeightHost: HTMLElement | null = null;
	private threeDTerrainHost: HTMLElement | null = null;

	private saveTimer: number | null = null;
	private landViewerTimer: number | null = null;
	private painting = false;

	constructor(leaf: WorkspaceLeaf, private plugin: CartographerPlugin) {
		super(leaf);
		// The ribbon icon / "Open terrain editor" command opens this view with
		// no file yet (shows the New/Open buttons) — FileView normally assumes
		// a file is always attached, so this opts out of that assumption.
		this.allowNoFile = true;
	}

	getViewType(): string {
		return TERRAIN_VIEW_TYPE;
	}

	getIcon(): string {
		return "map";
	}

	canAcceptExtension(extension: string): boolean {
		return extension === "cartomap";
	}

	async onOpen(): Promise<void> {
		this.renderShell();
	}

	async onLoadFile(file: TFile): Promise<void> {
		this.data = await this.plugin.mapStore.load(file);
		this.grid = new TerrainGrid(this.data);
		this.history = new HistoryManager(this.data);
		this.grid.listener = this.history;
		this.viewMode = this.data.viewMode ?? "terrain-editor";
		this.renderShell();
	}

	canUndo(): boolean {
		return this.history?.canUndo() ?? false;
	}

	canRedo(): boolean {
		return this.history?.canRedo() ?? false;
	}

	undo(): void {
		const touched = this.history?.undo();
		this.afterHistoryChange(touched);
	}

	redo(): void {
		const touched = this.history?.redo();
		this.afterHistoryChange(touched);
	}

	private afterHistoryChange(touched: { chunkX: number; chunkY: number }[] | null | undefined): void {
		if (!touched || touched.length === 0 || !this.data || !this.activeRenderer || !this.viewport) return;
		const size = this.data.chunkSize;
		for (const { chunkX, chunkY } of touched) {
			this.activeRenderer.invalidateCellRect(chunkX * size, chunkY * size, chunkX * size + size - 1, chunkY * size + size - 1);
		}
		this.updateStatus();
		this.viewport.scheduleDraw();
		this.scheduleSave();
	}

	async onUnloadFile(): Promise<void> {
		await this.flushSave();
	}

	async onClose(): Promise<void> {
		await this.flushSave();
		this.stopLandViewerAnimation();
		this.viewport?.destroy();
		this.viewport = null;
		this.land3DView?.dispose();
		this.land3DView = null;
		this.contentEl.empty();
	}

	private stopLandViewerAnimation(): void {
		if (this.landViewerTimer !== null) {
			window.clearInterval(this.landViewerTimer);
			this.landViewerTimer = null;
		}
	}

	private renderShell(): void {
		this.stopLandViewerAnimation();
		this.viewport?.destroy();
		this.viewport = null;
		this.land3DView?.dispose();
		this.land3DView = null;
		this.hoverReadoutEl = null;

		const container = this.contentEl;
		container.empty();
		container.addClass("cartographer-terrain-view");

		if (!this.file || !this.data || !this.grid) {
			this.renderEmptyState(container);
			return;
		}

		const toolbar = container.createDiv({ cls: "cartographer-toolbar" });
		toolbar.createEl("span", { cls: "cartographer-map-name", text: this.data.name });

		const modeRow = toolbar.createDiv({ cls: "cartographer-mode-row" });
		this.modeButtons.clear();
		for (const mode of VIEW_MODES) {
			const btn = modeRow.createEl("button", {
				cls: "cartographer-mode-btn",
				text: mode.implemented ? mode.label : `${mode.label} (soon)`,
			});
			if (!mode.implemented) btn.disabled = true;
			btn.addEventListener("click", () => this.setViewMode(mode.id));
			this.modeButtons.set(mode.id, btn);
		}

		if (this.viewMode === "3d-viewer") {
			const rebuildBtn = toolbar.createEl("button", { cls: "cartographer-fit-btn", text: "Rebuild 3D" });
			rebuildBtn.addEventListener("click", () => this.renderShell());
		} else {
			const fitBtn = toolbar.createEl("button", { cls: "cartographer-fit-btn", text: "Fit view" });
			fitBtn.addEventListener("click", () => this.fitView());

			const gridBtn = toolbar.createEl("button", { cls: "cartographer-fit-btn", text: "Grid" });
			gridBtn.toggleClass("is-active", this.showGridOverlay);
			gridBtn.addEventListener("click", () => {
				this.showGridOverlay = !this.showGridOverlay;
				gridBtn.toggleClass("is-active", this.showGridOverlay);
				this.applyOverlay();
			});

			const coordsBtn = toolbar.createEl("button", { cls: "cartographer-fit-btn", text: "Coords" });
			coordsBtn.toggleClass("is-active", this.showHoverCoords);
			coordsBtn.addEventListener("click", () => {
				this.showHoverCoords = !this.showHoverCoords;
				coordsBtn.toggleClass("is-active", this.showHoverCoords);
				this.applyHoverCoords();
			});
		}

		this.statusEl = toolbar.createEl("span", { cls: "cartographer-status" });

		if (this.viewMode === "terrain-editor") {
			const brushHost = container.createDiv();
			new BrushToolbar(brushHost, this.brushEngine.getSettings(), {
				onTypeChange: (type) => this.brushEngine.updateSettings({ type }),
				onEraseToggle: (erase) => this.brushEngine.updateSettings({ erase }),
				onRadiusChange: (radius) => this.brushEngine.updateSettings({ radius }),
				onFalloffChange: (falloff) => this.brushEngine.updateSettings({ falloff }),
				onOpacityChange: (opacity) => this.brushEngine.updateSettings({ opacity }),
				onDensityChange: (density) => this.brushEngine.updateSettings({ density }),
			});
			this.renderPropRow(container);
		} else if (this.viewMode === "heightmap-viewer") {
			const brushHost = container.createDiv();
			new HeightBrushToolbar(brushHost, this.heightBrushEngine.getSettings(), {
				onModeChange: (mode) => this.heightBrushEngine.updateSettings({ mode }),
				onRadiusChange: (radius) => this.heightBrushEngine.updateSettings({ radius }),
				onStrengthChange: (strength) => this.heightBrushEngine.updateSettings({ strength }),
				onTargetHeightChange: (targetHeight) => this.heightBrushEngine.updateSettings({ targetHeight }),
			});
		} else if (this.viewMode === "3d-viewer") {
			this.render3DBrushControls(container);
		}

		const canvasWrap = container.createDiv({ cls: "cartographer-canvas-wrap" });

		this.updateActiveModeButton();
		this.updateStatus();

		if (this.viewMode === "3d-viewer") {
			// Three.js owns its own WebGL canvas — bypass the 2D CanvasViewport
			// entirely for this mode.
			this.land3DView = new Land3DView(canvasWrap, this.data, {
				grid: this.grid,
				heightBrushEngine: this.heightBrushEngine,
				brushEngine: this.brushEngine,
				history: this.history,
				onEdit: () => {
					this.updateStatus();
					this.scheduleSave();
				},
			});
			this.land3DView.setPaintMode(this.threeDMode);
		} else {
			this.viewport = new CanvasViewport(canvasWrap);
			this.hoverReadoutEl = canvasWrap.createDiv({ cls: "cartographer-hover-coords" });
			this.setupCurrentMode();
		}
	}

	private renderEmptyState(container: HTMLElement): void {
		const wrap = container.createDiv({ cls: "cartographer-placeholder" });
		wrap.createEl("p", { text: "No map open." });
		const row = wrap.createDiv({ cls: "cartographer-placeholder-actions" });

		const newBtn = row.createEl("button", { text: "New map" });
		newBtn.addEventListener("click", () => this.plugin.createNewMap());

		const openBtn = row.createEl("button", { text: "Open map…" });
		openBtn.addEventListener("click", () => this.plugin.openMapPicker());
	}

	private setViewMode(mode: ViewModeId): void {
		if (!this.data || this.viewMode === mode) return;
		this.viewMode = mode;
		this.data.viewMode = mode;
		this.scheduleSave();
		this.renderShell();
	}

	private updateActiveModeButton(): void {
		for (const [id, btn] of this.modeButtons) {
			btn.toggleClass("is-active", id === this.viewMode);
		}
	}

	private setupCurrentMode(): void {
		if (!this.viewport || !this.data || !this.grid) return;
		this.applyHoverCoords();

		if (this.viewMode === "heightmap-viewer") {
			const renderer = new HeightmapRenderer(this.data);
			this.activeRenderer = renderer;
			this.viewport.setDrawCallback((ctx, camera, viewW, viewH) => renderer.draw(ctx, camera, viewW, viewH));
			this.frameToContent();
			this.applyOverlay();
			this.wireHeightPainting(this.viewport, renderer, this.grid);
		} else if (this.viewMode === "terrain-editor") {
			const renderer = new TerrainRenderer(this.data);
			this.activeRenderer = renderer;
			this.viewport.setDrawCallback((ctx, camera, viewW, viewH) => renderer.draw(ctx, camera, viewW, viewH));
			this.frameToContent();
			this.applyOverlay();
			this.wirePainting(this.viewport, renderer, this.grid);
		} else if (this.viewMode === "land-viewer") {
			const renderer = new LandViewerRenderer(this.data);
			const viewport = this.viewport;
			viewport.setDrawCallback((ctx, camera, viewW, viewH) => renderer.draw(ctx, camera, viewW, viewH));
			this.frameToContent();
			this.applyOverlay();
			// Read-only view (no brush wiring) — only the water shimmer animates.
			this.landViewerTimer = window.setInterval(() => {
				renderer.advanceShimmer();
				viewport.scheduleDraw();
			}, SHIMMER_INTERVAL_MS);
		}
	}

	private applyOverlay(): void {
		if (!this.viewport || !this.data) return;
		const cellSize = this.data.cellSize;
		const chunkSize = this.data.chunkSize;
		const metersPerCell = this.data.metersPerCell;
		this.viewport.setOverlayCallback(
			this.showGridOverlay
				? (ctx, camera, viewW, viewH) =>
						drawCoordinateOverlay(ctx, camera, viewW, viewH, cellSize, chunkSize, metersPerCell, this.hoverWorld)
				: null
		);
	}

	private applyHoverCoords(): void {
		if (!this.viewport || !this.data || !this.hoverReadoutEl) return;
		const cellSize = this.data.cellSize;
		const metersPerCell = this.data.metersPerCell;
		const readout = this.hoverReadoutEl;
		const viewport = this.viewport;

		if (!this.showHoverCoords) readout.hide(); // stays hidden until re-enabled or the pointer re-enters

		viewport.setHoverCallback(
			(wx, wy) => {
				this.hoverWorld = { wx, wy };
				viewport.scheduleDraw(); // repaints the ruler drop-guides every move
				if (!this.showHoverCoords) return;
				const mx = Math.round(worldToMeters(wx, cellSize, metersPerCell));
				const my = Math.round(worldToMeters(wy, cellSize, metersPerCell));
				readout.setText(`${mx}m, ${my}m`);
				readout.show();
			},
			() => {
				this.hoverWorld = null;
				readout.hide();
				viewport.scheduleDraw();
			}
		);
	}

	private frameToContent(): void {
		if (!this.viewport || !this.data) return;
		const bounds = computePaintedChunkBounds(this.data);
		const chunkWorldSize = this.data.chunkSize * this.data.cellSize;

		const rect = bounds
			? {
					minX: bounds.minChunkX * chunkWorldSize,
					minY: bounds.minChunkY * chunkWorldSize,
					maxX: (bounds.maxChunkX + 1) * chunkWorldSize,
					maxY: (bounds.maxChunkY + 1) * chunkWorldSize,
			  }
			: {
					minX: -STARTER_CHUNK_RADIUS * chunkWorldSize,
					minY: -STARTER_CHUNK_RADIUS * chunkWorldSize,
					maxX: STARTER_CHUNK_RADIUS * chunkWorldSize,
					maxY: STARTER_CHUNK_RADIUS * chunkWorldSize,
			  };

		const viewport = this.viewport;
		requestAnimationFrame(() => viewport.fitToRect(rect.minX, rect.minY, rect.maxX, rect.maxY));
	}

	private fitView(): void {
		if (!this.viewport || !this.data) return;
		const bounds = computePaintedChunkBounds(this.data);
		const chunkWorldSize = this.data.chunkSize * this.data.cellSize;
		if (bounds) {
			this.viewport.fitToRect(
				bounds.minChunkX * chunkWorldSize,
				bounds.minChunkY * chunkWorldSize,
				(bounds.maxChunkX + 1) * chunkWorldSize,
				(bounds.maxChunkY + 1) * chunkWorldSize
			);
		} else {
			this.viewport.fitToRect(
				-STARTER_CHUNK_RADIUS * chunkWorldSize,
				-STARTER_CHUNK_RADIUS * chunkWorldSize,
				STARTER_CHUNK_RADIUS * chunkWorldSize,
				STARTER_CHUNK_RADIUS * chunkWorldSize
			);
		}
	}

	private renderPropRow(container: HTMLElement): void {
		const row = container.createDiv({ cls: "cartographer-brush-types" });
		const defs: { id: PropType; label: string }[] = [
			{ id: "massive-tree", label: "Place Massive Tree" },
			{ id: "artifact", label: "Place Artifact" },
		];
		this.propButtons.clear();
		for (const def of defs) {
			const btn = row.createEl("button", { cls: "cartographer-brush-type", text: def.label });
			btn.addEventListener("click", () => {
				this.placingProp = this.placingProp === def.id ? null : def.id;
				this.updatePropButtons();
			});
			this.propButtons.set(def.id, btn);
		}
		this.updatePropButtons();
	}

	private updatePropButtons(): void {
		for (const [id, btn] of this.propButtons) {
			btn.toggleClass("is-active", id === this.placingProp);
		}
	}

	// Navigate/Sculpt/Paint mode row for the 3D View, plus both brush
	// toolbars (height sculpt and terrain paint) sharing the exact same
	// BrushEngine/HeightBrushEngine instances the 2D editors use — settings
	// changed here apply in 2D too, and vice versa. Both toolbars are built
	// once and just shown/hidden, rather than torn down on every mode
	// switch, since switching Navigate/Sculpt/Paint must NOT rebuild
	// Land3DView (that would reset the camera).
	private render3DBrushControls(container: HTMLElement): void {
		const modeRow = container.createDiv({ cls: "cartographer-brush-types" });
		const modes: { id: Land3DPaintMode; label: string }[] = [
			{ id: "navigate", label: "Navigate" },
			{ id: "sculpt", label: "Sculpt" },
			{ id: "paint", label: "Paint" },
		];
		this.threeDModeButtons.clear();
		for (const mode of modes) {
			const btn = modeRow.createEl("button", { cls: "cartographer-brush-type", text: mode.label });
			btn.addEventListener("click", () => this.setThreeDMode(mode.id));
			this.threeDModeButtons.set(mode.id, btn);
		}

		const hint = container.createEl("span", { cls: "cartographer-status", text: "WASD to fly, Space/Shift for up/down, hold Ctrl to move faster." });
		hint.style.padding = "0 0.75em";

		this.threeDHeightHost = container.createDiv();
		new HeightBrushToolbar(this.threeDHeightHost, this.heightBrushEngine.getSettings(), {
			onModeChange: (mode) => this.heightBrushEngine.updateSettings({ mode }),
			onRadiusChange: (radius) => this.heightBrushEngine.updateSettings({ radius }),
			onStrengthChange: (strength) => this.heightBrushEngine.updateSettings({ strength }),
			onTargetHeightChange: (targetHeight) => this.heightBrushEngine.updateSettings({ targetHeight }),
		});

		this.threeDTerrainHost = container.createDiv();
		new BrushToolbar(this.threeDTerrainHost, this.brushEngine.getSettings(), {
			onTypeChange: (type) => this.brushEngine.updateSettings({ type }),
			onEraseToggle: (erase) => this.brushEngine.updateSettings({ erase }),
			onRadiusChange: (radius) => this.brushEngine.updateSettings({ radius }),
			onFalloffChange: (falloff) => this.brushEngine.updateSettings({ falloff }),
			onOpacityChange: (opacity) => this.brushEngine.updateSettings({ opacity }),
			onDensityChange: (density) => this.brushEngine.updateSettings({ density }),
		});

		this.updateThreeDModeUI();
	}

	private setThreeDMode(mode: Land3DPaintMode): void {
		this.threeDMode = mode;
		this.land3DView?.setPaintMode(mode);
		this.updateThreeDModeUI();
	}

	private updateThreeDModeUI(): void {
		for (const [id, btn] of this.threeDModeButtons) {
			btn.toggleClass("is-active", id === this.threeDMode);
		}
		if (this.threeDMode === "sculpt") {
			this.threeDHeightHost?.show();
			this.threeDTerrainHost?.hide();
		} else if (this.threeDMode === "paint") {
			this.threeDHeightHost?.hide();
			this.threeDTerrainHost?.show();
		} else {
			this.threeDHeightHost?.hide();
			this.threeDTerrainHost?.hide();
		}
	}

	// A prop is placed once per click, not stroked like terrain — it isn't
	// chunk-cached (see TerrainRenderer.draw's prop pass), so there's no
	// invalidation to do, just push the data and ask for a redraw.
	private placeProp(type: PropType, fx: number, fy: number, viewport: CanvasViewport): void {
		if (!this.data) return;
		const isTree = type === "massive-tree";
		const prop: PropData = {
			id: `prop-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
			x: fx,
			y: fy,
			type,
			seed: Math.floor(Math.random() * 1e9),
			scale: isTree ? 30 + Math.random() * 20 : 0.6 + Math.random() * 0.4,
			name: isTree ? "Massive Tree" : "Artifact",
		};
		this.data.props.push(prop);
		this.placingProp = null;
		this.updatePropButtons();
		viewport.scheduleDraw();
		this.updateStatus();
		this.scheduleSave();
	}

	private wirePainting(viewport: CanvasViewport, renderer: TerrainRenderer, grid: TerrainGrid): void {
		const cellSize = this.data?.cellSize ?? 1;
		const toCell = (wx: number, wy: number) => ({ fx: wx / cellSize, fy: wy / cellSize });

		viewport.setInteractionHandlers({
			onPointerDown: (wx, wy) => {
				const { fx, fy } = toCell(wx, wy);
				if (this.placingProp) {
					this.placeProp(this.placingProp, fx, fy, viewport);
					return;
				}
				this.painting = true;
				this.history?.beginStroke();
				const dirty = this.brushEngine.startStroke(grid, fx, fy);
				this.invalidateShaded(renderer, dirty);
				viewport.scheduleDraw();
			},
			onPointerMove: (wx, wy) => {
				if (!this.painting) return;
				const { fx, fy } = toCell(wx, wy);
				const dirty = this.brushEngine.continueStroke(grid, fx, fy);
				if (dirty) this.invalidateShaded(renderer, dirty);
				viewport.scheduleDraw();
			},
			onPointerUp: () => {
				if (!this.painting || !this.data) return;
				this.painting = false;
				this.brushEngine.endStroke(this.data);
				this.history?.endStroke();
				this.updateStatus();
				this.scheduleSave();
			},
		});
	}

	// Hillshading reads each cell's neighbors, so a stroke near a chunk
	// boundary can change shading in the adjacent chunk too even though no
	// cell inside it was painted. Pad the invalidation by one cell so that
	// chunk's cache gets dropped and repainted as well.
	private invalidateShaded(renderer: TerrainRenderer, dirty: CellRect): void {
		renderer.invalidateCellRect(dirty.minCx - 1, dirty.minCy - 1, dirty.maxCx + 1, dirty.maxCy + 1);
	}

	private wireHeightPainting(viewport: CanvasViewport, renderer: HeightmapRenderer, grid: TerrainGrid): void {
		const cellSize = this.data?.cellSize ?? 1;
		const toCell = (wx: number, wy: number) => ({ fx: wx / cellSize, fy: wy / cellSize });

		viewport.setInteractionHandlers({
			onPointerDown: (wx, wy) => {
				this.painting = true;
				this.history?.beginStroke();
				const { fx, fy } = toCell(wx, wy);
				const dirty = this.heightBrushEngine.startStroke(grid, fx, fy);
				renderer.invalidateCellRect(dirty.minCx, dirty.minCy, dirty.maxCx, dirty.maxCy);
				viewport.scheduleDraw();
			},
			onPointerMove: (wx, wy) => {
				if (!this.painting) return;
				const { fx, fy } = toCell(wx, wy);
				const dirty = this.heightBrushEngine.continueStroke(grid, fx, fy);
				renderer.invalidateCellRect(dirty.minCx, dirty.minCy, dirty.maxCx, dirty.maxCy);
				viewport.scheduleDraw();
			},
			onPointerUp: () => {
				if (!this.painting) return;
				this.painting = false;
				this.heightBrushEngine.endStroke();
				this.history?.endStroke();
				this.updateStatus();
				this.scheduleSave();
			},
		});
	}

	private updateStatus(): void {
		if (!this.statusEl || !this.data) return;
		const terrainChunks = Object.keys(this.data.terrainChunks).length;
		const heightChunks = Object.keys(this.data.heightChunks).length;
		const propCount = this.data.props?.length ?? 0;
		const propPart = propCount ? ` · ${propCount.toLocaleString()} props` : "";
		this.statusEl.setText(`${terrainChunks.toLocaleString()} terrain chunks · ${heightChunks.toLocaleString()} height chunks${propPart}`);
	}

	private scheduleSave(): void {
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			void this.flushSave();
		}, SAVE_DEBOUNCE_MS);
	}

	private async flushSave(): Promise<void> {
		if (this.saveTimer !== null) {
			window.clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		if (this.file && this.data) {
			await this.plugin.mapStore.save(this.file, this.data);
		}
	}
}
