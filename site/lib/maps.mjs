import fs from "node:fs";
import path from "node:path";

function slugify(s) {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

// Splits one .cartomap / .cartographer.json file into a small manifest plus
// one JSON file per painted chunk, so the browser only ever fetches the
// chunks currently in view instead of the whole (multi-MB) map.
export function buildMapSegments(sourcePath, outDir) {
	const raw = fs.readFileSync(sourcePath, "utf8");
	const data = JSON.parse(raw);
	const slug = slugify(data.name || path.basename(sourcePath));

	const mapDir = path.join(outDir, slug);
	const chunksDir = path.join(mapDir, "chunks");
	fs.mkdirSync(chunksDir, { recursive: true });

	const heightKeys = Object.keys(data.heightChunks || {});
	const terrainKeys = Object.keys(data.terrainChunks || {});
	const detailKeys = Object.keys(data.detailChunks || {});
	const allKeys = new Set([...heightKeys, ...terrainKeys, ...detailKeys]);

	let minChunkX = Infinity, minChunkY = Infinity, maxChunkX = -Infinity, maxChunkY = -Infinity;

	for (const key of allKeys) {
		const [cx, cy] = key.split(",").map(Number);
		if (cx < minChunkX) minChunkX = cx;
		if (cy < minChunkY) minChunkY = cy;
		if (cx > maxChunkX) maxChunkX = cx;
		if (cy > maxChunkY) maxChunkY = cy;

		const chunk = {};
		if (data.heightChunks?.[key]) chunk.h = data.heightChunks[key];
		if (data.terrainChunks?.[key]) chunk.t = data.terrainChunks[key];
		if (data.detailChunks?.[key]) chunk.d = data.detailChunks[key];

		const filename = `${cx}_${cy}.json`;
		fs.writeFileSync(path.join(chunksDir, filename), JSON.stringify(chunk));
	}

	const manifest = {
		name: data.name,
		slug,
		version: data.version,
		cellSize: data.cellSize,
		metersPerCell: data.metersPerCell || 1,
		chunkSize: data.chunkSize,
		theme: data.theme,
		bounds: allKeys.size ? { minChunkX, minChunkY, maxChunkX, maxChunkY } : null,
		chunkCount: allKeys.size,
		chunks: [...allKeys],
	};
	fs.writeFileSync(path.join(mapDir, "manifest.json"), JSON.stringify(manifest));

	return manifest;
}
