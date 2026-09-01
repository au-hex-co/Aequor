// 3D terrain view of the same Cartographer chunk data map-viewer.js paints
// in 2D — plain WebGL1, no Three.js, so the site stays dependency-free.
// Each chunk is chunkSize * metersPerCell meters across (32m on every map
// currently in the vault) and is fetched, meshed, and uploaded to the GPU
// only once the camera's target comes near it; chunks that fall far enough
// behind get their GPU buffers freed again, mirroring the "only touched
// chunks cost anything" model map-viewer.js already uses for 2D.

(() => {
	"use strict";

	// Palette kept in sync by hand with map-viewer.js / the Cartographer
	// plugin's own TerrainRenderer — see that file for the source pointer.
	const TERRAIN_COLORS = {
		water: [0x3a, 0x72, 0xb0],
		river: [0x5a, 0xa0, 0xd8],
		sand: [0xd9, 0xc4, 0x8b],
		plains: [0x9a, 0xc3, 0x6c],
		forest: [0x3f, 0x6b, 0x3f],
		road: [0x8a, 0x7a, 0x5c],
	};
	const EMPTY_CELL_COLOR = [0xcf, 0xc6, 0xae];
	const HILL_COLOR = [0xa3, 0xa8, 0x6c];
	const MOUNTAIN_COLOR = [0x8a, 0x80, 0x78];
	const SNOW_COLOR = [0xf2, 0xf2, 0xf2];
	const HILL_START = 15, MOUNTAIN_START = 60, SNOW_START = 250, SNOW_FULL = 600;
	const BANDED = new Set(["plains", "forest", "sand"]);

	function lerpRgb(a, b, t) {
		const c = Math.max(0, Math.min(1, t));
		return [a[0] + (b[0] - a[0]) * c, a[1] + (b[1] - a[1]) * c, a[2] + (b[2] - a[2]) * c];
	}

	function terrainColor(type, height) {
		if (!type) return EMPTY_CELL_COLOR;
		const base = TERRAIN_COLORS[type] || EMPTY_CELL_COLOR;
		if (!BANDED.has(type)) return base;
		if (height < HILL_START) return base;
		if (height < MOUNTAIN_START) return lerpRgb(base, HILL_COLOR, (height - HILL_START) / (MOUNTAIN_START - HILL_START));
		if (height < SNOW_START) return lerpRgb(HILL_COLOR, MOUNTAIN_COLOR, (height - MOUNTAIN_START) / (SNOW_START - MOUNTAIN_START));
		return lerpRgb(MOUNTAIN_COLOR, SNOW_COLOR, Math.min(1, (height - SNOW_START) / (SNOW_FULL - SNOW_START)));
	}

	// --- Fetch queue: cap concurrent chunk requests (mirrors map-viewer.js) ---
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

	// --- Minimal column-major mat4 helpers (gl-matrix's layout, hand-ported) ---
	function perspective(fovy, aspect, near, far) {
		const f = 1 / Math.tan(fovy / 2);
		const nf = 1 / (near - far);
		return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
	}
	function lookAt(eye, center, up) {
		let z0 = eye[0] - center[0], z1 = eye[1] - center[1], z2 = eye[2] - center[2];
		let len = Math.hypot(z0, z1, z2) || 1;
		z0 /= len; z1 /= len; z2 /= len;
		let x0 = up[1] * z2 - up[2] * z1, x1 = up[2] * z0 - up[0] * z2, x2 = up[0] * z1 - up[1] * z0;
		len = Math.hypot(x0, x1, x2) || 1;
		x0 /= len; x1 /= len; x2 /= len;
		const y0 = z1 * x2 - z2 * x1, y1 = z2 * x0 - z0 * x2, y2 = z0 * x1 - z1 * x0;
		return new Float32Array([
			x0, y0, z0, 0,
			x1, y1, z1, 0,
			x2, y2, z2, 0,
			-(x0 * eye[0] + x1 * eye[1] + x2 * eye[2]), -(y0 * eye[0] + y1 * eye[1] + y2 * eye[2]), -(z0 * eye[0] + z1 * eye[1] + z2 * eye[2]), 1,
		]);
	}

	const VERTEX_SRC = `
		attribute vec3 aPosition;
		attribute vec3 aColor;
		uniform mat4 uProjection;
		uniform mat4 uView;
		varying vec3 vColor;
		void main() {
			gl_Position = uProjection * uView * vec4(aPosition, 1.0);
			vColor = aColor;
		}
	`;
	const FRAGMENT_SRC = `
		precision mediump float;
		varying vec3 vColor;
		void main() {
			gl_FragColor = vec4(vColor, 1.0);
		}
	`;

	function compileShader(gl, type, src) {
		const shader = gl.createShader(type);
		gl.shaderSource(shader, src);
		gl.compileShader(shader);
		if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
			console.error("Map3DViewer shader error:", gl.getShaderInfoLog(shader));
			gl.deleteShader(shader);
			return null;
		}
		return shader;
	}

	const RENDER_RADIUS = 3; // chunks around the target kept loaded/meshed
	const UNLOAD_RADIUS = 5; // chunks beyond this get freed
	const MIN_DIST = 12, MAX_DIST = 2200;
	const PAN_STEP = 14, ROTATE_STEP = 0.09;

	class Map3DViewer {
		constructor(root, canvas) {
			this.root = root;
			this.slug = root.dataset.map;
			this.canvas = canvas;
			this.readout = root.querySelector("[data-readout]");
			this.baseUrl = new URL(`../data/maps/${this.slug}/`, document.baseURI);

			this.manifest = null;
			this.cache = new Map(); // "cx,cy" -> {h,t,loading, buffer, vertexCount}
			this.chunkSet = new Set();

			this.camera = { targetX: 0, targetZ: 0, distance: 260, yaw: 0.6, pitch: 0.55 };
			this.dirty = true;
			this.ready = false;

			this.render = this.render.bind(this);
		}

		async init() {
			const gl = this.canvas.getContext("webgl", { antialias: true, alpha: false }) || this.canvas.getContext("experimental-webgl");
			if (!gl) {
				this.fallback("Your browser doesn't support WebGL, so the 3D view can't run here.");
				return;
			}
			this.gl = gl;

			const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SRC);
			const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SRC);
			if (!vs || !fs) {
				this.fallback("The 3D terrain shader failed to compile.");
				return;
			}
			const program = gl.createProgram();
			gl.attachShader(program, vs);
			gl.attachShader(program, fs);
			gl.linkProgram(program);
			if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
				this.fallback("The 3D terrain program failed to link.");
				return;
			}
			this.program = program;
			this.aPosition = gl.getAttribLocation(program, "aPosition");
			this.aColor = gl.getAttribLocation(program, "aColor");
			this.uProjection = gl.getUniformLocation(program, "uProjection");
			this.uView = gl.getUniformLocation(program, "uView");

			gl.enable(gl.DEPTH_TEST);
			gl.clearColor(0.12, 0.16, 0.22, 1);

			try {
				const res = await fetch(new URL("manifest.json", this.baseUrl));
				if (!res.ok) throw new Error(`manifest fetch failed: ${res.status}`);
				this.manifest = await res.json();
				this.chunkSet = new Set(this.manifest.chunks);
			} catch (err) {
				console.error(err);
				this.fallback("Couldn't load this map's terrain data.");
				return;
			}

			this.ready = true;
			this.bindEvents();
			this.resizeObserver = new ResizeObserver(() => this.resize());
			this.resizeObserver.observe(this.canvas);
			this.resize();
			this.fit();
			requestAnimationFrame(this.render);
		}

		fallback(message) {
			const el = this.root.querySelector(".map-viewer__fallback-3d") || this.root.querySelector(".map-viewer__fallback");
			if (el) {
				el.textContent = message;
				el.style.display = "block";
			}
		}

		resize() {
			const dpr = Math.min(window.devicePixelRatio || 1, 2);
			const rect = this.canvas.getBoundingClientRect();
			this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
			this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
			this.dirty = true;
		}

		bindEvents() {
			const c = this.canvas;
			let dragging = false, lastX = 0, lastY = 0;

			c.addEventListener("pointerdown", (e) => {
				dragging = true;
				lastX = e.clientX;
				lastY = e.clientY;
				c.setPointerCapture(e.pointerId);
			});
			c.addEventListener("pointermove", (e) => {
				if (!dragging) return;
				const dx = e.clientX - lastX, dy = e.clientY - lastY;
				lastX = e.clientX;
				lastY = e.clientY;
				this.camera.yaw -= dx * 0.006;
				this.camera.pitch = clamp(this.camera.pitch + dy * 0.006, 0.08, 1.45);
				this.dirty = true;
			});
			c.addEventListener("pointerup", () => { dragging = false; });
			c.addEventListener("pointerleave", () => { dragging = false; });

			c.addEventListener(
				"wheel",
				(e) => {
					e.preventDefault();
					this.zoom(e.deltaY < 0 ? 1 / 1.12 : 1.12);
				},
				{ passive: false }
			);

			c.addEventListener("keydown", (e) => {
				const step = PAN_STEP * (this.camera.distance / 200 + 0.3);
				const forward = [Math.sin(this.camera.yaw), Math.cos(this.camera.yaw)];
				const right = [Math.cos(this.camera.yaw), -Math.sin(this.camera.yaw)];
				switch (e.key) {
					case "ArrowUp":
						if (e.shiftKey) this.camera.pitch = clamp(this.camera.pitch - ROTATE_STEP, 0.08, 1.45);
						else { this.camera.targetX += forward[0] * step; this.camera.targetZ += forward[1] * step; }
						break;
					case "ArrowDown":
						if (e.shiftKey) this.camera.pitch = clamp(this.camera.pitch + ROTATE_STEP, 0.08, 1.45);
						else { this.camera.targetX -= forward[0] * step; this.camera.targetZ -= forward[1] * step; }
						break;
					case "ArrowLeft":
						if (e.shiftKey) this.camera.yaw -= ROTATE_STEP;
						else { this.camera.targetX -= right[0] * step; this.camera.targetZ -= right[1] * step; }
						break;
					case "ArrowRight":
						if (e.shiftKey) this.camera.yaw += ROTATE_STEP;
						else { this.camera.targetX += right[0] * step; this.camera.targetZ += right[1] * step; }
						break;
					case "+":
					case "=":
						this.zoom(1 / 1.2);
						break;
					case "-":
					case "_":
						this.zoom(1.2);
						break;
					case "0":
						this.fit();
						break;
					default:
						return;
				}
				this.dirty = true;
				e.preventDefault();
			});
		}

		zoom(factor) {
			this.camera.distance = clamp(this.camera.distance * factor, MIN_DIST, MAX_DIST);
			this.dirty = true;
		}

		zoomIn() { this.zoom(1 / 1.2); }
		zoomOut() { this.zoom(1.2); }

		fit() {
			const m = this.manifest;
			if (!m || !m.bounds) return;
			const mpc = m.metersPerCell || 1;
			const chunkM = m.chunkSize * mpc;
			const cx = (m.bounds.minChunkX + (m.bounds.maxChunkX - m.bounds.minChunkX + 1) / 2) * chunkM;
			const cz = (m.bounds.minChunkY + (m.bounds.maxChunkY - m.bounds.minChunkY + 1) / 2) * chunkM;
			const spanChunks = Math.max(m.bounds.maxChunkX - m.bounds.minChunkX + 1, m.bounds.maxChunkY - m.bounds.minChunkY + 1);
			this.camera.targetX = cx;
			this.camera.targetZ = cz;
			this.camera.distance = clamp(spanChunks * chunkM * 0.55, MIN_DIST, MAX_DIST);
			this.camera.yaw = 0.6;
			this.camera.pitch = 0.55;
			this.dirty = true;
		}

		// --- Chunk data + mesh building ---

		targetChunk() {
			const m = this.manifest;
			const chunkM = m.chunkSize * (m.metersPerCell || 1);
			return { cx: Math.floor(this.camera.targetX / chunkM), cy: Math.floor(this.camera.targetZ / chunkM) };
		}

		ensureChunk(chunkX, chunkY) {
			const key = `${chunkX},${chunkY}`;
			if (!this.chunkSet.has(key)) return;
			if (this.cache.has(key)) return;

			const entry = { loading: true };
			this.cache.set(key, entry);

			enqueueFetch(() => fetch(new URL(`chunks/${chunkX}_${chunkY}.json`, this.baseUrl)).then((r) => (r.ok ? r.json() : null))).then((data) => {
				entry.loading = false;
				if (!data) return;
				entry.h = data.h;
				entry.t = data.t;
				this.buildMesh(chunkX, chunkY, entry);
				this.dirty = true;
			});
		}

		buildMesh(chunkX, chunkY, entry) {
			const gl = this.gl;
			const size = this.manifest.chunkSize;
			const mpc = this.manifest.metersPerCell || 1;
			const h = entry.h, t = entry.t;

			// Corner heights are averaged from this chunk's own cells only (no
			// cross-chunk lookups), so neighboring chunks can render fully
			// independently — the tradeoff is a soft seam at chunk borders,
			// same tradeoff map-viewer.js's 2D hillshade already accepts.
			const cellH = (lx, ly) => {
				lx = Math.max(0, Math.min(size - 1, lx));
				ly = Math.max(0, Math.min(size - 1, ly));
				return h ? h[ly * size + lx] || 0 : 0;
			};
			const cornerH = (cx, cy) => {
				let sum = 0, count = 0;
				for (const dx of [-1, 0]) {
					for (const dy of [-1, 0]) {
						const lx = cx + dx, ly = cy + dy;
						if (lx >= 0 && lx < size && ly >= 0 && ly < size) {
							sum += cellH(lx, ly);
							count++;
						}
					}
				}
				return count ? sum / count : 0;
			};

			const ox = chunkX * size * mpc, oz = chunkY * size * mpc;
			const light = normalize3([0.5, 1, 0.35]);
			const verts = new Float32Array(size * size * 6 * 6);
			let n = 0;

			const push = (x, y, z, r, g, b) => {
				verts[n++] = x; verts[n++] = y; verts[n++] = z;
				verts[n++] = r; verts[n++] = g; verts[n++] = b;
			};

			for (let ly = 0; ly < size; ly++) {
				for (let lx = 0; lx < size; lx++) {
					const idx = ly * size + lx;
					const type = t ? t[idx] : null;
					const height = cellH(lx, ly);
					const base = terrainColor(type, height);

					const x0 = ox + lx * mpc, x1 = ox + (lx + 1) * mpc;
					const z0 = oz + ly * mpc, z1 = oz + (ly + 1) * mpc;
					const y00 = cornerH(lx, ly), y10 = cornerH(lx + 1, ly), y01 = cornerH(lx, ly + 1), y11 = cornerH(lx + 1, ly + 1);

					const p00 = [x0, y00, z0], p10 = [x1, y10, z0], p01 = [x0, y01, z1], p11 = [x1, y11, z1];
					const nrm = faceNormal(p00, p10, p01);
					const shade = clamp(0.45 + 0.65 * Math.max(0, dot3(nrm, light)), 0.35, 1.15);
					const r = clamp255(base[0] * shade) / 255, g = clamp255(base[1] * shade) / 255, b = clamp255(base[2] * shade) / 255;

					push(...p00, r, g, b);
					push(...p10, r, g, b);
					push(...p11, r, g, b);
					push(...p00, r, g, b);
					push(...p11, r, g, b);
					push(...p01, r, g, b);
				}
			}

			const buffer = gl.createBuffer();
			gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
			gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
			entry.buffer = buffer;
			entry.vertexCount = size * size * 6;
			entry.h = entry.t = null; // raw arrays no longer needed once meshed
		}

		unloadFar(targetCx, targetCy) {
			for (const [key, entry] of this.cache) {
				const [cx, cy] = key.split(",").map(Number);
				const dist = Math.max(Math.abs(cx - targetCx), Math.abs(cy - targetCy));
				if (dist > UNLOAD_RADIUS) {
					if (entry.buffer) this.gl.deleteBuffer(entry.buffer);
					this.cache.delete(key);
				}
			}
		}

		// --- Render loop ---

		render() {
			if (this.dirty && this.ready) {
				this.draw();
				this.dirty = false;
			}
			requestAnimationFrame(this.render);
		}

		draw() {
			const gl = this.gl;
			const { targetX, targetZ, distance, yaw, pitch } = this.camera;

			const { cx: tcx, cy: tcy } = this.targetChunk();
			for (let dy = -RENDER_RADIUS; dy <= RENDER_RADIUS; dy++) {
				for (let dx = -RENDER_RADIUS; dx <= RENDER_RADIUS; dx++) {
					this.ensureChunk(tcx + dx, tcy + dy);
				}
			}
			this.unloadFar(tcx, tcy);

			const eye = [
				targetX + distance * Math.cos(pitch) * Math.sin(yaw),
				distance * Math.sin(pitch),
				targetZ + distance * Math.cos(pitch) * Math.cos(yaw),
			];

			gl.viewport(0, 0, this.canvas.width, this.canvas.height);
			gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
			gl.useProgram(this.program);

			const aspect = this.canvas.width / this.canvas.height || 1;
			const proj = perspective((50 * Math.PI) / 180, aspect, 1, MAX_DIST * 2.5);
			const view = lookAt(eye, [targetX, 0, targetZ], [0, 1, 0]);
			gl.uniformMatrix4fv(this.uProjection, false, proj);
			gl.uniformMatrix4fv(this.uView, false, view);

			gl.enableVertexAttribArray(this.aPosition);
			gl.enableVertexAttribArray(this.aColor);

			for (const entry of this.cache.values()) {
				if (!entry.buffer) continue;
				gl.bindBuffer(gl.ARRAY_BUFFER, entry.buffer);
				gl.vertexAttribPointer(this.aPosition, 3, gl.FLOAT, false, 24, 0);
				gl.vertexAttribPointer(this.aColor, 3, gl.FLOAT, false, 24, 12);
				gl.drawArrays(gl.TRIANGLES, 0, entry.vertexCount);
			}

			if (this.readout) {
				const mpc = this.manifest.metersPerCell || 1;
				this.readout.textContent = `${Math.round(targetX)} m, ${Math.round(targetZ)} m · ${Math.round(distance)} m out`;
			}
		}
	}

	function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
	function clamp255(v) { return Math.max(0, Math.min(255, Math.round(v))); }
	function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
	function normalize3(v) {
		const len = Math.hypot(v[0], v[1], v[2]) || 1;
		return [v[0] / len, v[1] / len, v[2] / len];
	}
	function faceNormal(p0, p1, p2) {
		const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
		const vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
		return normalize3([uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx]);
	}

	window.Map3DViewer = Map3DViewer;
})();
