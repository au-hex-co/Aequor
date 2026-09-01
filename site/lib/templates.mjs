// All internal hrefs/srcs generated anywhere in this module use root-relative
// paths ("/world/tellus.html"). finalizeLinks() rewrites them to real
// relative paths right before a page is written, so the whole site works
// unmodified whether it's served from a domain root or a GitHub Pages
// project subpath (https://user.github.io/Repo/).

// Published at the GitHub Pages project URL for au-hex-co/Aequor. Used only
// for the absolute URLs required by canonical/OG tags, JSON-LD, and the
// sitemap — every in-page link stays root-relative via finalizeLinks above.
export const SITE_URL = "https://au-hex-co.github.io/Aequor";
export const SITE_NAME = "Aequor Codex";

export function finalizeLinks(html, pageUrl) {
	const depth = pageUrl.split("/").length - 2; // "/world/x.html" -> 1
	const prefix = depth > 0 ? "../".repeat(depth) : "./";
	return html.replace(/(href|src)="\/([^"]*)"/g, (_, attr, p) => {
		return `${attr}="${prefix}${p === "" ? "index.html" : p}"`;
	});
}

const NAV = [
	{ label: "World", url: "/world/index.html", key: "world" },
	{ label: "Characters", url: "/characters/index.html", key: "characters" },
	{ label: "Concepts", url: "/concepts/index.html", key: "concepts" },
	{ label: "Gameplay", url: "/gameplay/index.html", key: "gameplay" },
	{ label: "Timeline", url: "/timeline/index.html", key: "timeline" },
	{ label: "Sources", url: "/sources/index.html", key: "sources" },
	{ label: "Maps", url: "/maps/index.html", key: "maps" },
	{ label: "Open Questions", url: "/questions/index.html", key: "questions" },
];

function navHtml(activeKey) {
	const items = NAV.map(
		(item) =>
			`<li><a href="${item.url}" class="${item.key === activeKey ? "is-active" : ""}">${item.label}</a></li>`
	).join("");
	return `
	<header class="site-header">
		<div class="site-header__inner">
			<a class="brand" href="/index.html">
				<span class="brand__mark" aria-hidden="true">&#9670;</span>
				<span class="brand__text">Aequor <em>Codex</em></span>
			</a>
			<button class="nav-toggle" id="navToggle" aria-expanded="false" aria-controls="siteNav">
				<span></span><span></span><span></span>
				<span class="sr-only">Menu</span>
			</button>
			<nav class="site-nav" id="siteNav">
				<ul>${items}</ul>
			</nav>
		</div>
	</header>`;
}

function footerHtml() {
	return `
	<footer class="site-footer">
		<div class="site-footer__inner">
			<p>Aequor Codex — the worldbuilding wiki for <strong>Merchant of Fate</strong>. Generated from the vault's markdown; painted maps rendered from live Cartographer data.</p>
			<p class="site-footer__meta">Source vault lives in this repository under <code>wiki/</code>. Built with a zero-dependency static generator in <code>site/</code>.</p>
		</div>
	</footer>`;
}

export function metaChips(frontmatter) {
	const chips = [];
	if (frontmatter.type) chips.push(`<span class="chip">${frontmatter.type}</span>`);
	if (frontmatter.status) chips.push(`<span class="chip chip--status chip--${frontmatter.status}">${frontmatter.status}</span>`);
	if (frontmatter.updated) chips.push(`<span class="chip chip--muted">updated ${frontmatter.updated}</span>`);
	if (Array.isArray(frontmatter.tags)) {
		for (const t of frontmatter.tags) chips.push(`<span class="chip chip--tag">#${t}</span>`);
	}
	if (!chips.length) return "";
	return `<div class="meta-chips">${chips.join("")}</div>`;
}

export function tocHtml(headings) {
	const items = (headings || []).filter((h) => h.level <= 3);
	if (items.length < 2) return "";
	const lis = items
		.map((h) => `<li class="toc__lvl${h.level}"><a href="#${h.id}">${h.text}</a></li>`)
		.join("");
	return `<nav class="toc" aria-label="On this page"><p class="toc__label">On this page</p><ul>${lis}</ul></nav>`;
}

