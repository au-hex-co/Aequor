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
import { terrainTileIndex } from "./terrainTextures";
import { GRASS_BLADE_TEXTURES } from "./grassSprites";

// True orbit-able 3D scene: a triangulated heightmap mesh whose material
// detail (grass, rock, sand, snow, roads...) is computed live per-fragment
// from real noise functions in the terrain shader (see TERRAIN_FRAGMENT_
// SHADER below) rather than sampled from a baked raster texture — there is
// no fixed texel grid, so it never looks pixelated no matter how close the
// camera gets, and it stays the "no external asset" rule the rest of the
// plugin follows (generated math, not a loaded PNG). The mesh is tinted by
// the existing height-banded vertex color, has instanced procedural trees
// on forest cells below the treeline, and an animated shader-driven water
// plane (rippling + a directional scrolling-noise "flow" look) sitting a
// little below the painted terrain height at every water/river cell.
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

// Real grass blade "cross cards" (see GRASS_BLADE_TEXTURES) scattered over
// grass/plains cells so zooming into a plains cell shows actual standing
// grass instead of just the terrain shader's flat procedural color. Grass
// is expensive to keep everywhere on a big painted map, so it's only ever
// built in a radius around wherever the camera is currently looking —
// re-centered as the camera flies (see updateGrassStreaming) — rather than
// once across the whole map like trees/water.
const GRASS_RADIUS_METERS = 55;
const MAX_GRASS_CLUMPS = 9000;
// Re-center (rebuild) the grass field once the camera target has drifted
// this far from where it was last built.
const GRASS_REBUILD_DISTANCE_METERS = GRASS_RADIUS_METERS * 0.45;
const GRASS_REBUILD_MIN_INTERVAL_SECONDS = 0.5;
const GRASS_DENSITY_THRESHOLD = 0.08; // mirrors TerrainRenderer's 2D drawGrass cutoff

// Radians of camera orbit per wheel-delta unit for Shift+scroll look-around.
const LOOK_AROUND_SPEED = 0.002;
// Water always sits this many real meters below the painted terrain height
// at that cell (converted to world units via worldUnitsPerMeter so it reads
// consistently at any map scale), independent of the ripple/flow animation
// riding on top — otherwise a river painted at the same height as its bank
// would fight the terrain in the z-buffer and flicker.
const WATER_DEPRESSION_METERS = 0.4;

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

// Single source of truth for the scene's (fixed, non-interactive) lighting —
// shared between setupLights()'s actual THREE.Light objects and the terrain
// shader's hand-rolled lighting uniforms (a RawShaderMaterial doesn't sit in
// three's normal lit-material pipeline, so it can't read scene lights
// automatically; it needs these values passed in directly instead).
const SUN_POSITION = new THREE.Vector3(-60, 90, -40); // matches the 2D views' upper-left hillshade direction
const SUN_COLOR_HEX = 0xfff3d6;
const SUN_INTENSITY = 1.1;
const AMBIENT_COLOR_HEX = 0xffffff;
const AMBIENT_INTENSITY = 0.55;

// Terrain shader: picks one discrete MATERIAL per vertex (see
// terrainTextures.ts's terrainTileIndex — 0=grass, 1=forest, 2=sand,
// 3=rock, 4=snow, 5=dirt road, 6=cobblestone, 7=paved, 8=bare dirt) and
// renders that material's per-fragment procedural noise pattern, multiplied
// by the existing height-banded vertex tint, then simple fixed-direction
// Lambert shading matching setupLights(). Because the pattern is computed
// live from world-space position instead of sampled from a raster texture,
// there is no fixed pixel resolution to it — it stays crisp at any zoom —
// and it never visibly repeats/tiles the way a small baked swatch would. A
// RawShaderMaterial (not the usual ShaderMaterial) because picking a
// material per-vertex needs a `flat` varying — interpolating the material
// index across a triangle would blend two unrelated materials together at
// every boundary — and `flat`/`in`/`out` require GLSL3, which needs the raw
// variant so three doesn't also inject its own legacy `attribute`/`varying`
// declarations on top of these.
const TERRAIN_VERTEX_SHADER = /* glsl */ `
precision highp float;
in vec3 position;
in vec3 normal;
in vec3 color;
in vec2 uv;
in float tileIndex;

uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform mat3 normalMatrix;

out vec3 vColor;
out vec2 vWorldXZ;
out vec3 vNormal;
flat out float vTileIndex;

void main() {
	vColor = color;
	vWorldXZ = uv; // world-space meters, see buildChunkGeometry's uv fill
	vNormal = normalize(normalMatrix * normal);
	vTileIndex = tileIndex;
	gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const TERRAIN_FRAGMENT_SHADER = /* glsl */ `
