// Minimal frontmatter parser — handles exactly the subset of YAML this
// vault actually uses: flat `key: value`, quoted strings, inline arrays
// (`tags: [a, b]`), and block list arrays (`tags:\n  - a\n  - b`). Not a
// general YAML parser on purpose — the vault doesn't need one.

function parseScalar(raw) {
	let v = raw.trim();
	if (v === "") return "";
	if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
		return v.slice(1, -1);
	}
	return v;
}

function parseInlineArray(raw) {
	const inner = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
	if (!inner.trim()) return [];
	// Split on commas that aren't inside quotes.
	const parts = [];
	let cur = "";
	let inQuote = null;
	for (const ch of inner) {
		if (inQuote) {
			cur += ch;
			if (ch === inQuote) inQuote = null;
		} else if (ch === '"' || ch === "'") {
			inQuote = ch;
			cur += ch;
		} else if (ch === ",") {
			parts.push(cur);
			cur = "";
		} else {
			cur += ch;
		}
	}
	if (cur.trim()) parts.push(cur);
	return parts.map((p) => parseScalar(p));
}

export function parseFrontmatter(source) {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
	if (!match) return { data: {}, body: source };

	const block = match[1];
	const body = source.slice(match[0].length);
	const lines = block.split(/\r?\n/);
	const data = {};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line.trim()) continue;
		const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
		if (!kv) continue;
		const key = kv[1];
		let rest = kv[2];

		if (rest.trim() === "") {
			// Possible block list on following indented `- ` lines.
			const items = [];
			let j = i + 1;
			while (j < lines.length && /^\s+-\s+/.test(lines[j])) {
				items.push(parseScalar(lines[j].replace(/^\s+-\s+/, "")));
				j++;
			}
			if (items.length) {
				data[key] = items;
				i = j - 1;
				continue;
			}
			data[key] = "";
			continue;
		}

		if (rest.trim().startsWith("[")) {
			data[key] = parseInlineArray(rest);
		} else {
			data[key] = parseScalar(rest);
		}
	}

	return { data, body };
}
