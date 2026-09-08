(() => {
	"use strict";

	const input = document.getElementById("siteSearchInput");
	const results = document.getElementById("siteSearchResults");
	const indexLink = document.getElementById("searchIndexLink");
	if (!input || !results || !indexLink) return;

	let entries = null;
	let loading = null;

	function loadEntries() {
		if (entries) return Promise.resolve(entries);
		if (loading) return loading;
		// indexLink.href (the DOM property, not getAttribute) is the browser's
		// already-resolved absolute URL — it accounts for finalizeLinks' per-page
		// relative-path rewriting, so this works unmodified whether the site is
		// served from a domain root or a GitHub Pages project subpath.
		loading = fetch(indexLink.href)
			.then((r) => r.json())
			.then((data) => {
				entries = data;
				return entries;
			})
			.catch(() => {
				entries = [];
				return entries;
			});
		return loading;
	}

	// Cheap relevance score: title hits beat section hits beat excerpt hits;
	// an exact prefix match on the title beats a mid-string match.
	function score(entry, q) {
		const title = entry.title.toLowerCase();
		const section = entry.section.toLowerCase();
		const excerpt = (entry.excerpt || "").toLowerCase();
		if (title === q) return 100;
		if (title.startsWith(q)) return 90;
		if (title.includes(q)) return 70;
		if (section.includes(q)) return 40;
		if (excerpt.includes(q)) return 20;
		return 0;
	}

	function render(list, q) {
		if (!list.length) {
			results.innerHTML = `<li class="site-search__empty">No matches for “${escapeHtml(q)}”.</li>`;
			results.hidden = false;
			return;
		}
		results.innerHTML = list
			.map(
				(entry, i) => `
			<li>
				<a href="${entry.url}" class="site-search__result" data-index="${i}" role="option">
					<span class="site-search__result-title">${escapeHtml(entry.title)}</span>
					<span class="site-search__result-section">${escapeHtml(entry.section)}</span>
					${entry.excerpt ? `<span class="site-search__result-excerpt">${escapeHtml(entry.excerpt)}</span>` : ""}
				</a>
			</li>`
			)
			.join("");
		results.hidden = false;
	}

	function escapeHtml(s) {
		return String(s)
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;");
	}

	function close() {
		results.hidden = true;
		results.innerHTML = "";
	}

	function search(raw) {
		const q = raw.trim().toLowerCase();
		if (q.length < 2) {
			close();
			return;
		}
		loadEntries().then((list) => {
			const ranked = list
				.map((entry) => ({ entry, s: score(entry, q) }))
				.filter((r) => r.s > 0)
				.sort((a, b) => b.s - a.s)
				.slice(0, 8)
				.map((r) => r.entry);
			render(ranked, q);
		});
	}

	let debounceTimer = null;
	input.addEventListener("input", () => {
		clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => search(input.value), 100);
	});

	input.addEventListener("focus", () => {
		if (input.value.trim().length >= 2 && results.innerHTML) results.hidden = false;
	});

	input.addEventListener("keydown", (e) => {
		const items = results.querySelectorAll(".site-search__result");
		if (!items.length && e.key !== "Escape") return;
		const current = results.querySelector(".site-search__result.is-active");
		let idx = current ? Array.prototype.indexOf.call(items, current) : -1;

		if (e.key === "ArrowDown") {
			e.preventDefault();
			idx = (idx + 1) % items.length;
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			idx = (idx - 1 + items.length) % items.length;
		} else if (e.key === "Enter") {
			if (current) {
				e.preventDefault();
				window.location.href = current.getAttribute("href");
			}
			return;
		} else if (e.key === "Escape") {
			close();
			input.blur();
			return;
		} else {
			return;
		}

		items.forEach((el) => el.classList.remove("is-active"));
		items[idx].classList.add("is-active");
		items[idx].scrollIntoView({ block: "nearest" });
	});

	document.addEventListener("click", (e) => {
		if (!e.target.closest("#siteSearch")) close();
	});
})();