precision highp float;
in vec3 vColor;
in vec2 vWorldXZ;
in vec3 vNormal;
flat in float vTileIndex;

uniform vec3 uSunDirection;
uniform vec3 uSunColor;
uniform vec3 uAmbientColor;
// Offsets the "uneven ground" bump sample (see bumpedNormal below) so the
// specific relief pattern differs each time the 3D view is opened, the same
// way grass clump placement does (see Land3DView's grassSeed) — it's a
// cosmetic close-up detail, not map data, so it isn't pinned to one fixed
// pattern forever.
uniform vec2 uBumpSeed;

out vec4 outColor;

// ---- generic per-fragment coherent noise (not tiled/periodic — sampled
// straight from continuous world-space position, so it has no fixed
// resolution and never visibly repeats across a real map) ----
float hash(vec2 p) {
	p = fract(p * vec2(123.34, 456.21));
	p += dot(p, p + 45.32);
	return fract(p.x * p.y);
}

float valueNoise(vec2 p) {
	vec2 i = floor(p);
	vec2 f = fract(p);
	float a = hash(i);
	float b = hash(i + vec2(1.0, 0.0));
	float c = hash(i + vec2(0.0, 1.0));
	float d = hash(i + vec2(1.0, 1.0));
	vec2 u = f * f * (3.0 - 2.0 * f);
	return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
	float sum = 0.0;
	float amp = 0.5;
	for (int i = 0; i < 4; i++) {
		sum += amp * valueNoise(p);
		p *= 2.03;
		amp *= 0.5;
	}
	return sum;
}

// Distance to the nearest of a jittered grid of feature points — gives
// rounded cell shapes (cobblestones) instead of blotchy noise.
float worley(vec2 p) {
	vec2 i = floor(p);
	vec2 f = fract(p);
	float minDist = 1.5;
	for (int y = -1; y <= 1; y++) {
		for (int x = -1; x <= 1; x++) {
			vec2 cell = vec2(float(x), float(y));
			vec2 jitter = vec2(hash(i + cell), hash(i + cell + vec2(19.1, 7.3)));
			minDist = min(minDist, length(cell + jitter - f));
		}
	}
	return minDist;
}

// Nudges the sample position by a second noise field so patterns read as
// organic/irregular instead of grid-aligned — a standard procedural-texture
// trick ("domain warping").
vec2 warp(vec2 p, float amount) {
	return p + amount * (vec2(fbm(p * 0.6 + 11.0), fbm(p * 0.6 - 7.0)) - 0.5);
}

vec3 grassColor(vec2 p) {
	vec2 wp = warp(vec2(p.x, p.y * 1.6), 0.8);
	float macro = fbm(wp * 0.18);
	float blade = fbm(vec2(p.x * 1.6, p.y * 0.55) + 9.0);
	vec3 dark = vec3(0.27, 0.42, 0.18);
	vec3 light = vec3(0.56, 0.73, 0.34);
	vec3 col = mix(dark, light, clamp(macro * 0.7 + blade * 0.45, 0.0, 1.0));
	float fleck = smoothstep(0.93, 1.0, hash(floor(p * 30.0)));
	return col + fleck * vec3(0.08, 0.1, 0.04);
}

vec3 forestColor(vec2 p) {
	vec2 wp = warp(vec2(p.x, p.y * 1.4), 0.9);
	float macro = fbm(wp * 0.22);
	float grain = fbm(p * 2.1 + 31.0);
	vec3 dark = vec3(0.1, 0.22, 0.11);
	vec3 light = vec3(0.28, 0.42, 0.22);
	vec3 col = mix(dark, light, clamp(macro * 0.8 + grain * 0.3, 0.0, 1.0));
	float fleck = smoothstep(0.9, 1.0, hash(floor(p * 22.0) + 3.0));
	return col - fleck * 0.08;
}

