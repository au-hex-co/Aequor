import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "./frontmatter.mjs";
import { renderMarkdown } from "./markdown.mjs";

function slugify(s) {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function walk(dir) {
	const out = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walk(full));
		else if (entry.name.endsWith(".md")) out.push(full);
	}
	return out;
}

// Maps a wiki-relative path to where the page lives on the published site.
// The vault's folder names are its own working structure (a typo'd
// "Charaters" subfolder, a stray "Lore" grouping); the site route is
// deliberately flatter and doesn't need to mirror it exactly.
function routeFor(section, rest, filenameNoExt) {
	const slug = slugify(filenameNoExt);

	if (section === "world" && rest[0] === "Charaters") return { url: `/world/${slug}.html`, group: "pantheon" };
	if (section === "world") return { url: `/world/${slug}.html`, group: "world" };

	if (section === "characters" && rest[0] === "Lore") return { url: `/characters/lore/${slug}.html`, group: "lore" };
	if (section === "characters") return { url: `/characters/${slug}.html`, group: "characters" };

	if (section === "concepts") return { url: `/concepts/${slug}.html`, group: "concepts" };
	if (section === "sources") return { url: `/sources/${slug}.html`, group: "sources" };

	if (section === "gameplay") return { url: `/gameplay/index.html`, group: "gameplay" };
	if (section === "timeline") return { url: `/timeline/index.html`, group: "timeline" };
	if (section === "meta") return { url: `/meta/index.html`, group: "meta" };
	if (section === "root") return { url: `/${slug}.html`, group: "root" };

	return { url: `/${section}/${slug}.html`, group: section };
}

function isCanvasSource(data, body) {
	return "excalidraw-plugin" in data || body.includes("# Excalidraw Data");
}

function firstH1(body) {
	const m = /^#\s+(.+)$/m.exec(body);
	return m ? m[1].trim() : null;
}

export function loadVault(wikiDir) {
	const files = walk(wikiDir);
	const stubs = [];

	for (const absPath of files) {
		const relPath = path.relative(wikiDir, absPath).split(path.sep).join("/");
		const segments = relPath.split("/");
		const section = segments.length === 1 ? "root" : segments[0];
		const rest = segments.slice(1);
		const filenameNoExt = path.basename(relPath, ".md");
		const isIndex = filenameNoExt.toLowerCase() === "_index";

		const raw = fs.readFileSync(absPath, "utf8");
		const { data, body } = parseFrontmatter(raw);
		const isCanvas = isCanvasSource(data, body);
		const { url, group } = routeFor(section, rest, filenameNoExt);
		const h1 = isCanvas ? null : firstH1(body);
		const title = h1 || filenameNoExt;
		// The page shell renders the title as its own <h1>; drop the vault's
		// matching H1 line from the body so it isn't shown twice.
		const bodyForRender = h1 ? body.replace(/^#\s+.+$/m, "") : body;

		stubs.push({
			absPath,
			relPath,
			section,
			group,
			filenameNoExt,
			slug: slugify(filenameNoExt),
			isIndex,
			isCanvas,
			url,
			title,
			frontmatter: data,
			rawBody: bodyForRender,
		});
	}

	// --- Title index for wikilink resolution ---
	const fullTitleMap = new Map();
	const baseTitleMap = new Map();

	for (const page of stubs) {
		const key = page.title.toLowerCase();
		if (!fullTitleMap.has(key)) fullTitleMap.set(key, page);

		const base = page.title.replace(/\s*\([^)]*\)\s*$/, "").trim().toLowerCase();
		if (base && base !== key) {
			if (!baseTitleMap.has(base)) baseTitleMap.set(base, []);
			baseTitleMap.get(base).push(page);
		}
		// Also index by filename/slug so [[Filename]]-style links resolve even
		// when a page's H1 differs from its filename (e.g. "Aequor" -> "Aequor (deity)").
		const fnKey = page.filenameNoExt.toLowerCase();
		if (!fullTitleMap.has(fnKey)) fullTitleMap.set(fnKey, page);
	}

	function resolveWikilink(target) {
		const key = target.split("#")[0].trim().toLowerCase();
		if (fullTitleMap.has(key)) return fullTitleMap.get(key);
		if (baseTitleMap.has(key)) {
			const candidates = baseTitleMap.get(key);
			const preferred = candidates.find((p) => p.frontmatter.type === "world") || candidates[0];
			return preferred;
		}
		return null;
	}

	// --- Pass 2: render bodies, collect callouts + backlinks ---
	const backlinks = new Map(); // targetUrl -> [{title,url}]
	const allCallouts = []; // {type,title,bodyHtml,source:{title,url}}
	const unresolved = new Map(); // target text -> [{title,url}]

	for (const page of stubs) {
		if (page.isCanvas) continue;

		const ctx = {
			resolveWikilink,
			onWikilink(target, resolved) {
				if (resolved && resolved.url !== page.url) {
					if (!backlinks.has(resolved.url)) backlinks.set(resolved.url, []);
					const list = backlinks.get(resolved.url);
					if (!list.some((l) => l.url === page.url)) list.push({ title: page.title, url: page.url });
				}
				if (!resolved) {
					const key = target.split("#")[0].trim();
					if (!unresolved.has(key)) unresolved.set(key, []);
					const list = unresolved.get(key);
					if (!list.some((l) => l.url === page.url)) list.push({ title: page.title, url: page.url });
				}
			},
			onCallout(c) {
				allCallouts.push({ ...c, source: { title: page.title, url: page.url } });
			},
		};

		const { html, headings } = renderMarkdown(page.rawBody, ctx);
		page.html = html;
		page.headings = headings;
	}

	for (const page of stubs) {
		page.backlinks = backlinks.get(page.url) || [];
	}

	return { pages: stubs, callouts: allCallouts, unresolved, resolveWikilink };
}
