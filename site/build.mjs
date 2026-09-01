import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadVault } from "./lib/vault.mjs";
import { buildMapSegments } from "./lib/maps.mjs";
import { generateOgImage } from "./lib/og-image.mjs";
import {
	page,
	finalizeLinks,
	metaChips,
	tocHtml,
	backlinksHtml,
	breadcrumbsHtml,
	cardGrid,
	canvasNotice,
	SITE_URL,
	SITE_NAME,
} from "./lib/templates.mjs";

const SITE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SITE_DIR, "..");
const WIKI_DIR = path.join(ROOT, "wiki");
const OUT_DIR = path.join(ROOT, "docs");
const STATIC_DIR = path.join(SITE_DIR, "static");
const MAP_SOURCES = [
	{ file: path.join(ROOT, "world", "Map.cartomap") },
	{ file: path.join(ROOT, "Isle of creation.cartographer.json") },
];

// ---------- helpers ----------

function rmrf(dir) {
	fs.rmSync(dir, { recursive: true, force: true });
}

// OneDrive can hold a lock on the directory entry itself even when it's
// empty (sync client, indexer, an open Explorer window) — clearing just the
// contents avoids EPERM/EBUSY on removing the folder handle outright.
function clearDirContents(dir) {
	fs.mkdirSync(dir, { recursive: true });
	for (const entry of fs.readdirSync(dir)) {
		rmrf(path.join(dir, entry));
	}
}

function copyDir(src, dest) {
	fs.mkdirSync(dest, { recursive: true });
	for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
		const s = path.join(src, entry.name);
		const d = path.join(dest, entry.name);
		if (entry.isDirectory()) copyDir(s, d);
		else fs.copyFileSync(s, d);
	}
}

const sitemapUrls = [];