vec3 sandColor(vec2 p) {
	vec2 wp = warp(p, 0.6);
	float dune = fbm(wp * 0.12);
	float grain = fbm(p * 3.5 + 5.0);
	vec3 col = mix(vec3(0.72, 0.63, 0.42), vec3(0.87, 0.79, 0.56), clamp(dune * 0.8 + grain * 0.25, 0.0, 1.0));
	float fleck = smoothstep(0.85, 1.0, hash(floor(p * 45.0) + 7.0));
	return col + fleck * 0.08;
}

vec3 rockColor(vec2 p) {
	vec2 wp = warp(p, 1.0);
	float macro = fbm(wp * 0.16);
	// Faint strata bands running along a fixed diagonal, like sedimentary
	// rock layers.
	float strata = sin((p.x * 0.35 + p.y * 0.12) + macro * 2.0) * 0.5 + 0.5;
	float grain = fbm(p * 2.6 + 17.0);
	vec3 col = mix(vec3(0.42, 0.39, 0.35), vec3(0.62, 0.58, 0.52), clamp(macro * 0.6 + strata * 0.3 + grain * 0.2, 0.0, 1.0));
	float fleck = smoothstep(0.88, 1.0, hash(floor(p * 26.0) + 2.0));
	return col + fleck * 0.15;
}

vec3 snowColor(vec2 p) {
	float undulate = fbm(p * 0.2);
	vec3 col = mix(vec3(0.85, 0.87, 0.9), vec3(0.98, 0.99, 1.0), undulate);
	float sparkle = smoothstep(0.9, 1.0, hash(floor(p * 55.0) + 4.0));
	return col + sparkle * 0.25;
}

vec3 dirtColor(vec2 p, vec3 base) {
	vec2 wp = warp(p, 0.7);
	float macro = fbm(wp * 0.2);
	float grain = fbm(p * 2.8 + 21.0);
	vec3 col = base * (0.82 + macro * 0.3 + grain * 0.15);
	float fleck = smoothstep(0.87, 1.0, hash(floor(p * 32.0) + 6.0));
	return col + fleck * 0.1;
}

vec3 pavedColor(vec2 p) {
	// Low-frequency asphalt mottling plus sparse light-fleck aggregate —
	// deliberately smoother/less grainy than the dirt materials.
	float macro = fbm(p * 0.3 + 41.0);
	vec3 col = vec3(0.22, 0.22, 0.24) * (0.85 + macro * 0.3);
	float fleck = smoothstep(0.92, 1.0, hash(floor(p * 60.0) + 8.0));
	return col + fleck * 0.12;
}

vec3 cobbleColor(vec2 p) {
	float d = worley(p * 2.4);
	float stoneShade = hash(floor(p * 2.4) + 51.0);
	vec3 stone = mix(vec3(0.5, 0.5, 0.5), vec3(0.68, 0.68, 0.68), stoneShade);
	vec3 grout = vec3(0.22, 0.22, 0.22);
	float edge = smoothstep(0.28, 0.46, d);
	vec3 col = mix(stone, grout, edge);
	float grain = fbm(p * 4.0 + 13.0);
	return col * (0.9 + grain * 0.15);
}

// Fakes fine, blade-scale "uneven ground" on grass cells by perturbing the
// LIT normal from a high-frequency noise height field's local slope (finite
// differences), the same trick a normal map does — at this mesh's actual
// resolution (one vertex per cell) there's no real geometry left to
// displace at that scale, so this is the cheap way to still make a
// close-up plains cell read as bumpy dirt-and-root ground under the grass
// rather than a billiard-flat plane. Only applied to the grass tile: other
// materials either aren't meant to look soft/organic (rock, paved) or
// already vary height for real (banded elevation).
vec3 bumpedNormal(vec3 baseNormal, vec2 p) {
	vec2 bp = p * 2.3 + uBumpSeed;
	float eps = 0.08;
	float hl = fbm(vec2(bp.x - eps, bp.y));
	float hr = fbm(vec2(bp.x + eps, bp.y));
	float hd = fbm(vec2(bp.x, bp.y - eps));
	float hu = fbm(vec2(bp.x, bp.y + eps));
	vec3 bump = normalize(vec3((hl - hr) * 3.5, 1.0, (hd - hu) * 3.5));
	return normalize(mix(baseNormal, bump, 0.4));
}

