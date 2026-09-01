import { hashSeed, mulberry32 } from "./prng";

// Deterministic, dependency-free 2D noise built on the same hash/PRNG pair
// already used for tree/grass placement (see prng.ts) — every brush and
// decoration that wants "natural-looking randomness" (mountain ridgelines,
// snow patchiness, wind direction, water meander) draws from this instead
// of storing anything: same (x, y, seed) always regenerates the same value,
// so nothing here needs to be saved to the map file.

function latticeValue(ix: number, iy: number, seed: number): number {
	return mulberry32(hashSeed(ix, iy, seed))();
}

function smoothstep(t: number): number {
	return t * t * (3 - 2 * t);
}

// Bilinearly-interpolated value noise, 0..1.
export function valueNoise2D(x: number, y: number, seed: number): number {
	const x0 = Math.floor(x);
	const y0 = Math.floor(y);
	const tx = smoothstep(x - x0);
	const ty = smoothstep(y - y0);

	const v00 = latticeValue(x0, y0, seed);
	const v10 = latticeValue(x0 + 1, y0, seed);
	const v01 = latticeValue(x0, y0 + 1, seed);
	const v11 = latticeValue(x0 + 1, y0 + 1, seed);

	const top = v00 + (v10 - v00) * tx;
	const bottom = v01 + (v11 - v01) * tx;
	return top + (bottom - top) * ty;
}

// Fractal Brownian motion: several octaves of value noise summed at
// doubling frequency and halving amplitude. Smooth, rolling variation —
// good for gentle terrain and wind fields. 0..1.
export function fbm2D(x: number, y: number, seed: number, octaves = 4): number {
	let amplitude = 0.5;
	let frequency = 1;
	let sum = 0;
	let norm = 0;
	for (let i = 0; i < octaves; i++) {
		sum += amplitude * valueNoise2D(x * frequency, y * frequency, seed + i * 101);
		norm += amplitude;
		amplitude *= 0.5;
		frequency *= 2;
	}
	return norm > 0 ? sum / norm : 0;
}

// Ridged fBm: folds each octave around its midpoint so values pile up near
// sharp ridgelines instead of rolling hills — this is what makes a
// noise-shaped mountain brush look like a real range (peaks and saddles)
// rather than one smooth dome. 0..1, peaks near ridges.
export function ridgedFbm2D(x: number, y: number, seed: number, octaves = 4): number {
	let amplitude = 0.5;
	let frequency = 1;
	let sum = 0;
	let norm = 0;
	for (let i = 0; i < octaves; i++) {
		const n = valueNoise2D(x * frequency, y * frequency, seed + i * 101);
		const ridge = 1 - Math.abs(n * 2 - 1);
		sum += amplitude * ridge * ridge;
		norm += amplitude;
		amplitude *= 0.5;
		frequency *= 2;
	}
	return norm > 0 ? sum / norm : 0;
}
