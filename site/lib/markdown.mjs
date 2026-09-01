// Small, purpose-built markdown -> HTML converter for the Aequor wiki.
// Not CommonMark-complete — it covers exactly what this vault's prose
// actually uses: headings, bold/italic/code, links, wikilinks, callouts,
// lists, tables, and hr/paragraphs. Kept dependency-free on purpose.

const CALLOUT_LABELS = {
	gap: "Gap",
	contradiction: "Contradiction",
	"key-insight": "Key Insight",
};

function escapeHtml(s) {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function slugifyHeading(text) {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

export function renderInline(raw, ctx) {
	let text = escapeHtml(raw);

	// Wikilinks first: [[Target]] or [[Target|Display]]
	text = text.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, display) => {
		const cleanTarget = target.trim();
		const label = (display || target).trim();
		const resolved = ctx.resolveWikilink(cleanTarget);
		if (resolved) {
			ctx.onWikilink && ctx.onWikilink(cleanTarget, resolved);
			return `<a class="wikilink" href="${resolved.url}">${label}</a>`;
		}
		ctx.onWikilink && ctx.onWikilink(cleanTarget, null);
		return `<span class="wikilink wikilink--stub" title="Not written yet">${label}</span>`;
	});

	// Standard markdown links: [text](url)
	text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => {
		const external = /^https?:\/\//.test(url);
		const attrs = external ? ' target="_blank" rel="noopener"' : "";
		return `<a href="${url}"${attrs}>${label}</a>`;
	});

	// Bold, then italic, then highlight, then inline code.
	text = text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
	text = text.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, "$1<em>$2</em>");
	text = text.replace(/==(.+?)==/g, "<mark>$1</mark>");
	text = text.replace(/`([^`]+?)`/g, "<code>$1</code>");

	return text;
}

function renderTable(rows, ctx) {
	const [headerRow, , ...bodyRows] = rows;
	const head = headerRow
		.map((cell) => `<th>${renderInline(cell, ctx)}</th>`)
		.join("");
	const body = bodyRows
		.map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell, ctx)}</td>`).join("")}</tr>`)
		.join("\n");
	return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function splitTableRow(line) {
	return line
		.trim()
		.replace(/^\|/, "")
		.replace(/\|$/, "")
		.split("|")
		.map((c) => c.trim());
}

export function renderMarkdown(body, ctx) {
	const lines = body.replace(/\r\n/g, "\n").split("\n");
	const out = [];
	const headings = [];
	let i = 0;
	let calloutIndex = 0;

	function flushParagraph(buf) {
		if (!buf.length) return;
		out.push(`<p>${renderInline(buf.join(" "), ctx)}</p>`);
	}

	while (i < lines.length) {
		const line = lines[i];

		if (!line.trim()) {
			i++;
			continue;
		}

		// Callout: > [!type] Title
		const calloutStart = /^>\s*\[!([\w-]+)\]\s*(.*)$/.exec(line);
		if (calloutStart) {
			const type = calloutStart[1].toLowerCase();
			const title = calloutStart[2].trim();
			const raw = [];
			i++;
			while (i < lines.length && /^>/.test(lines[i])) {
				raw.push(lines[i].replace(/^>\s?/, ""));
				i++;
			}
			// Split collected lines into paragraphs on blank entries.
			const paras = [];
			let cur = [];
			for (const l of raw) {
				if (!l.trim()) {
					if (cur.length) paras.push(cur.join(" "));
					cur = [];
				} else {
					cur.push(l);
				}
			}
			if (cur.length) paras.push(cur.join(" "));
			const bodyHtml = paras.map((p) => `<p>${renderInline(p, ctx)}</p>`).join("\n");
			const label = CALLOUT_LABELS[type] || type.replace(/-/g, " ").replace(/^\w/, (c) => c.toUpperCase());
			const titleHtml = title ? renderInline(title, ctx) : label;
			const id = `callout-${++calloutIndex}`;
			out.push(
				`<aside class="callout callout--${type}" id="${id}"><div class="callout__head"><span class="callout__kind">${label}</span><span class="callout__title">${titleHtml}</span></div><div class="callout__body">${bodyHtml}</div></aside>`
			);
			ctx.onCallout && ctx.onCallout({ type, title: title || label, bodyHtml, id });
			continue;
		}

		// Table
		if (/^\|.*\|\s*$/.test(line) && lines[i + 1] && /^\|?[\s:|-]+\|?$/.test(lines[i + 1])) {
			const rows = [splitTableRow(line)];
			i += 2;
			while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) {
				rows.push(splitTableRow(lines[i]));
				i++;
			}
			out.push(renderTable([rows[0], null, ...rows.slice(1)], ctx));
			continue;
		}

		// Heading
		const heading = /^(#{1,6})\s+(.*)$/.exec(line);
		if (heading) {
			const level = heading[1].length;
			const text = heading[2].trim();
			const id = slugifyHeading(text);
			headings.push({ level, text, id });
			out.push(`<h${level} id="${id}">${renderInline(text, ctx)}</h${level}>`);
			i++;
			continue;
		}

		// Horizontal rule
		if (/^-{3,}\s*$/.test(line)) {
			out.push("<hr>");
			i++;
			continue;
		}

		// Unordered list
		if (/^[-*]\s+/.test(line)) {
			const items = [];
			while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
				items.push(lines[i].replace(/^[-*]\s+/, ""));
				i++;
			}
			out.push(`<ul>${items.map((it) => `<li>${renderInline(it, ctx)}</li>`).join("")}</ul>`);
			continue;
		}

		// Ordered list
		if (/^\d+\.\s+/.test(line)) {
			const items = [];
			while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
				items.push(lines[i].replace(/^\d+\.\s+/, ""));
				i++;
			}
			out.push(`<ol>${items.map((it) => `<li>${renderInline(it, ctx)}</li>`).join("")}</ol>`);
			continue;
		}

		// Paragraph: accumulate until blank line or a line starting a new block.
		const buf = [line];
		i++;
		while (
			i < lines.length &&
			lines[i].trim() &&
			!/^>\s*\[!/.test(lines[i]) &&
			!/^#{1,6}\s+/.test(lines[i]) &&
			!/^[-*]\s+/.test(lines[i]) &&
			!/^\d+\.\s+/.test(lines[i]) &&
			!/^-{3,}\s*$/.test(lines[i])
		) {
			buf.push(lines[i]);
			i++;
		}
		flushParagraph(buf);
	}

	return { html: out.join("\n"), headings };
}
