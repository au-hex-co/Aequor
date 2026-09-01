export interface Camera {
	x: number; // world-space px at the top-left of the viewport
	y: number;
	zoom: number;
}

export interface ContentPointerHandlers {
	onPointerDown?: (wx: number, wy: number, ev: PointerEvent) => void;
	onPointerMove?: (wx: number, wy: number, ev: PointerEvent) => void;
	onPointerUp?: (wx: number, wy: number, ev: PointerEvent) => void;
}

const MIN_ZOOM = 0.02;
const MAX_ZOOM = 12;

// Excalidraw/Canvas-style infinite viewport: a single screen-sized canvas
// with a camera transform, not a browser-scrolled oversized element. Owns
// all pan/zoom input (wheel, middle-drag, space-drag) and only forwards
// pointer gestures to the content handlers (e.g. the brush tool) when the
// gesture isn't a pan.
export class CanvasViewport {
	readonly element: HTMLCanvasElement;
	readonly camera: Camera = { x: 0, y: 0, zoom: 1 };

	private ctx: CanvasRenderingContext2D;
	private resizeObserver: ResizeObserver;
	private drawFn: ((ctx: CanvasRenderingContext2D, camera: Camera, viewW: number, viewH: number) => void) | null = null;
	private overlayFn: ((ctx: CanvasRenderingContext2D, camera: Camera, viewW: number, viewH: number) => void) | null = null;
	private rafHandle: number | null = null;
	private dpr = window.devicePixelRatio || 1;

	private spaceHeld = false;
	private panning = false;
	private lastPanPoint: { x: number; y: number } | null = null;
	private contentPointerId: number | null = null;
	private handlers: ContentPointerHandlers = {};
	private hoverFn: ((wx: number, wy: number) => void) | null = null;
	private hoverEndFn: (() => void) | null = null;

	private onWindowKeyDown = (ev: KeyboardEvent) => {
		if (ev.code === "Space" && !this.isTypingTarget(ev.target)) {
			this.spaceHeld = true;
			this.element.classList.add("is-pan-ready");
			ev.preventDefault();
		}
	};
	private onWindowKeyUp = (ev: KeyboardEvent) => {
		if (ev.code === "Space") {
			this.spaceHeld = false;
			this.element.classList.remove("is-pan-ready");
		}
	};

	constructor(private container: HTMLElement) {
		this.element = container.createEl("canvas", { cls: "cartographer-viewport-canvas" });
		const ctx = this.element.getContext("2d");
		if (!ctx) throw new Error("Cartographer: failed to acquire 2d canvas context");
		this.ctx = ctx;

		this.resizeObserver = new ResizeObserver(() => this.handleResize());
		this.resizeObserver.observe(container);
		this.handleResize();
		this.wireInput();
	}

	destroy(): void {
		this.resizeObserver.disconnect();
		if (this.rafHandle !== null) cancelAnimationFrame(this.rafHandle);
		window.removeEventListener("keydown", this.onWindowKeyDown);
		window.removeEventListener("keyup", this.onWindowKeyUp);
	}

	setDrawCallback(fn: (ctx: CanvasRenderingContext2D, camera: Camera, viewW: number, viewH: number) => void): void {
		this.drawFn = fn;
		this.scheduleDraw();
	}

	// Runs after the content draw, with the camera transform undone — use
	// this for chrome that shouldn't scale with zoom (coordinate labels,
	// grid lines meant to stay a fixed screen weight).
	setOverlayCallback(fn: ((ctx: CanvasRenderingContext2D, camera: Camera, viewW: number, viewH: number) => void) | null): void {
		this.overlayFn = fn;
		this.scheduleDraw();
	}

	// Fires on every pointer move regardless of pan/paint state — independent
	// of setInteractionHandlers so a hover coordinate readout works the same
	// whether or not painting is wired up for the current mode.
	setHoverCallback(onHover: ((wx: number, wy: number) => void) | null, onHoverEnd?: () => void): void {
		this.hoverFn = onHover;
		this.hoverEndFn = onHoverEnd ?? null;
	}

	setInteractionHandlers(handlers: ContentPointerHandlers): void {
		this.handlers = handlers;
	}

	get viewportSize(): { width: number; height: number } {
		return { width: this.element.width / this.dpr, height: this.element.height / this.dpr };
	}

	worldToScreen(wx: number, wy: number): { x: number; y: number } {
		return { x: (wx - this.camera.x) * this.camera.zoom, y: (wy - this.camera.y) * this.camera.zoom };
	}

	screenToWorld(sx: number, sy: number): { x: number; y: number } {
		return { x: sx / this.camera.zoom + this.camera.x, y: sy / this.camera.zoom + this.camera.y };
	}

	// Frames an arbitrary world-space rect (may have negative coordinates —
	// the grid has no fixed origin-anchored extent).
	fitToRect(minX: number, minY: number, maxX: number, maxY: number, padding = 40): void {
		const { width, height } = this.viewportSize;
		const rectW = Math.max(1, maxX - minX);
		const rectH = Math.max(1, maxY - minY);
		const availW = Math.max(1, width - padding * 2);
		const availH = Math.max(1, height - padding * 2);
		const zoom = Math.max(MIN_ZOOM, Math.min(availW / rectW, availH / rectH, MAX_ZOOM) || 1);
		this.camera.zoom = zoom;
		const centerX = (minX + maxX) / 2;
		const centerY = (minY + maxY) / 2;
		this.camera.x = centerX - width / 2 / zoom;
		this.camera.y = centerY - height / 2 / zoom;
		this.scheduleDraw();
	}

