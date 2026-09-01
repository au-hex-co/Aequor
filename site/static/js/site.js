(() => {
	"use strict";

	const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

	// --- Mobile nav toggle ---
	const toggle = document.getElementById("navToggle");
	const nav = document.getElementById("siteNav");
	if (toggle && nav) {
		toggle.addEventListener("click", () => {
			const open = nav.classList.toggle("is-open");
			toggle.setAttribute("aria-expanded", String(open));
		});
	}

	// --- Hero title: wrap words for the wipe-reveal animation ---
	document.querySelectorAll("[data-reveal-text]").forEach((el) => {
		const words = el.textContent.trim().split(/\s+/);
		el.textContent = "";
		words.forEach((word, i) => {
			const wrap = document.createElement("span");
			wrap.className = "reveal-word";
			const inner = document.createElement("span");
			inner.textContent = word;
			inner.style.setProperty("--i", i);
			wrap.appendChild(inner);
			el.appendChild(wrap);
			el.appendChild(document.createTextNode(" "));
		});
	});

	// --- Scroll-triggered reveals (cards, callouts) ---
	// Deliberately not a blanket fade-up: cards clip-wipe in, callouts
	// stamp/settle. See site.css for the actual keyframes.
	if (!reduceMotion && "IntersectionObserver" in window) {
		const io = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting) {
						entry.target.classList.add("is-visible");
						io.unobserve(entry.target);
					}
				}
			},
			{ threshold: 0.15, rootMargin: "0px 0px -8% 0px" }
		);

		document.querySelectorAll(".card").forEach((card, i) => {
			card.style.setProperty("--i", i % 8);
			io.observe(card);
		});
		document.querySelectorAll(".callout, .timeline__era, .timeline-events__item").forEach((c) => io.observe(c));
	} else {
		document.querySelectorAll(".card, .callout, .timeline__era, .timeline-events__item").forEach((el) => el.classList.add("is-visible"));
	}

	// --- Hero constellation: a slow-drifting graph of the pantheon ---
	const canvas = document.getElementById("pantheonConstellation");
	if (canvas && canvas.getContext) {
		const ctx = canvas.getContext("2d");
		let width = 0, height = 0, dpr = Math.min(window.devicePixelRatio || 1, 2);

		const NODE_COUNT = 14;
		const nodes = [];

		function resize() {
			const rect = canvas.parentElement.getBoundingClientRect();
			width = rect.width;
			height = rect.height;
			canvas.width = width * dpr;
			canvas.height = height * dpr;
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		}

		function seedNodes() {
			nodes.length = 0;
			for (let i = 0; i < NODE_COUNT; i++) {
				nodes.push({
					x: Math.random() * width,
					y: Math.random() * height,
					vx: (Math.random() - 0.5) * 0.06,
					vy: (Math.random() - 0.5) * 0.06,
					r: 1 + Math.random() * 1.6,
				});
			}
		}

		resize();
		seedNodes();
		window.addEventListener("resize", () => {
			resize();
		});

		const LINK_DIST = 190;

		function frame() {
			ctx.clearRect(0, 0, width, height);

			for (const n of nodes) {
				n.x += n.vx;
				n.y += n.vy;
				if (n.x < -20 || n.x > width + 20) n.vx *= -1;
				if (n.y < -20 || n.y > height + 20) n.vy *= -1;
			}

			for (let i = 0; i < nodes.length; i++) {
				for (let j = i + 1; j < nodes.length; j++) {
					const a = nodes[i], b = nodes[j];
					const dx = a.x - b.x, dy = a.y - b.y;
					const dist = Math.sqrt(dx * dx + dy * dy);
					if (dist < LINK_DIST) {
						ctx.strokeStyle = `rgba(99, 201, 189, ${0.16 * (1 - dist / LINK_DIST)})`;
						ctx.lineWidth = 1;
						ctx.beginPath();
						ctx.moveTo(a.x, a.y);
						ctx.lineTo(b.x, b.y);
						ctx.stroke();
					}
				}
			}

			for (const n of nodes) {
				ctx.beginPath();
				ctx.fillStyle = "rgba(230, 189, 108, 0.55)";
				ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
				ctx.fill();
			}

			if (!reduceMotion) requestAnimationFrame(frame);
		}

		frame();
	}
})();