vec3 materialColor(int tile, vec2 p) {
	if (tile == 0) return grassColor(p);
	if (tile == 1) return forestColor(p);
	if (tile == 2) return sandColor(p);
	if (tile == 3) return rockColor(p);
	if (tile == 4) return snowColor(p);
	if (tile == 5) return dirtColor(p, vec3(0.54, 0.41, 0.27));
	if (tile == 6) return cobbleColor(p);
	if (tile == 7) return pavedColor(p);
	return dirtColor(p, vec3(0.47, 0.42, 0.34)); // 8: bare dirt
}

void main() {
	int tile = int(vTileIndex + 0.5);
	vec3 texel = materialColor(tile, vWorldXZ);

	vec3 albedo = texel * vColor * 1.7;
	vec3 n = normalize(vNormal);
	if (tile == 0) n = bumpedNormal(n, vWorldXZ);
	float ndotl = max(dot(n, uSunDirection), 0.0);
	vec3 lit = albedo * (uAmbientColor + uSunColor * ndotl);
	outColor = vec4(lit, 1.0);
}
`;

// Grass blade instancing shader: a small "cross card" (two perpendicular
// quads, see buildGrassCardGeometry) per clump, textured with one of the
// real photographed/rendered blade cutouts in GRASS_BLADE_TEXTURES and
// tinted per-instance via instanceColor for the same dark/light variance
// the procedural grassColor() above gives the flat terrain shader. Instanced
// (not per-frame-billboarded) — a static cross card reads convincingly as a
// grass clump from any angle without needing to face the camera, the same
// convention Minecraft-style voxel/low-poly games use for foliage cards.
// Bottom vertices (local y=0) are pinned to the ground; top vertices sway
// with a per-instance-phased wind so a whole field doesn't wave in lockstep.
const GRASS_VERTEX_SHADER = /* glsl */ `
#ifdef USE_INSTANCING
attribute mat4 instanceMatrix;
#endif
#ifdef USE_INSTANCING_COLOR
attribute vec3 instanceColor;
#endif

uniform float uTime;
uniform vec2 uWindDir;

varying vec2 vUv;
varying vec3 vColor;
varying float vAo;