	scheduleDraw(): void {
		if (this.rafHandle !== null) return;
		this.rafHandle = requestAnimationFrame(() => {
			this.rafHandle = null;
			this.draw();
		});
	}

	private draw(): void {
		const ctx = this.ctx;
		const { width, height } = this.viewportSize;
		ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
		ctx.clearRect(0, 0, width, height);
		ctx.imageSmoothingEnabled = false;

		ctx.save();
		ctx.scale(this.camera.zoom, this.camera.zoom);
		ctx.translate(-this.camera.x, -this.camera.y);
		this.drawFn?.(ctx, this.camera, width, height);
		ctx.restore();

		// Overlay draws after the content transform is restored, in plain
		// CSS-px screen space, so text/lines stay a fixed, legible size
		// regardless of zoom instead of scaling with the map.
		this.overlayFn?.(ctx, this.camera, width, height);
	}

	private handleResize(): void {
		const rect = this.container.getBoundingClientRect();
		this.dpr = window.devicePixelRatio || 1;
		this.element.width = Math.max(1, Math.round(rect.width * this.dpr));
		this.element.height = Math.max(1, Math.round(rect.height * this.dpr));
		this.element.style.width = `${rect.width}px`;
		this.element.style.height = `${rect.height}px`;
		this.scheduleDraw();
	}

	private isTypingTarget(target: EventTarget | null): boolean {
		if (!(target instanceof HTMLElement)) return false;
		return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
	}

	private wireInput(): void {
		this.container.addEventListener("pointerenter", () => {
			window.addEventListener("keydown", this.onWindowKeyDown);
			window.addEventListener("keyup", this.onWindowKeyUp);
		});
		this.container.addEventListener("pointerleave", () => {
			window.removeEventListener("keydown", this.onWindowKeyDown);
			window.removeEventListener("keyup", this.onWindowKeyUp);
			this.spaceHeld = false;
			this.element.classList.remove("is-pan-ready");
		});

		this.element.addEventListener(
			"wheel",
			(ev) => {
				ev.preventDefault();
				if (ev.ctrlKey || ev.metaKey) {
					const rect = this.element.getBoundingClientRect();
					const sx = ev.clientX - rect.left;
					const sy = ev.clientY - rect.top;
					const before = this.screenToWorld(sx, sy);
					const factor = Math.exp(-ev.deltaY * 0.01);
					this.camera.zoom = clamp(this.camera.zoom * factor, MIN_ZOOM, MAX_ZOOM);
					const after = this.screenToWorld(sx, sy);
					this.camera.x += before.x - after.x;
					this.camera.y += before.y - after.y;
				} else {
					this.camera.x += ev.deltaX / this.camera.zoom;
					this.camera.y += ev.deltaY / this.camera.zoom;
				}
				this.scheduleDraw();
			},
			{ passive: false }
		);

		this.element.addEventListener("contextmenu", (ev) => ev.preventDefault());

		this.element.addEventListener("pointerdown", (ev) => {
			const panTrigger = ev.button === 1 || ev.button === 2 || (ev.button === 0 && this.spaceHeld);
			if (panTrigger) {
				ev.preventDefault();
				this.panning = true;
				this.lastPanPoint = { x: ev.clientX, y: ev.clientY };
				this.element.setPointerCapture(ev.pointerId);
				this.element.classList.add("is-panning");
				return;
			}
			if (ev.button !== 0) return;

			this.contentPointerId = ev.pointerId;
			this.element.setPointerCapture(ev.pointerId);
			const world = this.eventToWorld(ev);
			this.handlers.onPointerDown?.(world.x, world.y, ev);
		});

		this.element.addEventListener("pointermove", (ev) => {
			const hoverWorld = this.eventToWorld(ev);
			this.hoverFn?.(hoverWorld.x, hoverWorld.y);

			if (this.panning && this.lastPanPoint) {
				const dx = ev.clientX - this.lastPanPoint.x;
				const dy = ev.clientY - this.lastPanPoint.y;
				this.lastPanPoint = { x: ev.clientX, y: ev.clientY };
				this.camera.x -= dx / this.camera.zoom;
				this.camera.y -= dy / this.camera.zoom;
				this.scheduleDraw();
				return;
			}
			if (this.contentPointerId === ev.pointerId) {
				const world = this.eventToWorld(ev);
				this.handlers.onPointerMove?.(world.x, world.y, ev);
			}
		});

		this.element.addEventListener("pointerleave", () => this.hoverEndFn?.());

		const endPan = () => {
			this.panning = false;
			this.lastPanPoint = null;
			this.element.classList.remove("is-panning");
		};

		this.element.addEventListener("pointerup", (ev) => {
			if (this.panning) {
				endPan();
				return;
			}
			if (this.contentPointerId === ev.pointerId) {
				const world = this.eventToWorld(ev);
				this.handlers.onPointerUp?.(world.x, world.y, ev);
				this.contentPointerId = null;
			}
		});
		this.element.addEventListener("pointercancel", () => {
			endPan();
			this.contentPointerId = null;
		});
	}

	private eventToWorld(ev: PointerEvent): { x: number; y: number } {
		const rect = this.element.getBoundingClientRect();
		return this.screenToWorld(ev.clientX - rect.left, ev.clientY - rect.top);
	}
}

function clamp(v: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, v));
}