function write(url, html, { noindex = false } = {}) {
	const outPath = path.join(OUT_DIR, url.replace(/^\//, ""));
	fs.mkdirSync(path.dirname(outPath), { recursive: true });
	fs.writeFileSync(outPath, finalizeLinks(html, url));
	if (!noindex) sitemapUrls.push(url);
}

function excerpt(html, len = 150) {
	const text = html
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (text.length <= len) return text;
	return text.slice(0, len).replace(/\s+\S*$/, "") + "…";
}

const SECTION_LABELS = {
	pantheon: { label: "World", url: "/world/index.html" },
	world: { label: "World", url: "/world/index.html" },
	lore: { label: "Characters", url: "/characters/index.html" },
	characters: { label: "Characters", url: "/characters/index.html" },
	concepts: { label: "Concepts", url: "/concepts/index.html" },
	sources: { label: "Sources", url: "/sources/index.html" },
	gameplay: { label: "Gameplay", url: "/gameplay/index.html" },
	timeline: { label: "Timeline", url: "/timeline/index.html" },
};

const NAV_KEY = {
	pantheon: "world",
	world: "world",
	lore: "characters",
	characters: "characters",
	concepts: "concepts",
	sources: "sources",
	gameplay: "gameplay",
	timeline: "timeline",
};

function crumbsFor(vpage) {
	const parent = SECTION_LABELS[vpage.group];
	if (!parent) return [{ label: vpage.title, url: vpage.url }];
	if (parent.url === vpage.url) return [{ label: vpage.title, url: vpage.url }];
	return [parent, { label: vpage.title, url: vpage.url }];
}

function renderArticlePage(vpage) {
	const crumbs = crumbsFor(vpage);
	const head = `<div class="page-head">${breadcrumbsHtml(crumbs)}<h1>${vpage.title}</h1>${metaChips(
		vpage.frontmatter
	)}</div>`;

	const body = vpage.isCanvas ? canvasNotice(vpage.title) : vpage.html;
	const toc = vpage.isCanvas ? "" : tocHtml(vpage.headings);
	const backlinks = backlinksHtml(vpage.backlinks);

	const content = `
	<div class="article-layout">
		<article class="article">
			${head}
			<div class="article__body">${body}</div>
			${backlinks}
		</article>
		${toc ? `<aside class="article-aside">${toc}</aside>` : ""}
	</div>`;

	return page({
		title: vpage.title,
		description: vpage.isCanvas ? `${vpage.title} — an Excalidraw canvas in the Aequor vault.` : excerpt(vpage.html),
		section: NAV_KEY[vpage.group],
		content,
		bodyClass: "page--article",
		url: vpage.url,
		noindex: vpage.group === "meta",
	});
}

// ---------- build ----------

function main() {
	clearDirContents(OUT_DIR);
	copyDir(STATIC_DIR, path.join(OUT_DIR, "assets"));
	fs.writeFileSync(path.join(OUT_DIR, ".nojekyll"), "");

	const vault = loadVault(WIKI_DIR);
	const { pages, callouts, unresolved } = vault;

	// Standalone content pages (sources/_index is folded into the hand-built
	// sources index instead of publishing its own near-duplicate page).
	for (const vpage of pages) {
		if (vpage.group === "sources" && vpage.isIndex) continue;
		write(vpage.url, renderArticlePage(vpage), { noindex: vpage.group === "meta" });
	}

	// ---------- Maps ----------
	const mapsOutDir = path.join(OUT_DIR, "data", "maps");
	const manifests = [];
	for (const { file } of MAP_SOURCES) {
		if (!fs.existsSync(file)) continue;
		manifests.push(buildMapSegments(file, mapsOutDir));
	}
	buildMapsPages(manifests);

	// ---------- Section indexes ----------
	buildWorldIndex(pages);
	buildCharactersIndex(pages);
	buildConceptsIndex(pages);
	buildSourcesIndex(pages);
	buildQuestionsIndex(callouts, unresolved);
	buildHome(pages, callouts, manifests);

	fs.writeFileSync(path.join(OUT_DIR, "assets", "og-image.png"), generateOgImage());
	writeRobotsTxt();
	writeSitemap();

	console.log(`Built ${pages.length} vault pages, ${manifests.length} maps, ${callouts.length} open questions.`);
	console.log(`Output: ${OUT_DIR}`);
}

function writeRobotsTxt() {
	fs.writeFileSync(
		path.join(OUT_DIR, "robots.txt"),
		`User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`
	);
}

function writeSitemap() {
	const today = new Date().toISOString().slice(0, 10);
	const entries = sitemapUrls
		.map((url) => {
			const loc = `${SITE_URL}${url === "/index.html" ? "/" : url}`;
			const priority = url === "/index.html" ? "1.0" : "0.7";
			return `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${today}</lastmod>\n    <priority>${priority}</priority>\n  </url>`;
		})
		.join("\n");
	const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`;
	fs.writeFileSync(path.join(OUT_DIR, "sitemap.xml"), xml);
}

function buildWorldIndex(pages) {
	const pantheon = pages.filter((p) => p.group === "pantheon");
	const worldExtra = pages.filter((p) => p.group === "world");

	const pantheonCards = pantheon.map((p) => ({
		url: p.url,
		title: p.title,
		kicker: "Deity",
		excerpt: p.isCanvas ? "Excalidraw canvas — not yet rendered." : p.rawBody.trim() ? excerpt(p.html, 110) : "No content yet.",
		badge: p.frontmatter.status === "stub" ? "stub" : "",
	}));

	const otherCards = worldExtra.map((p) => ({
		url: p.url,
		title: p.title,
		kicker: p.isCanvas ? "Canvas" : "World",
		excerpt: p.isCanvas ? "Excalidraw canvas — not yet rendered." : excerpt(p.html, 110),
	}));

	const content = `
	<div class="section-head">
		<p class="eyebrow">World</p>
		<h1>The Pantheon &amp; the World of Terra</h1>
		<p class="section-lede">Three first beings — <a href="/world/tellus.html">Tellus</a>, <a href="/world/aequor.html">Aequor</a>, and <a href="/world/anima.html">Anima</a> — made the world out of boredom, then made humanity out of a question they couldn't answer. Everything downstream of that, clans, gods, relics, is a ledger of prices paid.</p>
	</div>
	<section class="section-block">
		<h2>The Pantheon</h2>
		${cardGrid(pantheonCards)}
	</section>
	${otherCards.length ? `<section class="section-block"><h2>Peoples &amp; Places</h2>${cardGrid(otherCards)}</section>` : ""}`;

	write(
		"/world/index.html",
		page({ title: "World", description: "The pantheon and world of Terra in the Aequor Codex.", section: "world", content, url: "/world/index.html" })
	);
}

function buildCharactersIndex(pages) {
	const chars = pages.filter((p) => p.group === "characters");
	const lore = pages.filter((p) => p.group === "lore");
	const primary = lore.find((p) => p.slug === "lore-in-order");
	const fragments = lore.filter((p) => p !== primary);

	const charCards = chars.map((p) => ({
		url: p.url,
		title: p.title,
		kicker: p.isCanvas ? "Canvas" : "Character",
		excerpt: p.isCanvas ? "Excalidraw canvas — not yet rendered." : excerpt(p.html, 110),
	}));

	const loreCards = lore.map((p) => ({
		url: p.url,
		title: p.title,
		kicker: p === primary ? "Reading order" : "Fragment",
		excerpt: excerpt(p.html, 110),
	}));

	const content = `
	<div class="section-head">
		<p class="eyebrow">Characters</p>
		<h1>Characters &amp; the Lore Chronicle</h1>
		<p class="section-lede">The living cast is still thin on the ground — most of it is carried by the origin chronicle for now, told in overlapping drafts as it was pulled from source material. <a href="/characters/lore/lore-in-order.html">Start with the reading order</a>.</p>
	</div>
	${charCards.length ? `<section class="section-block"><h2>Cast</h2>${cardGrid(charCards)}</section>` : ""}
	<section class="section-block">
		<h2>Lore Chronicle</h2>
		${cardGrid(loreCards)}
	</section>`;

	write(
		"/characters/index.html",
		page({ title: "Characters", description: "Characters and the lore chronicle of the Aequor Codex.", section: "characters", content, url: "/characters/index.html" })
	);
}

function buildConceptsIndex(pages) {
	const concepts = pages.filter((p) => p.group === "concepts");
	const cards = concepts.map((p) => ({
		url: p.url,
		title: p.title,
		kicker: p.frontmatter.type || "Concept",
		excerpt: excerpt(p.html, 130),
	}));
	const content = `
	<div class="section-head">
		<p class="eyebrow">Concepts</p>
		<h1>Design Concepts</h1>
		<p class="section-lede">The mechanical vocabulary of <em>Merchant of Fate</em> — how mythology becomes a rule, not just a reference.</p>
	</div>
	<section class="section-block">${cardGrid(cards)}</section>`;
	write(
		"/concepts/index.html",
		page({ title: "Concepts", description: "Design concepts behind Merchant of Fate.", section: "concepts", content, url: "/concepts/index.html" })
	);
}

function buildSourcesIndex(pages) {
	const indexPage = pages.find((p) => p.group === "sources" && p.isIndex);
	const items = pages.filter((p) => p.group === "sources" && !p.isIndex);
	const cards = items.map((p) => ({
		url: p.url,
		title: p.title,
		kicker: "Source",
		excerpt: excerpt(p.html, 130),
	}));
	const intro = indexPage ? indexPage.html : "";
	const content = `
	<div class="section-head">
		<p class="eyebrow">Sources</p>
		<h1>Sources</h1>
		<div class="section-lede">${intro}</div>
	</div>
	<section class="section-block">${cardGrid(cards)}</section>`;
	write(
		"/sources/index.html",
		page({ title: "Sources", description: "Raw source documents behind the Aequor Codex.", section: "sources", content, url: "/sources/index.html" })
	);
}

function buildQuestionsIndex(callouts, unresolved) {
	const order = ["contradiction", "gap", "key-insight"];
	const groups = order
		.map((type) => ({ type, items: callouts.filter((c) => c.type === type) }))
		.filter((g) => g.items.length);
	const other = callouts.filter((c) => !order.includes(c.type));
	if (other.length) groups.push({ type: "other", items: other });

	const LABELS = { contradiction: "Contradictions", gap: "Gaps", "key-insight": "Key Insights", other: "Other notes" };

	const groupHtml = groups
		.map((g) => {
			const items = g.items
				.map(
					(c) => `
			<li class="question-item">
				<div class="question-item__title">${c.title}</div>
				<div class="question-item__body">${c.bodyHtml}</div>
				<a class="question-item__source" href="${c.source.url}#${c.id}">→ ${c.source.title}</a>
			</li>`
				)
				.join("");
			return `<section class="section-block"><h2>${LABELS[g.type]} <span class="count-badge">${g.items.length}</span></h2><ul class="question-list">${items}</ul></section>`;
		})
		.join("\n");

	const unresolvedEntries = [...unresolved.entries()];
	const unresolvedHtml = unresolvedEntries.length
		? `<section class="section-block">
			<h2>Unwritten Pages <span class="count-badge">${unresolvedEntries.length}</span></h2>
			<p class="section-note">Wikilink targets mentioned somewhere in the vault that don't have a page yet.</p>
			<ul class="stub-list">
				${unresolvedEntries
					.map(
						([target, sources]) =>
							`<li><span class="stub-name">${target}</span><span class="stub-from">mentioned in ${sources
								.map((s) => `<a href="${s.url}">${s.title}</a>`)
								.join(", ")}</span></li>`
					)
					.join("")}
			</ul>
		</section>`
		: "";

	const content = `
	<div class="section-head">
		<p class="eyebrow">For Devs</p>
		<h1>Open Questions</h1>
		<p class="section-lede">Every <code>[!gap]</code>, <code>[!contradiction]</code>, and <code>[!key-insight]</code> callout in the vault, pulled up to one place. This page is generated at build time — it's never stale relative to the wiki.</p>
	</div>
	${groupHtml}
	${unresolvedHtml}`;

	write(
		"/questions/index.html",
		page({ title: "Open Questions", description: "Every open design question tracked in the Aequor vault.", section: "questions", content, url: "/questions/index.html" })
	);
}

function buildMapsPages(manifests) {
	const cards = manifests.map((m) => ({
		url: `/maps/${m.slug}.html`,
		title: m.name,
		kicker: "Cartographer map",
		excerpt: `${m.chunkCount} painted chunks · ${m.chunkSize}×${m.chunkSize} cells each · ${m.metersPerCell} m/cell`,
	}));
	const indexContent = `
	<div class="section-head">
		<p class="eyebrow">Maps</p>
		<h1>Painted Maps</h1>
		<p class="section-lede">Rendered client-side from the same terrain and heightmap data the <strong>Cartographer</strong> plugin stores in the vault — chunks stream in only as you pan into them, same as the plugin's own infinite canvas.</p>
	</div>
	<section class="section-block">${cardGrid(cards)}</section>`;
	write("/maps/index.html", page({ title: "Maps", description: "Painted worldbuilding maps.", section: "maps", content: indexContent, url: "/maps/index.html" }));

	for (const m of manifests) {
		const viewerContent = `
		<div class="section-head section-head--tight">
			<p class="eyebrow">Map</p>
			<h1>${m.name}</h1>
			<p class="section-lede">${m.chunkCount} painted chunks. Drag to pan, scroll to zoom. Unpainted ground streams in as parchment until you reach it.</p>
		</div>
		<div class="map-viewer" data-map="${m.slug}">
			<div class="map-viewer__toolbar">
				<button type="button" data-action="zoom-out" aria-label="Zoom out">−</button>
				<button type="button" data-action="zoom-in" aria-label="Zoom in">+</button>
				<button type="button" data-action="fit">Fit map</button>
				<span class="map-viewer__readout" data-readout>—</span>
			</div>
			<canvas data-canvas tabindex="0" role="img" aria-label="Interactive terrain map of ${m.name}. Arrow keys pan, plus and minus zoom, 0 fits the map."></canvas>
			<p class="map-viewer__fallback">Loading terrain… if this doesn't clear, your browser may not support the canvas features this viewer needs.</p>
		</div>`;
		write(
			`/maps/${m.slug}.html`,
			page({
				title: m.name,
				description: `${m.name} — a Cartographer terrain map from the Aequor vault.`,
				section: "maps",
				content: viewerContent,
				bodyClass: "page--map",
				url: `/maps/${m.slug}.html`,
			})
		);
	}
}

function buildHome(pages, callouts, manifests) {
	const realPages = pages.filter((p) => !p.isCanvas && !p.isIndex);
	const openQuestions = callouts.length;
	const chunkTotal = manifests.reduce((sum, m) => sum + m.chunkCount, 0);

	const sectionCards = [
		{ url: "/world/index.html", title: "World", kicker: "Pantheon", excerpt: "Three gods, one bad boredom-fueled decision, and the price that's still being paid for it." },
		{ url: "/characters/index.html", title: "Characters", kicker: "Chronicle", excerpt: "Vesta, Silvia, Ferus — and the name Cedere hasn't earned yet." },
		{ url: "/concepts/index.html", title: "Concepts", kicker: "Design", excerpt: "Relics as mythology made mechanical — and the one rule every future relic has to obey." },
		{ url: "/gameplay/index.html", title: "Gameplay", kicker: "Pillars", excerpt: "Roguelike structure, 2D naval combat, and a protagonist whose name is earned, not given." },
		{ url: "/timeline/index.html", title: "Timeline", kicker: "History", excerpt: "Ten Aetas, dated Before and After the Malum — the age the whole calendar pivots on." },
		{ url: "/maps/index.html", title: "Maps", kicker: "Cartographer", excerpt: `${chunkTotal} painted chunks rendered live from the plugin's own terrain data.` },
	];

	const content = `
	<section class="hero">
		<canvas class="hero__constellation" id="pantheonConstellation" aria-hidden="true"></canvas>
		<div class="hero__inner">
			<p class="eyebrow">A worldbuilding wiki for a pirate roguelike</p>
			<h1 class="hero__title" data-reveal-text>The Aequor Codex</h1>
			<p class="hero__lede">Mythology, mechanics, and every open question behind <strong>Merchant of Fate</strong> — a game where escaping a debt only ever delays it. Built from the vault's own markdown; nothing here is written twice.</p>
			<div class="hero__actions">
				<a class="button button--primary" href="/world/index.html">Start with the pantheon</a>
				<a class="button button--ghost" href="/questions/index.html">See open questions</a>
			</div>
			<dl class="hero__stats">
				<div><dt>${realPages.length}</dt><dd>wiki pages</dd></div>
				<div><dt>${openQuestions}</dt><dd>open questions</dd></div>
				<div><dt>${manifests.length}</dt><dd>painted maps</dd></div>
				<div><dt>${chunkTotal}</dt><dd>terrain chunks</dd></div>
			</dl>
		</div>
	</section>
	<section class="section-block section-block--home">
		<h2>Wander the Codex</h2>
		${cardGrid(sectionCards)}
	</section>
	<section class="section-block section-block--note">
		<h2>A living document</h2>
		<p>This isn't a polished lore bible — it's the working design wiki, gaps and contradictions left in on purpose. The <a href="/questions/index.html">Open Questions</a> page tracks every one automatically, straight from the vault's own <code>[!gap]</code>, <code>[!contradiction]</code>, and <code>[!key-insight]</code> callouts.</p>
	</section>`;

	const description = "The worldbuilding wiki for Merchant of Fate, a mythology-driven pirate roguelike.";
	write(
		"/index.html",
		page({
			title: SITE_NAME,
			description,
			section: "home",
			content,
			bodyClass: "page--home",
			url: "/index.html",
			jsonLd: [
				{
					"@context": "https://schema.org",
					"@type": "WebSite",
					name: SITE_NAME,
					url: SITE_URL,
					description,
				},
			],
		})
	);
}

main();