void main() {
	vUv = uv;
	#ifdef USE_INSTANCING_COLOR
	vColor = instanceColor;
	#else
	vColor = vec3(1.0);
	#endif

	vec3 pos = position;
	vAo = clamp(pos.y, 0.0, 1.0);

	#ifdef USE_INSTANCING
	vec3 instancePos = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
	#else
	vec3 instancePos = vec3(0.0);
	#endif
	float phase = dot(instancePos.xz, vec2(0.13, 0.09));
	float sway = pos.y * pos.y; // pinned at the base, swings most at the tip
	float wind = sin(uTime * 1.6 + phase) * 0.16 + sin(uTime * 0.7 + phase * 1.7) * 0.07;
	pos.x += uWindDir.x * wind * sway;
	pos.z += uWindDir.y * wind * sway;

	#ifdef USE_INSTANCING
	vec4 worldPos = instanceMatrix * vec4(pos, 1.0);
	#else
	vec4 worldPos = vec4(pos, 1.0);
	#endif
	gl_Position = projectionMatrix * modelViewMatrix * worldPos;
}
`;

const GRASS_FRAGMENT_SHADER = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uSunColor;
uniform vec3 uAmbientColor;

varying vec2 vUv;
varying vec3 vColor;
varying float vAo;

void main() {
	vec4 tex = texture2D(uMap, vUv);
	if (tex.a < 0.5) discard;
	// The sprite's own gradient (bright tip, dark base) doubles as cheap
	// ambient occlusion; blended with vAo (also 0 at the base) so it reads
	// consistently even for the flattest of the three blade textures.
	float ao = mix(0.45, 1.0, max(tex.r, vAo));
	vec3 albedo = vColor * ao;
	vec3 lit = albedo * (uAmbientColor + uSunColor * 0.85);
	gl_FragColor = vec4(lit, 1.0);
}
`;

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
	private terrainMaterial: THREE.RawShaderMaterial;
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

	private grassMeshes: THREE.InstancedMesh[] = [];
	private grassGeometry: THREE.BufferGeometry | null = null;
	private grassMaterials: THREE.ShaderMaterial[] = [];
	private grassAnchorWorld: THREE.Vector2 | null = null;
	private lastGrassBuildElapsed = -Infinity;
	// Regenerated fresh every time the 3D view is opened. Grass clump
	// placement (and the terrain shader's matching uBumpSeed "uneven ground"
	// offset) is a purely cosmetic, unsaved concept render layered on top of
	// the real painted map data — not map data itself — so it's fine, even
	// expected, for it to look a little different on every open rather than
	// being pinned to one fixed arrangement forever.
	private readonly grassSeed: number = Math.floor(Math.random() * 0xffffffff);

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

		const lightUniforms = Land3DView.terrainLightUniforms();
		this.terrainMaterial = new THREE.RawShaderMaterial({
			glslVersion: THREE.GLSL3,
			uniforms: {
				uSunDirection: { value: lightUniforms.sunDirection },
				uSunColor: { value: lightUniforms.sunColor },
				uAmbientColor: { value: lightUniforms.ambientColor },
				uBumpSeed: { value: Land3DView.bumpSeedFromSessionSeed(this.grassSeed) },
			},
			vertexShader: TERRAIN_VERTEX_SHADER,
			fragmentShader: TERRAIN_FRAGMENT_SHADER,
		});

		this.grassMaterials = Land3DView.loadGrassTextures().map(
			(texture) =>
				new THREE.ShaderMaterial({
					uniforms: {
						uMap: { value: texture },
						uTime: { value: 0 },
						uWindDir: { value: new THREE.Vector2(1, 0.4).normalize() },
						uSunColor: { value: lightUniforms.sunColor },
						uAmbientColor: { value: lightUniforms.ambientColor },
					},
					vertexShader: GRASS_VERTEX_SHADER,
					fragmentShader: GRASS_FRAGMENT_SHADER,
					side: THREE.DoubleSide,
				})
		);

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
		this.scene.add(new THREE.AmbientLight(AMBIENT_COLOR_HEX, AMBIENT_INTENSITY));
		const sun = new THREE.DirectionalLight(SUN_COLOR_HEX, SUN_INTENSITY);
		sun.position.copy(SUN_POSITION);
		this.scene.add(sun);
	}

	// Builds the terrain material's fixed (non-uniform-updating) shading
	// uniforms from the same SUN_*/AMBIENT_* constants setupLights() uses, so
	// the two never drift apart.
	private static terrainLightUniforms(): { sunDirection: THREE.Vector3; sunColor: THREE.Color; ambientColor: THREE.Color } {
		return {
			sunDirection: SUN_POSITION.clone().normalize(),
			sunColor: new THREE.Color(SUN_COLOR_HEX).multiplyScalar(SUN_INTENSITY),
			ambientColor: new THREE.Color(AMBIENT_COLOR_HEX).multiplyScalar(AMBIENT_INTENSITY),
		};
	}

	// Decoded/uploaded once for the whole plugin session and reused by every
	// Land3DView instance (and every rebuildGrass() call within one) — these
	// are real image assets (see grassSprites.ts), not cheap-to-regenerate
	// procedural geometry, so unlike the tree/water materials below they're
	// deliberately NOT recreated on every rebuild.
	private static grassTextureCache: THREE.Texture[] | null = null;

	private static loadGrassTextures(): THREE.Texture[] {
		if (!Land3DView.grassTextureCache) {
			const loader = new THREE.TextureLoader();
			Land3DView.grassTextureCache = GRASS_BLADE_TEXTURES.map((dataUri) => {
				const texture = loader.load(dataUri);
				texture.colorSpace = THREE.SRGBColorSpace;
				return texture;
			});
		}
		return Land3DView.grassTextureCache;
	}

	// Derives the terrain shader's uBumpSeed from the same per-session random
	// seed grass placement uses, so both "unsaved concept" details shuffle
	// together on every open rather than needing two unrelated random calls.
	private static bumpSeedFromSessionSeed(seed: number): THREE.Vector2 {
		const rng = mulberry32(seed ^ 0x9e3779b9);
		return new THREE.Vector2(rng() * 1000, rng() * 1000);
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
		this.rebuildGrass();
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
		const metersPerCell = this.data.metersPerCell;
		const minCx = chunkX * size;
		const minCy = chunkY * size;
		const verts = size + 1;

		const positions = new Float32Array(verts * verts * 3);
		const colors = new Float32Array(verts * verts * 3);
		const uvs = new Float32Array(verts * verts * 2);
		const tileIndices = new Float32Array(verts * verts);
		let vi = 0;
		let ci = 0;
		let ui = 0;
		let ti = 0;
		for (let gy = 0; gy < verts; gy++) {
			for (let gx = 0; gx < verts; gx++) {
				const cx = minCx + gx;
				const cy = minCy + gy;
				const h = grid.getHeight(cx, cy);
				const type = grid.getTerrain(cx, cy);

				positions[vi++] = cx * cellSize;
				positions[vi++] = h * this.worldUnitsPerMeter;
				positions[vi++] = cy * cellSize;

				const [r, g, b] = type ? bandedTerrainColor(type, h) : [90, 90, 90];
				colors[ci++] = r / 255;
				colors[ci++] = g / 255;
				colors[ci++] = b / 255;

				// World-space meters (not 0..1-per-chunk) so the noise pattern
				// is continuous across chunk seams instead of resetting phase
				// at every chunk boundary — this is what the fragment shader
				// samples its per-material noise from directly.
				uvs[ui++] = cx * metersPerCell;
				uvs[ui++] = cy * metersPerCell;

				tileIndices[ti++] = terrainTileIndex(type, h, grid.getDetail(cx, cy));
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
		geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
		geometry.setAttribute("tileIndex", new THREE.BufferAttribute(tileIndices, 1));
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
					const y = (grid.getHeight(cx, cy) - WATER_DEPRESSION_METERS) * this.worldUnitsPerMeter;

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

		// Ripple amplitude is kept well under WATER_DEPRESSION_METERS (scaled
		// by the same worldUnitsPerMeter) so a wave crest never pokes back up
		// through the terrain it's sitting below.
		const material = new THREE.ShaderMaterial({
			transparent: true,
			side: THREE.DoubleSide,
			uniforms: {
				uTime: { value: this.elapsed },
				uRippleAmplitude: { value: 0.12 * this.worldUnitsPerMeter },
			},
			vertexShader: /* glsl */ `
				uniform float uTime;
				uniform float uRippleAmplitude;
				varying vec2 vWorldXZ;
				void main() {
					vWorldXZ = position.xz;
					vec3 p = position;
					p.y += (sin((p.x + uTime * 18.0) * 0.06) + cos((p.z + uTime * 14.0) * 0.08)) * uRippleAmplitude * 0.5;
					gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
				}
			`,
			fragmentShader: /* glsl */ `
				uniform float uTime;
				varying vec2 vWorldXZ;

				float hash(vec2 p) {
					p = fract(p * vec2(123.34, 456.21));
					p += dot(p, p + 45.32);
					return fract(p.x * p.y);
				}
				float noise(vec2 p) {
					vec2 i = floor(p);
					vec2 f = fract(p);
					float a = hash(i);
					float b = hash(i + vec2(1.0, 0.0));
					float c = hash(i + vec2(0.0, 1.0));
					float d = hash(i + vec2(1.0, 1.0));
					vec2 u = f * f * (3.0 - 2.0 * f);
					return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
				}

				void main() {
					// Two noise layers scrolling along a fixed direction at
					// different speeds/scales, blended — reads as flowing
					// current rather than a stationary standing-wave pattern.
					vec2 flowDir = normalize(vec2(1.0, 0.4));
					vec2 flowUv = vWorldXZ * 0.08;
					float n1 = noise(flowUv + flowDir * uTime * 0.6);
					float n2 = noise(flowUv * 1.7 - flowDir * uTime * 0.9 + 5.0);
					float flow = mix(n1, n2, 0.5);
					float wave = sin((vWorldXZ.x * 0.12) + uTime * 1.6) * 0.5 + sin((vWorldXZ.y * 0.1) - uTime * 1.1) * 0.5;
					vec3 base = vec3(0.14, 0.3, 0.53);
					vec3 highlight = vec3(0.45, 0.68, 0.85);
					float mixAmount = clamp(wave * 0.35 + 0.35 + flow * 0.5, 0.0, 1.0);
					vec3 color = mix(base, highlight, mixAmount);
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