export function backlinksHtml(list) {
	if (!list || !list.length) return "";
	const items = list.map((l) => `<li><a href="${l.url}">${l.title}</a></li>`).join("");
	return `<section class="backlinks"><h2>Linked from</h2><ul>${items}</ul></section>`;
}

export function breadcrumbsHtml(crumbs) {
	if (!crumbs || !crumbs.length) return "";
	const items = crumbs
		.map((c, i) =>
			i === crumbs.length - 1
				? `<span aria-current="page">${c.label}</span>`
				: `<a href="${c.url}">${c.label}</a>`
		)
		.join('<span class="crumb-sep">/</span>');
	return `<nav class="breadcrumbs" aria-label="Breadcrumb">${items}</nav>`;
}

export function cardGrid(cards) {
	const items = cards
		.map(
			(c) => `
		<a class="card" href="${c.url}">
			<span class="card__kicker">${c.kicker || ""}</span>
			<h3 class="card__title">${c.title}</h3>
			${c.excerpt ? `<p class="card__excerpt">${c.excerpt}</p>` : ""}
			${c.badge ? `<span class="card__badge">${c.badge}</span>` : ""}
		</a>`
		)
		.join("\n");
	return `<div class="card-grid">${items}</div>`;
}

export function canvasNotice(title) {
	return `
	<div class="canvas-notice">
		<p><strong>${title}</strong> exists as an Excalidraw canvas in the vault, not written prose.</p>
		<p>It isn't rendered on the web yet — open the vault in Obsidian to view the diagram.</p>
	</div>`;
}

const FAVICON =
	"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' rx='22' fill='%23070b11'/%3E%3Cpath d='M50 18 L82 50 L50 82 L18 50 Z' fill='%23cc9f4c'/%3E%3C/svg%3E";

function jsonLdHtml(entries) {
	if (!entries || !entries.length) return "";
	return entries
		.map((obj) => `<script type="application/ld+json">${JSON.stringify(obj)}</script>`)
		.join("\n");
}

export function page({ title, description, section, content, bodyClass = "", url = "/", noindex = false, jsonLd = [] }) {
	// The homepage's own title IS the site name — "Aequor Codex · Aequor
	// Codex" would be a redundant <title>, so every other page gets the
	// " · Aequor Codex" suffix and the home page doesn't.
	const isHome = title === SITE_NAME;
	const docTitle = isHome ? title : `${title} · ${SITE_NAME}`;
	const desc = (description || "").replace(/"/g, "&quot;");
	// Canonicalize the home page to the bare root ("/") rather than
	// "/index.html" — matches how GitHub Pages actually serves it.
	const canonicalPath = url === "/index.html" ? "/" : url;
	const canonical = `${SITE_URL}${canonicalPath}`;
	const ogImage = `${SITE_URL}/assets/og-image.png`;

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${docTitle}</title>
<meta name="description" content="${desc}">
<link rel="canonical" href="${canonical}">
${noindex ? '<meta name="robots" content="noindex, follow">' : ""}
<link rel="icon" href="${FAVICON}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,600;1,9..144,500&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/css/site.css">
<meta name="color-scheme" content="dark light">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${SITE_NAME}">
<meta property="og:title" content="${docTitle}">
<meta property="og:description" content="${desc}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${ogImage}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${docTitle}">
<meta name="twitter:description" content="${desc}">
<meta name="twitter:image" content="${ogImage}">
${jsonLdHtml(jsonLd)}
<style>@view-transition { navigation: auto; }</style>
</head>
<body class="${bodyClass}">
<a class="skip-link" href="#main">Skip to content</a>
${navHtml(section)}
<main id="main">
${content}
</main>
${footerHtml()}
<script src="/assets/js/site.js" defer></script>
${bodyClass.includes("page--map") ? '<script src="/assets/js/map-viewer.js" defer></script>' : ""}
</body>
</html>`;
}
