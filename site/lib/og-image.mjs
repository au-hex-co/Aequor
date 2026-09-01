// Zero-dependency social share image (1200x630 PNG) for og:image / twitter:image.
// Reuses the site's own palette and brand mark instead of a stock placeholder —
// same ink background + teal/gold glow as the hero section, same diamond mark
// as the header. Hand-rolled PNG encoder (IHDR/IDAT/IEND + zlib deflate via
// node:zlib) so the build stays dependency-free.

import zlib from "node:zlib";

const W = 1200,
	H = 630;

const INK = [0x07, 0x0b, 0x11];
const TEAL = [0x63, 0xc9, 0xbd];
const GOLD = [0xe6, 0xbd, 0x6c];

function mix(a, b, t) {
	return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function glow(px, py, cx, cy, radius, color, strength) {
	const dx = (px - cx) / radius;
	const dy = (py - cy) / (radius * 0.65);
	const d = Math.sqrt(dx * dx + dy * dy);
	return Math.max(0, 1 - d) * strength;
}

// Signed distance-ish test for a diamond (rotated square) outline + fill.
function diamondCoverage(px, py, cx, cy, size, ringWidth) {
	const dx = Math.abs(px - cx);
	const dy = Math.abs(py - cy);
	const d = dx / size + dy / size; // 0 at center, 1 at the diamond edge
	if (d > 1) return 0;
	if (d > 1 - ringWidth) return 1; // outer ring
	if (d < ringWidth * 1.4) return 0.55; // faint inner fill
	return 0;
}

function buildPixels() {
	const pixels = Buffer.alloc(W * H * 3);
	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) {
			let rgb = INK.slice();

			const tealGlow = glow(x, y, W * 0.18, -H * 0.15, W * 0.55, TEAL, 0.16);
			const goldGlow = glow(x, y, W * 1.02, H * 0.02, W * 0.45, GOLD, 0.13);
			rgb = mix(rgb, TEAL, tealGlow);
			rgb = mix(rgb, GOLD, goldGlow);

			const dCov = diamondCoverage(x, y, W * 0.5, H * 0.5, 230, 0.045);
			if (dCov > 0) rgb = mix(rgb, GOLD, dCov);

			const idx = (y * W + x) * 3;
			pixels[idx] = Math.round(rgb[0]);
			pixels[idx + 1] = Math.round(rgb[1]);
			pixels[idx + 2] = Math.round(rgb[2]);
		}
	}
	return pixels;
}

function crc32(buf) {
	let c;
	const table = crc32.table || (crc32.table = (() => {
		const t = new Uint32Array(256);
		for (let n = 0; n < 256; n++) {
			c = n;
			for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
			t[n] = c >>> 0;
		}
		return t;
	})());
	let crc = 0xffffffff;
	for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
	const typeBuf = Buffer.from(type, "ascii");
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length, 0);
	const crcBuf = Buffer.alloc(4);
	crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
	return Buffer.concat([len, typeBuf, data, crcBuf]);
}

export function generateOgImage() {
	const pixels = buildPixels();

	// Add a filter-type byte (0 = none) at the start of every scanline.
	const raw = Buffer.alloc(H * (1 + W * 3));
	for (let y = 0; y < H; y++) {
		const srcStart = y * W * 3;
		const dstStart = y * (1 + W * 3);
		raw[dstStart] = 0;
		pixels.copy(raw, dstStart + 1, srcStart, srcStart + W * 3);
	}

	const idat = zlib.deflateSync(raw, { level: 9 });

	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(W, 0);
	ihdr.writeUInt32BE(H, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // color type: truecolor RGB
	ihdr[10] = 0;
	ihdr[11] = 0;
	ihdr[12] = 0;

	const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	return Buffer.concat([
		signature,
		chunk("IHDR", ihdr),
		chunk("IDAT", idat),
		chunk("IEND", Buffer.alloc(0)),
	]);
}
