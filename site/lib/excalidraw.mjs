// Renders an Obsidian Excalidraw canvas's ```compressed-json scene data as
// an inline SVG, so canvas pages show the actual diagram instead of a "not
// rendered" dead end. Shapes are drawn clean (no Rough.js hand-drawn
// wobble) — layout, text, and connections are preserved faithfully, which
// is what these diagrams are actually for.

import { decompressFromBase64 } from "./lzstring.mjs";

const FONT_VAR = { 1: "var(--font-display)", 2: "var(--font-body)", 3: "var(--font-mono)", 5: "var(--font-display)" };
function fontFor(id) {
	return FONT_VAR[id] || "var(--font-body)";
}

function esc(s) {
	return String(s)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function extractScene(rawBody) {
	const m = /```compressed-json\n([\s\S]*?)```/.exec(rawBody);
	if (!m) return null;
	const b64 = m[1].replace(/\s+/g, "");
	let json;
	try {
		json = decompressFromBase64(b64);
	} catch {
		return null;
	}
	if (!json) return null;
	try {
		return JSON.parse(json);
	} catch {
		return null;
	}
}

function rotatePoint(x, y, cx, cy, angle) {
	if (!angle) return [x, y];
	const cos = Math.cos(angle);
	const sin = Math.sin(angle);
	const dx = x - cx;
	const dy = y - cy;
	return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
}

function bboxOf(elements) {
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	const grow = (x, y) => {
		if (x < minX) minX = x;
		if (y < minY) minY = y;
		if (x > maxX) maxX = x;
		if (y > maxY) maxY = y;
	};
	for (const el of elements) {
		const cx = el.x + el.width / 2, cy = el.y + el.height / 2;
		for (const [cx0, cy0] of [
			[el.x, el.y],
			[el.x + el.width, el.y],
			[el.x, el.y + el.height],
			[el.x + el.width, el.y + el.height],
		]) {
			grow(...rotatePoint(cx0, cy0, cx, cy, el.angle || 0));
		}
		if (Array.isArray(el.points)) {
			for (const [px, py] of el.points) grow(el.x + px, el.y + py);
		}
	}
	if (!isFinite(minX)) return null;
	return { minX, minY, maxX, maxY };
}

function shapeMarkup(el, arrowheadColors) {
	const stroke = el.strokeColor || "#1e1e1e";
	const fill = !el.backgroundColor || el.backgroundColor === "transparent" ? "none" : el.backgroundColor;
	const sw = el.strokeWidth ? el.strokeWidth * 1.4 : 1.4;
	const dash =
		el.strokeStyle === "dashed" ? ` stroke-dasharray="9 7"` : el.strokeStyle === "dotted" ? ` stroke-dasharray="2 6"` : "";
	const cx = el.x + el.width / 2, cy = el.y + el.height / 2;
	const transform = el.angle ? ` transform="rotate(${(el.angle * 180) / Math.PI} ${cx} ${cy})"` : "";

	switch (el.type) {
		case "rectangle": {
			const r = el.roundness ? Math.min(el.width, el.height) * 0.09 : 0;
			return `<rect x="${el.x}" y="${el.y}" width="${el.width}" height="${el.height}" rx="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${dash}${transform}/>`;
		}
		case "ellipse":
			return `<ellipse cx="${cx}" cy="${cy}" rx="${el.width / 2}" ry="${el.height / 2}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${dash}${transform}/>`;
		case "diamond": {
			const pts = `${cx},${el.y} ${el.x + el.width},${cy} ${cx},${el.y + el.height} ${el.x},${cy}`;
			return `<polygon points="${pts}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${dash}${transform}/>`;
		}
		case "line":
		case "arrow":
		case "draw":
		case "freedraw": {
			const pts = (el.points || []).map(([px, py]) => `${el.x + px},${el.y + py}`).join(" ");
			if (!pts) return "";
			let markers = "";
			if (el.type === "arrow") {
				arrowheadColors.add(stroke);
				const id = `excal-arrow-${markerId(stroke)}`;
				if (el.endArrowhead !== null && el.endArrowhead !== undefined) markers += ` marker-end="url(#${id})"`;
				if (el.startArrowhead) markers += ` marker-start="url(#${id})"`;
			}
			return `<polyline points="${pts}" fill="none" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"${dash}${markers}${transform}/>`;
		}
		case "text": {
			const size = el.fontSize || 16;
			const anchor = el.textAlign === "left" ? "start" : el.textAlign === "right" ? "end" : "middle";
			const tx = anchor === "start" ? el.x : anchor === "end" ? el.x + el.width : cx;
			const lines = String(el.text || "").split("\n");
			const lineHeight = (el.lineHeight || 1.25) * size;
			const totalHeight = lines.length * lineHeight;
			const startY = el.y + (el.height - totalHeight) / 2 + size * 0.82;
			const tspans = lines
				.map((line, i) => `<tspan x="${tx.toFixed(1)}" y="${(startY + i * lineHeight).toFixed(1)}">${esc(line)}</tspan>`)
				.join("");
			return `<text font-family="${fontFor(el.fontFamily)}" font-size="${size}" fill="${stroke}" text-anchor="${anchor}"${transform}>${tspans}</text>`;
		}
		default:
			return "";
	}
}

function markerId(color) {
	return String(color).replace(/[^a-z0-9]/gi, "");
}

export function renderExcalidrawSvg(rawBody, title) {
	const scene = extractScene(rawBody);
	if (!scene || !Array.isArray(scene.elements)) return null;

	const elements = scene.elements
		.filter((el) => !el.isDeleted && typeof el.x === "number" && typeof el.y === "number")
		.sort((a, b) => (a.index < b.index ? -1 : a.index > b.index ? 1 : 0));
	if (!elements.length) return null;

	const box = bboxOf(elements);
	if (!box) return null;
	const pad = 32;
	const vbX = box.minX - pad;
	const vbY = box.minY - pad;
	const vbW = box.maxX - box.minX + pad * 2;
	const vbH = box.maxY - box.minY + pad * 2;

	const arrowheadColors = new Set();
	const body = elements.map((el) => shapeMarkup(el, arrowheadColors)).join("\n");

	const markers = [...arrowheadColors]
		.map(
			(color) => `<marker id="excal-arrow-${markerId(color)}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${color}"/></marker>`
		)
		.join("");

	return `<figure class="excalidraw-render">
	<svg viewBox="${vbX.toFixed(1)} ${vbY.toFixed(1)} ${vbW.toFixed(1)} ${vbH.toFixed(1)}" role="img" aria-label="${esc(title)} — diagram">
		<defs>${markers}</defs>
		${body}
	</svg>
	<figcaption>Rendered from the vault's Excalidraw canvas — layout and text preserved; hand-drawn stroke styling simplified for the web.</figcaption>
	</figure>`;
}
