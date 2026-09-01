import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CartographerMapData, parseChunkKey } from "../model/types";
import { TerrainGrid } from "../model/TerrainGrid";
import { HeightBrushEngine } from "../editor/HeightBrushEngine";
import { BrushEngine } from "../editor/BrushEngine";
import { HistoryManager } from "../editor/HistoryManager";
import { CellRect } from "../editor/CellRect";
import { MOUNTAIN_START, bandedTerrainColor } from "./palette";
import { hashSeed, mulberry32 } from "./prng";

// True orbit-able 3D scene: a triangulated, vertex-colored heightmap mesh,
// instanced procedural trees on forest cells below the treeline, and an
// animated shader-driven water plane (vertex ripple + shifting color band —
// no textures, matches the "no external asset" rule the rest of the plugin
// follows).
//
// The terrain is built as one mesh PER CHUNK, sampled at exactly one vertex
// per grid cell (chunkSize+1 verts/side so edges stitch seamlessly with
// neighboring chunks) — mirroring ChunkedGridRenderer's per-chunk cache in
// the 2D views. This is what fixes the old "raising terrain just stretches
// existing geometry instead of adding detail" bug: there used to be a single
// mesh for the WHOLE map, downsampled to a fixed vertex budget regardless of
// how much of that budget any one area actually needed, so a tall, narrow
// peak had no more vertices to spend than a flat plain of the same
// footprint. Per-chunk, full-cell-resolution meshes mean elevation always
// has real geometry to move, and only the chunks a brush stroke actually
// touches need rebuilding — cheap enough to do live while painting.
const MAX_TREES = 4000;
// Radians of camera orbit per wheel-delta unit for Shift+scroll look-around.
const LOOK_AROUND_SPEED = 0.002;

const MOVE_KEY_CODES = new Set([
	"KeyW",
	"KeyA",
	"KeyS",
	"KeyD",
	"Space",
	"ShiftLeft",
	"ShiftRight",
	"ControlLeft",
	"ControlRight",
]);
const FLY_MIN_SPEED = 40; // world units/sec, floor for when the camera is very close to its target
const FLY_SPEED_FACTOR = 0.9; // world units/sec added per world unit of camera-to-target distance — flying is faster when zoomed out
const FLY_BOOST_MULTIPLIER = 3; // held Ctrl

export type Land3DPaintMode = "navigate" | "sculpt" | "paint";

// Everything Land3DView needs to paint directly into the shared map data —
// the same TerrainGrid/engines/history the 2D Terrain Editor and Heightmap
// Editor use, so a stroke made in 3D undoes/redoes and autosaves exactly
// like one made in 2D.
export interface Land3DBrushContext {
	grid: TerrainGrid;
	heightBrushEngine: HeightBrushEngine;
	brushEngine: BrushEngine;
	history: HistoryManager | null;
	// Called once per completed stroke (pointer up) — the host uses this to
	// update the status bar and schedule a save, same as the 2D brushes.
	onEdit: () => void;
}

export class Land3DView {
	private renderer: THREE.WebGLRenderer;
	private scene: THREE.Scene;
	private camera: THREE.PerspectiveCamera;
	private controls: OrbitControls;
	private resizeObserver: ResizeObserver;
	private rafHandle: number | null = null;
	private waterMaterial: THREE.ShaderMaterial | null = null;
	private waterMesh: THREE.Mesh | null = null;
	private treeMeshes: THREE.Object3D[] = [];
	private terrainMaterial: THREE.MeshStandardMaterial;
	private chunkMeshes = new Map<string, THREE.Mesh>();
	private brushCursor: THREE.Mesh;
	private raycaster = new THREE.Raycaster();
	private lastFrameTime: number | null = null;
	private elapsed = 0;
	private disposed = false;

	private keysDown = new Set<string>();
	private paintMode: Land3DPaintMode = "navigate";
	private painting = false;

	// World units per meter of stored height, so a painted elevation renders
	// to true scale against the horizontal grid (which is laid out at
	// cellSize world units per metersPerCell meters). A fixed constant here
	// would either flatten tall mountains to nothing or blow small hills up
	// to absurd size depending on a map's chosen scale.
	private readonly worldUnitsPerMeter: number;

