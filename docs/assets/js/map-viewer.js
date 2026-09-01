// Renders Cartographer .cartomap terrain client-side from chunked JSON
// segments (see site/lib/maps.mjs), fetching only the chunks currently in
// view — mirrors the plugin's own "only touched chunks cost anything"
// model. Color/shading math ported from
// .obsidian/plugins/cartographer/src/rendering/{palette,TerrainRenderer}.ts
// to stay visually faithful to the actual plugin.

(() => {
	"use strict";

	const TERRAIN_COLORS = {
		water: [0x3a, 0x72, 0xb0],
		river: [0x5a, 0xa0, 0xd8],
		sand: [0xd9, 0xc4, 0x8b],
		plains: [0x9a, 0xc3, 0x6c],
		forest: [0x3f, 0x6b, 0x3f],
		road: [0x8a, 0x7a, 0x5c],
		mountain: [0x8f, 0x85, 0x78],
		snow: [0xee, 0xf3, 0xf5],
	};
	const EMPTY_CELL_COLOR = [0xcf, 0xc6, 0xae];
	const HILL_COLOR = [0xa3, 0xa8, 0x6c];
	const MOUNTAIN_COLOR = [0x8a, 0x80, 0x78];
	const SNOW_COLOR = [0xf2, 0xf2, 0xf2];
	const HILL_START = 15, MOUNTAIN_START = 60, SNOW_START = 250, SNOW_FULL = 600;
	const HILLSHADE_REFERENCE_METERS = 8, SHADE_STRENGTH = 0.9, MIN_SHADE = 0.65, MAX_SHADE = 1.3;
	const BANDED = new Set(["plains", "forest", "sand", "mountain"]);
	const ROAD_STYLE_COLORS = { dirt: [0x8a, 0x6a, 0x45], cobblestone: [0x8f, 0x8f, 0x8f], paved: [0x3a, 0x3a, 0x3f] };
	const DEFAULT_DETAIL = 0.5;

	function lerpRgb(a, b, t) {
		const c = Math.max(0, Math.min(1, t));
		return [Math.round(a[0] + (b[0] - a[0]) * c), Math.round(a[1] + (b[1] - a[1]) * c), Math.round(a[2] + (b[2] - a[2]) * c)];
	}

	function bandedTerrainColor(type, height) {
		if (!type) return EMPTY_CELL_COLOR;
		const base = TERRAIN_COLORS[type];
		if (!BANDED.has(type)) return base;
		if (height < HILL_START) return base;
		if (height < MOUNTAIN_START) return lerpRgb(base, HILL_COLOR, (height - HILL_START) / (MOUNTAIN_START - HILL_START));
		if (height < SNOW_START) return lerpRgb(HILL_COLOR, MOUNTAIN_COLOR, (height - MOUNTAIN_START) / (SNOW_START - MOUNTAIN_START));
		return lerpRgb(MOUNTAIN_COLOR, SNOW_COLOR, Math.min(1, (height - SNOW_START) / (SNOW_FULL - SNOW_START)));
	}

	function roadStyleFromDetail(d) {
		if (d < 0.33) return "dirt";
		if (d < 0.66) return "cobblestone";
		return "paved";
	}

	function clamp255(v) { return Math.max(0, Math.min(255, Math.round(v))); }

	// --- Fetch queue: cap concurrent chunk requests ---
	const MAX_CONCURRENT = 6;
	let active = 0;
	const queue = [];
	function enqueueFetch(fn) {
		return new Promise((resolve, reject) => {
			queue.push({ fn, resolve, reject });
			pump();
		});
	}
	function pump() {
		while (active < MAX_CONCURRENT && queue.length) {
			const job = queue.shift();
			active++;
			job.fn().then(job.resolve, job.reject).finally(() => {
				active--;
				pump();
			});
		}
	}

	class MapViewer {
		constructor(root) {
			this.root = root;
			this.slug = root.dataset.map;
			this.canvas = root.querySelector("[data-canvas]");
			this.ctx = this.canvas.getContext("2d");
			this.readout = root.querySelector("[data-readout]");
			this.baseUrl = new URL(`../data/maps/${this.slug}/`, document.baseURI);

			this.cache = new Map(); // "cx,cy" -> {h,t,d,bitmap}
			this.chunkSet = new Set();
			this.manifest = null;

			this.camera = { x: 0, y: 0, scale: 1 };
			this.dragging = false;
			this.dirty = true;

			this.resize = this.resize.bind(this);
			this.render = this.render.bind(this);

			this.init();
		}

		async init() {
			this.root.classList.add("is-loading");
			try {
				const res = await fetch(new URL("manifest.json", this.baseUrl));
				if (!res.ok) throw new Error(`manifest fetch failed: ${res.status}`);
				this.manifest = await res.json();
				this.chunkSet = new Set(this.manifest.chunks);
				this.root.classList.remove("is-loading");
			} catch (err) {
				const fallback = this.root.querySelector(".map-viewer__fallback");
				if (fallback) fallback.textContent = "Couldn't load this map's terrain data.";
				console.error(err);
				return;
			}

			this.bindEvents();
			new ResizeObserver(this.resize).observe(this.canvas);
			this.resize();
			this.fit();
			requestAnimationFrame(this.render);
		}

		bindEvents() {
			const c = this.canvas;
			let lastX = 0, lastY = 0;

			c.addEventListener("pointerdown", (e) => {
				this.dragging = true;
				lastX = e.clientX;
				lastY = e.clientY;
				c.setPointerCapture(e.pointerId);
			});
			c.addEventListener("pointermove", (e) => {
				if (!this.dragging) return;
				const dx = e.clientX - lastX, dy = e.clientY - lastY;
				lastX = e.clientX;
				lastY = e.clientY;
				this.camera.x -= dx / this.camera.scale;
				this.camera.y -= dy / this.camera.scale;
				this.dirty = true;
			});
			c.addEventListener("pointerup", () => { this.dragging = false; });
			c.addEventListener("pointerleave", () => { this.dragging = false; });

			c.addEventListener(
				"wheel",
				(e) => {
					e.preventDefault();
					const rect = c.getBoundingClientRect();
					const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
					const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
					this.zoomAt(cx, cy, factor);
				},
				{ passive: false }
			);

			// Keyboard: arrow keys pan, +/- zoom, 0 fits — mirrors the pointer
			// and toolbar controls so the map is usable without a mouse.
			const PAN_STEP = 60;
			c.addEventListener("keydown", (e) => {
				switch (e.key) {
					case "ArrowLeft":
						this.camera.x -= PAN_STEP / this.camera.scale;
						this.dirty = true;
						break;
					case "ArrowRight":
						this.camera.x += PAN_STEP / this.camera.scale;
						this.dirty = true;
						break;
					case "ArrowUp":
						this.camera.y -= PAN_STEP / this.camera.scale;
						this.dirty = true;
						break;
					case "ArrowDown":
						this.camera.y += PAN_STEP / this.camera.scale;
						this.dirty = true;
						break;
					case "+":
					case "=":
						this.zoomAt(c.clientWidth / 2, c.clientHeight / 2, 1.25);
						break;
					case "-":
					case "_":
						this.zoomAt(c.clientWidth / 2, c.clientHeight / 2, 1 / 1.25);
						break;
					case "0":
						this.fit();
						break;
					default:
						return;
				}
				e.preventDefault();
			});
		}

		zoomAt(screenX, screenY, factor) {
			const worldX = this.camera.x + screenX / this.camera.scale;
			const worldY = this.camera.y + screenY / this.camera.scale;
			this.camera.scale = Math.max(0.06, Math.min(8, this.camera.scale * factor));
			this.camera.x = worldX - screenX / this.camera.scale;
			this.camera.y = worldY - screenY / this.camera.scale;
			this.dirty = true;
		}

		// Thin wrappers so the shared toolbar can zoom whichever mode (2D/3D)
		// is currently active through one common interface.
		zoomIn() { this.zoomAt(this.canvas.clientWidth / 2, this.canvas.clientHeight / 2, 1.25); }
		zoomOut() { this.zoomAt(this.canvas.clientWidth / 2, this.canvas.clientHeight / 2, 1 / 1.25); }

		fit() {
			const m = this.manifest;
			if (!m.bounds) return;
			const chunkPx = m.chunkSize * m.cellSize;
			const worldW = (m.bounds.maxChunkX - m.bounds.minChunkX + 1) * chunkPx;
			const worldH = (m.bounds.maxChunkY - m.bounds.minChunkY + 1) * chunkPx;
			const cw = this.canvas.clientWidth || 800;
			const ch = this.canvas.clientHeight || 500;
			this.camera.scale = Math.max(0.06, Math.min(cw / worldW, ch / worldH) * 0.92);
			const centerX = (m.bounds.minChunkX + (m.bounds.maxChunkX - m.bounds.minChunkX + 1) / 2) * chunkPx;
			const centerY = (m.bounds.minChunkY + (m.bounds.maxChunkY - m.bounds.minChunkY + 1) / 2) * chunkPx;
			this.camera.x = centerX - cw / 2 / this.camera.scale;
			this.camera.y = centerY - ch / 2 / this.camera.scale;
			this.dirty = true;
		}

		resize() {
			const dpr = Math.min(window.devicePixelRatio || 1, 2);
			const rect = this.canvas.getBoundingClientRect();
			this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
			this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
			this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			this.dirty = true;
		}

		// --- Chunk data access (mirrors TerrainGrid: missing chunk = default) ---

		chunkAt(cx, cy) {
			const size = this.manifest.chunkSize;
			const chunkX = Math.floor(cx / size);
			const chunkY = Math.floor(cy / size);
			return { entry: this.cache.get(`${chunkX},${chunkY}`), chunkX, chunkY, localX: cx - chunkX * size, localY: cy - chunkY * size };
		}

		getHeight(cx, cy) {
			const { entry, localX, localY } = this.chunkAt(cx, cy);
			if (!entry || !entry.h) return 0;
			return entry.h[localY * this.manifest.chunkSize + localX] || 0;
		}

		getTerrain(cx, cy) {
			const { entry, localX, localY } = this.chunkAt(cx, cy);
			if (!entry || !entry.t) return null;
			return entry.t[localY * this.manifest.chunkSize + localX] || null;
		}

		getDetail(cx, cy) {
			const { entry, localX, localY } = this.chunkAt(cx, cy);
			if (!entry || !entry.d) return DEFAULT_DETAIL;
			const v = entry.d[localY * this.manifest.chunkSize + localX];
			return v === undefined ? DEFAULT_DETAIL : v;
		}

		hillshade(cx, cy) {
			const gx = this.getHeight(cx + 1, cy) - this.getHeight(cx - 1, cy);
			const gy = this.getHeight(cx, cy + 1) - this.getHeight(cx, cy - 1);
			const shade = 1 - ((gx + gy) / HILLSHADE_REFERENCE_METERS) * SHADE_STRENGTH;
			return Math.max(MIN_SHADE, Math.min(MAX_SHADE, shade));
		}

		// --- Chunk loading + bitmap building ---

		ensureChunk(chunkX, chunkY) {
			const key = `${chunkX},${chunkY}`;
			if (!this.chunkSet.has(key)) return null;
			let entry = this.cache.get(key);
			if (entry) return entry;

			entry = { loading: true, bitmap: null };
			this.cache.set(key, entry);

			enqueueFetch(() =>
				fetch(new URL(`chunks/${chunkX}_${chunkY}.json`, this.baseUrl)).then((r) => (r.ok ? r.json() : null))
			).then((data) => {
				if (!data) return;
				entry.h = data.h;
				entry.t = data.t;
				entry.d = data.d;
				entry.loading = false;
				this.buildBitmap(chunkX, chunkY);
				// Neighbors' hillshade reads across this chunk's edge — refresh
				// any that are already built so seams don't stay stale.
				for (const [nx, ny] of [[chunkX - 1, chunkY], [chunkX + 1, chunkY], [chunkX, chunkY - 1], [chunkX, chunkY + 1]]) {
					const n = this.cache.get(`${nx},${ny}`);
					if (n && n.bitmap) this.buildBitmap(nx, ny);
				}
				this.dirty = true;
			});

			return entry;
		}

		buildBitmap(chunkX, chunkY) {
			const size = this.manifest.chunkSize;
			const entry = this.cache.get(`${chunkX},${chunkY}`);
			if (!entry || entry.loading) return;

			const off = document.createElement("canvas");
			off.width = size;
			off.height = size;
			const octx = off.getContext("2d");
			const img = octx.createImageData(size, size);

			for (let ly = 0; ly < size; ly++) {
				for (let lx = 0; lx < size; lx++) {
					const idx = ly * size + lx;
					const cx = chunkX * size + lx;
					const cy = chunkY * size + ly;
					const type = entry.t ? entry.t[idx] : null;

					let rgb;
					if (!type) {
						rgb = EMPTY_CELL_COLOR;
					} else {
						const height = this.getHeight(cx, cy);
						const shade = this.hillshade(cx, cy);
						const base = type === "road" ? ROAD_STYLE_COLORS[roadStyleFromDetail(this.getDetail(cx, cy))] : bandedTerrainColor(type, height);
						rgb = [clamp255(base[0] * shade), clamp255(base[1] * shade), clamp255(base[2] * shade)];
					}

					const p = idx * 4;
					img.data[p] = rgb[0];
					img.data[p + 1] = rgb[1];
					img.data[p + 2] = rgb[2];
					img.data[p + 3] = 255;
				}
			}

			octx.putImageData(img, 0, 0);
			entry.bitmap = off;
		}

		// --- Render loop ---

		render() {
			// Hiding this canvas (switching to the other mode) fires a
			// ResizeObserver callback that marks us dirty one more time —
			// skip drawing while hidden so we don't clobber the shared
			// readout span with our own text, and so the hidden viewer
			// isn't spending GPU/CPU it can't show anyway.
			if (this.dirty && this.manifest && !this.canvas.hidden) {
				this.draw();
				this.dirty = false;
			}
			requestAnimationFrame(this.render);
		}

		draw() {
			const { ctx, camera, manifest } = this;
			const cw = this.canvas.clientWidth;
			const ch = this.canvas.clientHeight;

			ctx.fillStyle = `rgb(${EMPTY_CELL_COLOR.join(",")})`;
			ctx.fillRect(0, 0, cw, ch);

			const chunkPx = manifest.chunkSize * manifest.cellSize;
			const worldLeft = camera.x, worldTop = camera.y;
			const worldRight = camera.x + cw / camera.scale;
			const worldBottom = camera.y + ch / camera.scale;

			const startCX = Math.floor(worldLeft / chunkPx) - 1;
			const endCX = Math.ceil(worldRight / chunkPx) + 1;
			const startCY = Math.floor(worldTop / chunkPx) - 1;
			const endCY = Math.ceil(worldBottom / chunkPx) + 1;

			ctx.imageSmoothingEnabled = true;

			for (let cy = startCY; cy <= endCY; cy++) {
				for (let cx = startCX; cx <= endCX; cx++) {
					const entry = this.ensureChunk(cx, cy);
					if (!entry || !entry.bitmap) continue;

					const screenX = (cx * chunkPx - camera.x) * camera.scale;
					const screenY = (cy * chunkPx - camera.y) * camera.scale;
					const screenSize = chunkPx * camera.scale;
					ctx.drawImage(entry.bitmap, screenX, screenY, screenSize, screenSize);
				}
			}

			if (this.readout) {
				const centerWorldX = camera.x + cw / 2 / camera.scale;
				const centerWorldY = camera.y + ch / 2 / camera.scale;
				const mX = Math.round((centerWorldX / manifest.cellSize) * manifest.metersPerCell);
				const mY = Math.round((centerWorldY / manifest.cellSize) * manifest.metersPerCell);
				this.readout.textContent = `${mX} m, ${mY} m · ${camera.scale.toFixed(2)}×`;
			}
		}
	}

	// One .map-viewer root hosts two independent viewers (2D canvas + 3D
	// WebGL canvas) behind a mode toggle. The 3D viewer is only constructed
	// on first switch to it, so pages nobody flips to 3D never pay for a
	// WebGL context or chunk meshing at all.
	document.querySelectorAll(".map-viewer[data-map]").forEach((root) => {
		const viewer2d = new MapViewer(root);
		let viewer3d = null;
		let mode = "2d";

		const canvas2d = root.querySelector("[data-canvas]");
		const canvas3d = root.querySelector("[data-canvas-3d]");
		const modeButtons = root.querySelectorAll("[data-mode]");

		function activeViewer() { return mode === "3d" ? viewer3d : viewer2d; }

		modeButtons.forEach((btn) => {
			btn.addEventListener("click", () => {
				const next = btn.dataset.mode;
				if (next === mode) return;
				mode = next;
				modeButtons.forEach((b) => b.setAttribute("aria-selected", String(b === btn)));
				canvas2d.hidden = mode !== "2d";
				canvas3d.hidden = mode !== "3d";
				if (mode === "3d" && !viewer3d) {
					viewer3d = new Map3DViewer(root, canvas3d);
					viewer3d.init();
				}
			});
		});

		root.querySelector('[data-action="zoom-in"]')?.addEventListener("click", () => activeViewer()?.zoomIn());
		root.querySelector('[data-action="zoom-out"]')?.addEventListener("click", () => activeViewer()?.zoomOut());
		root.querySelector('[data-action="fit"]')?.addEventListener("click", () => activeViewer()?.fit());
	});
})();