	constructor(private container: HTMLElement, private data: CartographerMapData, private brushCtx: Land3DBrushContext) {
		this.worldUnitsPerMeter = this.data.cellSize / this.data.metersPerCell;
		this.renderer = new THREE.WebGLRenderer({ antialias: true });
		this.renderer.setPixelRatio(window.devicePixelRatio || 1);
		container.appendChild(this.renderer.domElement);

		// Focusable + listens for its own keydown/keyup so WASD flight works
		// without hijacking keyboard input anywhere else in Obsidian.
		this.renderer.domElement.tabIndex = 0;
		this.renderer.domElement.style.outline = "none";

		this.scene = new THREE.Scene();
		this.scene.background = new THREE.Color(0x1b1f2a);

		const rect = container.getBoundingClientRect();
		this.camera = new THREE.PerspectiveCamera(50, Math.max(1, rect.width) / Math.max(1, rect.height), 0.1, 4000);

		this.controls = new OrbitControls(this.camera, this.renderer.domElement);
		this.controls.enableDamping = true;

		this.terrainMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 });

		this.brushCursor = new THREE.Mesh(
			new THREE.RingGeometry(0.9, 1, 48),
			new THREE.MeshBasicMaterial({ color: 0xffe9a8, transparent: true, opacity: 0.75, side: THREE.DoubleSide, depthTest: false })
		);
		this.brushCursor.rotation.x = -Math.PI / 2;
		this.brushCursor.visible = false;
		this.brushCursor.renderOrder = 999;
		this.scene.add(this.brushCursor);

		this.setupLights();
		this.buildScene();
		this.handleResize();

		this.resizeObserver = new ResizeObserver(() => this.handleResize());
		this.resizeObserver.observe(container);
		this.renderer.domElement.addEventListener("wheel", this.handleWheel, { passive: false });
		this.renderer.domElement.addEventListener("pointerdown", this.handleFocusRequest);
		this.renderer.domElement.addEventListener("pointerdown", this.onCanvasPointerDown);
		this.renderer.domElement.addEventListener("pointermove", this.onCanvasPointerMove);
		this.renderer.domElement.addEventListener("keydown", this.handleKeyDown);
		this.renderer.domElement.addEventListener("keyup", this.handleKeyUp);
		window.addEventListener("pointerup", this.endPaintingStroke);
		window.addEventListener("pointercancel", this.endPaintingStroke);
		window.addEventListener("blur", this.handleBlur);

		this.animate();
	}

	dispose(): void {
		this.disposed = true;
		if (this.rafHandle !== null) cancelAnimationFrame(this.rafHandle);
		this.resizeObserver.disconnect();
		this.renderer.domElement.removeEventListener("wheel", this.handleWheel);
		this.renderer.domElement.removeEventListener("pointerdown", this.handleFocusRequest);
		this.renderer.domElement.removeEventListener("pointerdown", this.onCanvasPointerDown);
		this.renderer.domElement.removeEventListener("pointermove", this.onCanvasPointerMove);
		this.renderer.domElement.removeEventListener("keydown", this.handleKeyDown);
		this.renderer.domElement.removeEventListener("keyup", this.handleKeyUp);
		window.removeEventListener("pointerup", this.endPaintingStroke);
		window.removeEventListener("pointercancel", this.endPaintingStroke);
		window.removeEventListener("blur", this.handleBlur);
		this.controls.dispose();

		this.scene.traverse((obj) => {
			if (obj instanceof THREE.Mesh || obj instanceof THREE.InstancedMesh) {
				obj.geometry.dispose();
				const mat = obj.material;
				if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
				else mat.dispose();
			}
		});

		this.renderer.dispose();
		this.container.removeChild(this.renderer.domElement);
	}

	// Switches what left-drag does. "navigate" leaves OrbitControls' normal
	// rotate-on-left-drag behavior alone; "sculpt"/"paint" hand left-drag to
	// the brush (raycasting onto the terrain mesh) instead and disable
	// orbit-rotate so the two don't fight — right-drag pan and wheel zoom
	// keep working in every mode. WASD flight (see updateFlyMovement) is
	// independent of this and always active, so movement and painting work
	// at the same time, the way the user actually wants to sculpt terrain:
	// fly up close, paint, back off, look from another angle, paint again.
	setPaintMode(mode: Land3DPaintMode): void {
		if (this.painting) this.endPaintingStroke();
		this.paintMode = mode;
		this.controls.enableRotate = mode === "navigate";
		if (mode === "navigate") this.brushCursor.visible = false;
	}

	// Plain scroll still dollies (OrbitControls' default). Holding Shift
	// instead orbits the camera around the target, matching the rest of the
	// plugin's modifier+scroll convention (e.g. Ctrl+scroll to zoom in the
	// 2D editors) and giving a mouse-only way to look around without
	// needing a click-drag.
	private handleWheel = (event: WheelEvent): void => {
		if (!event.shiftKey) return;
		event.preventDefault();
		event.stopPropagation();

		const delta = event.deltaY !== 0 ? event.deltaY : event.deltaX;
		const offset = new THREE.Vector3().subVectors(this.camera.position, this.controls.target);
		const spherical = new THREE.Spherical().setFromVector3(offset);
		spherical.theta -= delta * LOOK_AROUND_SPEED;
		spherical.phi = Math.max(0.05, Math.min(Math.PI - 0.05, spherical.phi));
		offset.setFromSpherical(spherical);
		this.camera.position.copy(this.controls.target).add(offset);
		this.camera.lookAt(this.controls.target);
	};

	private handleFocusRequest = (): void => {
		this.renderer.domElement.focus();
	};

	private handleKeyDown = (ev: KeyboardEvent): void => {
		if (!MOVE_KEY_CODES.has(ev.code)) return;
		this.keysDown.add(ev.code);
		ev.preventDefault();
	};

	private handleKeyUp = (ev: KeyboardEvent): void => {
		this.keysDown.delete(ev.code);
	};

	private handleBlur = (): void => {
		this.keysDown.clear();
	};

	// Horizontal WASD (relative to where the camera is looking, but flattened
	// so looking up/down doesn't fly you into the ground or the sky), Space/
	// Shift for vertical, Ctrl to move faster. Moves the camera and the
	// OrbitControls target by the same vector, which keeps the two in sync —
	// since OrbitControls derives its internal spherical state from
	// (position - target), translating both by an identical delta leaves
	// that offset untouched, so orbit/damping keep working exactly as before
	// from wherever you've flown to, with no snap-back next frame.
	private updateFlyMovement(dt: number): void {
		if (dt <= 0 || this.keysDown.size === 0) return;

		let dx = 0;
		let dz = 0;
		let dy = 0;
		if (this.keysDown.has("KeyW")) dz += 1;
		if (this.keysDown.has("KeyS")) dz -= 1;
		if (this.keysDown.has("KeyD")) dx += 1;
		if (this.keysDown.has("KeyA")) dx -= 1;
		if (this.keysDown.has("Space")) dy += 1;
		if (this.keysDown.has("ShiftLeft") || this.keysDown.has("ShiftRight")) dy -= 1;
		if (dx === 0 && dz === 0 && dy === 0) return;

		const forward = new THREE.Vector3();
		this.camera.getWorldDirection(forward);
		forward.y = 0;
		if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
		else forward.normalize();
		const right = new THREE.Vector3().crossVectors(forward, this.camera.up).normalize();

		const boost = this.keysDown.has("ControlLeft") || this.keysDown.has("ControlRight") ? FLY_BOOST_MULTIPLIER : 1;
		const distance = this.camera.position.distanceTo(this.controls.target);
		const speed = Math.max(FLY_MIN_SPEED, distance * FLY_SPEED_FACTOR) * boost;

		const move = new THREE.Vector3();
		move.addScaledVector(forward, dz);
		move.addScaledVector(right, dx);
		move.y += dy;
		if (move.lengthSq() === 0) return;
		move.normalize().multiplyScalar(speed * dt);

		this.camera.position.add(move);
		this.controls.target.add(move);
	}

	private handleResize(): void {
		const rect = this.container.getBoundingClientRect();
		const w = Math.max(1, rect.width);
		const h = Math.max(1, rect.height);
		this.renderer.setSize(w, h);
		this.camera.aspect = w / h;
		this.camera.updateProjectionMatrix();
	}

	private setupLights(): void {
		this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
		const sun = new THREE.DirectionalLight(0xfff3d6, 1.1);
		sun.position.set(-60, 90, -40); // matches the 2D views' upper-left hillshade direction
		this.scene.add(sun);
	}

	private paintedChunkKeys(): Set<string> {
		return new Set([...Object.keys(this.data.heightChunks), ...Object.keys(this.data.terrainChunks)]);
	}

	private buildScene(): void {
		const chunkKeys = this.paintedChunkKeys();
		for (const key of chunkKeys) {
			const { chunkX, chunkY } = parseChunkKey(key);
			this.rebuildChunkMesh(chunkX, chunkY);
		}

		this.clearTreesAndWater();
		this.addTrees(chunkKeys);
		this.addWater(chunkKeys);

		this.frameCameraToContent();
	}

	private frameCameraToContent(): void {
		const box = new THREE.Box3();
		for (const mesh of this.chunkMeshes.values()) box.expandByObject(mesh);

		if (box.isEmpty()) {
			this.camera.position.set(80, 120, 80);
			this.controls.target.set(0, 0, 0);
			this.camera.far = 4000;
			this.camera.updateProjectionMatrix();
			this.controls.update();
			return;
		}

		const center = box.getCenter(new THREE.Vector3());
		const size = box.getSize(new THREE.Vector3());
		const radius = Math.max(10, size.length() * 0.5);
		const dist = radius * 2.6;
		this.camera.position.set(center.x + dist * 0.6, radius * 1.4 + 20, center.z + dist * 0.6);
		this.controls.target.copy(center);
		// Far plane must cover the actual camera-to-geometry distance — on a
		// large painted map the fixed default could clip the whole mesh,
		// which renders as nothing but the background color.
		this.camera.far = Math.max(4000, dist * 4);
		this.camera.updateProjectionMatrix();
		this.controls.update();
	}

	// One vertex per grid cell, (chunkSize+1) per side so the last row/column
	// samples the same absolute cell coordinates a neighboring chunk's first
	// row/column does — the meshes share exact vertex positions along that
	// seam, so there's no crack between chunks even though each is a
	// separate BufferGeometry.
	private buildChunkGeometry(chunkX: number, chunkY: number): THREE.BufferGeometry {
		const grid = this.brushCtx.grid;
		const size = this.data.chunkSize;
		const cellSize = this.data.cellSize;
		const minCx = chunkX * size;
		const minCy = chunkY * size;
		const verts = size + 1;

		const positions = new Float32Array(verts * verts * 3);
		const colors = new Float32Array(verts * verts * 3);
		let vi = 0;
		let ci = 0;
		for (let gy = 0; gy < verts; gy++) {
			for (let gx = 0; gx < verts; gx++) {
				const cx = minCx + gx;
				const cy = minCy + gy;
				const h = grid.getHeight(cx, cy);

				positions[vi++] = cx * cellSize;
				positions[vi++] = h * this.worldUnitsPerMeter;
				positions[vi++] = cy * cellSize;

				const type = grid.getTerrain(cx, cy);
				const [r, g, b] = type ? bandedTerrainColor(type, h) : [90, 90, 90];
				colors[ci++] = r / 255;
				colors[ci++] = g / 255;
				colors[ci++] = b / 255;
			}
		}

		const indices: number[] = [];
		for (let gy = 0; gy < verts - 1; gy++) {
			for (let gx = 0; gx < verts - 1; gx++) {
				const a = gy * verts + gx;
				const b = a + 1;
				const c = a + verts;
				const d = c + 1;
				indices.push(a, c, b, b, c, d);
			}
		}

		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
		geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
		geometry.setIndex(indices);
		geometry.computeVertexNormals();
		return geometry;
	}

	// Rebuilds (or removes) exactly one chunk's mesh from live grid data —
	// cheap enough to call for every chunk a brush stroke touches, which is
	// what lets painting rebuild geometry live instead of needing a manual
	// "Rebuild 3D" click.
	private rebuildChunkMesh(chunkX: number, chunkY: number): void {
		const grid = this.brushCtx.grid;
		const key = `${chunkX},${chunkY}`;
		const hasData = grid.hasHeightChunk(chunkX, chunkY) || grid.hasTerrainChunk(chunkX, chunkY);

		if (!hasData) {
			const existing = this.chunkMeshes.get(key);
			if (existing) {
				this.scene.remove(existing);
				existing.geometry.dispose();
				this.chunkMeshes.delete(key);
			}
			return;
		}

		const geometry = this.buildChunkGeometry(chunkX, chunkY);
		const existing = this.chunkMeshes.get(key);
		if (existing) {
			existing.geometry.dispose();
			existing.geometry = geometry;
		} else {
			const mesh = new THREE.Mesh(geometry, this.terrainMaterial);
			this.scene.add(mesh);
			this.chunkMeshes.set(key, mesh);
		}
	}

	// Rebuilds every chunk touched by a dirty cell rect, padded by one cell
	// so a stroke landing right on a chunk boundary also refreshes the
	// neighbor chunk sharing that seam.
	private markDirty(rect: CellRect): void {
		const size = this.data.chunkSize;
		const minChunkX = Math.floor((rect.minCx - 1) / size);
		const maxChunkX = Math.floor((rect.maxCx + 1) / size);
		const minChunkY = Math.floor((rect.minCy - 1) / size);
		const maxChunkY = Math.floor((rect.maxCy + 1) / size);
		for (let cy = minChunkY; cy <= maxChunkY; cy++) {
			for (let cx = minChunkX; cx <= maxChunkX; cx++) {
				this.rebuildChunkMesh(cx, cy);
			}
		}
	}

	private clearTreesAndWater(): void {
		for (const obj of this.treeMeshes) {
			this.scene.remove(obj);
			if (obj instanceof THREE.InstancedMesh) {
				obj.geometry.dispose();
				(obj.material as THREE.Material).dispose();
			}
		}
		this.treeMeshes = [];

		if (this.waterMesh) {
			this.scene.remove(this.waterMesh);
			this.waterMesh.geometry.dispose();
			(this.waterMesh.material as THREE.Material).dispose();
			this.waterMesh = null;
		}
		this.waterMaterial = null;
	}

	// Full re-scan of trees + water across every painted chunk. Only called
	// once per completed stroke (not per brush stamp), since it's a real
	// scan of every cell rather than an incremental update.
	private rebuildTreesAndWater(): void {
		const chunkKeys = this.paintedChunkKeys();
		this.clearTreesAndWater();
		this.addTrees(chunkKeys);
		this.addWater(chunkKeys);
	}

	private addTrees(chunkKeys: Set<string>): void {
		const grid = this.brushCtx.grid;
		const size = this.data.chunkSize;
		const cellSize = this.data.cellSize;

		const candidates: { cx: number; cy: number }[] = [];
		for (const key of chunkKeys) {
			const { chunkX, chunkY } = parseChunkKey(key);
			const baseX = chunkX * size;
			const baseY = chunkY * size;
			for (let ly = 0; ly < size; ly++) {
				for (let lx = 0; lx < size; lx++) {
					const cx = baseX + lx;
					const cy = baseY + ly;
					if (grid.getTerrain(cx, cy) !== "forest") continue;
					if (grid.getHeight(cx, cy) >= MOUNTAIN_START) continue;
					if (mulberry32(hashSeed(cx, cy, 77))() < 0.45) candidates.push({ cx, cy });
				}
			}
		}
		if (candidates.length === 0) return;

		const cullStep = Math.max(1, Math.ceil(candidates.length / MAX_TREES));
		const chosen = candidates.filter((_, i) => i % cullStep === 0);

		const trunkGeo = new THREE.CylinderGeometry(0.35, 0.5, 3, 5);
		const canopyGeo = new THREE.ConeGeometry(2.2, 5, 6);
		const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5b4632, roughness: 1 });
		const canopyMat = new THREE.MeshStandardMaterial({ color: 0x2f5c34, roughness: 0.9 });

		const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, chosen.length);
		const canopies = new THREE.InstancedMesh(canopyGeo, canopyMat, chosen.length);
		const m = new THREE.Matrix4();
		const pos = new THREE.Vector3();
		const quat = new THREE.Quaternion();
		const scaleVec = new THREE.Vector3();

		chosen.forEach(({ cx, cy }, i) => {
			const rng = mulberry32(hashSeed(cx, cy, 91));
			const worldX = cx * cellSize + (rng() - 0.5) * cellSize * 0.6;
			const worldZ = cy * cellSize + (rng() - 0.5) * cellSize * 0.6;
			const h = grid.getHeight(cx, cy) * this.worldUnitsPerMeter;
			const scale = 0.7 + rng() * 0.6;
			scaleVec.set(scale, scale, scale);

			pos.set(worldX, h + 1.5 * scale, worldZ);
			m.compose(pos, quat, scaleVec);
			trunks.setMatrixAt(i, m);

			pos.set(worldX, h + 4 * scale, worldZ);
			m.compose(pos, quat, scaleVec);
			canopies.setMatrixAt(i, m);
		});

		trunks.instanceMatrix.needsUpdate = true;
		canopies.instanceMatrix.needsUpdate = true;
		this.scene.add(trunks, canopies);
		this.treeMeshes.push(trunks, canopies);
	}

	// Builds one quad per actual water/river cell (at that cell's own height,
	// slightly recessed) rather than a single plane over the whole painted
	// bounding box — a single sheet covering the entire map the moment ANY
	// water exists anywhere is what made the 3D view look like nothing but
	// blue in an earlier version.
	private addWater(chunkKeys: Set<string>): void {
		const grid = this.brushCtx.grid;
		const size = this.data.chunkSize;
		const cellSize = this.data.cellSize;

		const positions: number[] = [];
		const indices: number[] = [];
		let vertCount = 0;

		for (const key of chunkKeys) {
			const { chunkX, chunkY } = parseChunkKey(key);
			const baseX = chunkX * size;
			const baseY = chunkY * size;
			for (let ly = 0; ly < size; ly++) {
				for (let lx = 0; lx < size; lx++) {
					const cx = baseX + lx;
					const cy = baseY + ly;
					const t = grid.getTerrain(cx, cy);
					if (t !== "water" && t !== "river") continue;

					const x0 = cx * cellSize;
					const z0 = cy * cellSize;
					const x1 = (cx + 1) * cellSize;
					const z1 = (cy + 1) * cellSize;
					const y = grid.getHeight(cx, cy) * this.worldUnitsPerMeter - 0.15;

					const base = vertCount;
					positions.push(x0, y, z0, x1, y, z0, x0, y, z1, x1, y, z1);
					indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
					vertCount += 4;
				}
			}
		}

		if (vertCount === 0) return;

		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
		geometry.setIndex(indices);
		geometry.computeVertexNormals();

		const material = new THREE.ShaderMaterial({
			transparent: true,
			side: THREE.DoubleSide,
			uniforms: { uTime: { value: this.elapsed } },
			vertexShader: /* glsl */ `
				uniform float uTime;
				varying vec2 vWorldXZ;
				void main() {
					vWorldXZ = position.xz;
					vec3 p = position;
					p.y += sin((p.x + uTime * 18.0) * 0.06) * 0.35 + cos((p.z + uTime * 14.0) * 0.08) * 0.35;
					gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
				}
			`,
			fragmentShader: /* glsl */ `
				uniform float uTime;
				varying vec2 vWorldXZ;
				void main() {
					float wave = sin((vWorldXZ.x * 0.12) + uTime * 1.6) * 0.5 + sin((vWorldXZ.y * 0.1) - uTime * 1.1) * 0.5;
					vec3 base = vec3(0.16, 0.32, 0.55);
					vec3 highlight = vec3(0.45, 0.68, 0.85);
					vec3 color = mix(base, highlight, clamp(wave * 0.5 + 0.5, 0.0, 1.0) * 0.6);
					gl_FragColor = vec4(color, 0.82);
				}
			`,
		});

		this.waterMaterial = material;
		this.waterMesh = new THREE.Mesh(geometry, material);
		this.scene.add(this.waterMesh);
	}

	private raycastTerrainAt(clientX: number, clientY: number): { fx: number; fy: number; point: THREE.Vector3 } | null {
		if (this.chunkMeshes.size === 0) return null;
		const rect = this.renderer.domElement.getBoundingClientRect();
		const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
		this.raycaster.setFromCamera(ndc, this.camera);
		const hits = this.raycaster.intersectObjects(Array.from(this.chunkMeshes.values()), false);
		if (hits.length === 0) return null;
		const point = hits[0].point;
		return { fx: point.x / this.data.cellSize, fy: point.z / this.data.cellSize, point };
	}

	private updateBrushCursor(hit: { fx: number; fy: number; point: THREE.Vector3 } | null): void {
		if (!hit) {
			this.brushCursor.visible = false;
			return;
		}
		const radiusCells =
			this.paintMode === "paint" ? this.brushCtx.brushEngine.getSettings().radius : this.brushCtx.heightBrushEngine.getSettings().radius;
		const worldRadius = Math.max(0.5, radiusCells) * this.data.cellSize;
		this.brushCursor.scale.setScalar(worldRadius);
		this.brushCursor.position.set(hit.point.x, hit.point.y + 0.4, hit.point.z);
		this.brushCursor.visible = true;
	}

	private applyStamp(fx: number, fy: number, isStart: boolean): void {
		const { grid, heightBrushEngine, brushEngine } = this.brushCtx;
		let dirty: CellRect | null;
		if (this.paintMode === "paint") {
			dirty = isStart ? brushEngine.startStroke(grid, fx, fy) : brushEngine.continueStroke(grid, fx, fy);
		} else {
			dirty = isStart ? heightBrushEngine.startStroke(grid, fx, fy) : heightBrushEngine.continueStroke(grid, fx, fy);
		}
		if (dirty) this.markDirty(dirty);
	}

	private onCanvasPointerDown = (ev: PointerEvent): void => {
		if (this.paintMode === "navigate" || ev.button !== 0) return;
		const hit = this.raycastTerrainAt(ev.clientX, ev.clientY);
		if (!hit) return;
		ev.preventDefault();
		this.painting = true;
		this.brushCtx.history?.beginStroke();
		this.applyStamp(hit.fx, hit.fy, true);
	};

	private onCanvasPointerMove = (ev: PointerEvent): void => {
		if (this.paintMode === "navigate") return;
		const hit = this.raycastTerrainAt(ev.clientX, ev.clientY);
		this.updateBrushCursor(hit);
		if (this.painting && hit) this.applyStamp(hit.fx, hit.fy, false);
	};

	// Bound to window (not just the canvas) so a drag that ends outside the
	// canvas — or outside the window entirely — still cleanly closes the
	// stroke instead of leaving it stuck open.
	private endPaintingStroke = (): void => {
		if (!this.painting) return;
		this.painting = false;
		if (this.paintMode === "paint") this.brushCtx.brushEngine.endStroke(this.data);
		else this.brushCtx.heightBrushEngine.endStroke();
		this.brushCtx.history?.endStroke();
		this.rebuildTreesAndWater();
		this.brushCtx.onEdit();
	};

	private animate = (): void => {
		if (this.disposed) return;
		this.rafHandle = requestAnimationFrame(this.animate);

		const now = performance.now() / 1000;
		const dt = this.lastFrameTime === null ? 0 : Math.min(0.1, now - this.lastFrameTime);
		this.lastFrameTime = now;
		this.elapsed += dt;

		if (this.waterMaterial) this.waterMaterial.uniforms.uTime.value = this.elapsed;
		this.updateFlyMovement(dt);
		this.controls.update();
		this.renderer.render(this.scene, this.camera);
	};
}
