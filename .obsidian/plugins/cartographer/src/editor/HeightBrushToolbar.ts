import { HeightBrushMode, HeightBrushSettings } from "./HeightBrushEngine";

const MODES: { id: HeightBrushMode; label: string }[] = [
	{ id: "raise", label: "Raise" },
	{ id: "lower", label: "Lower" },
	{ id: "smooth", label: "Smooth" },
	{ id: "flatten", label: "Flatten" },
];

export interface HeightBrushToolbarCallbacks {
	onModeChange: (mode: HeightBrushMode) => void;
	onRadiusChange: (radius: number) => void;
	onStrengthChange: (strength: number) => void;
}

export class HeightBrushToolbar {
	private modeButtons = new Map<HeightBrushMode, HTMLButtonElement>();

	constructor(
		private container: HTMLElement,
		private settings: HeightBrushSettings,
		private callbacks: HeightBrushToolbarCallbacks
	) {
		this.render();
	}

	private render(): void {
		this.container.empty();
		this.container.addClass("cartographer-brush-toolbar");

		const modeRow = this.container.createDiv({ cls: "cartographer-brush-types" });
		for (const mode of MODES) {
			const btn = modeRow.createEl("button", { cls: "cartographer-brush-type", text: mode.label });
			btn.addEventListener("click", () => {
				this.callbacks.onModeChange(mode.id);
				this.setActiveMode(mode.id);
			});
			this.modeButtons.set(mode.id, btn);
		}
		this.setActiveMode(this.settings.mode);

		const sliders = this.container.createDiv({ cls: "cartographer-brush-sliders" });
		this.buildNumberField(sliders, "Size", 1, this.settings.radius, (v) => this.callbacks.onRadiusChange(v));
		this.buildNumberField(sliders, "Strength (m)", 0.01, this.settings.strength, (v) => this.callbacks.onStrengthChange(v));
	}

	// No upper bound — see BrushToolbar's identical note. Strength in
	// particular must stay uncapped: it's meters of elevation per stamp for
	// raise/lower, and a 10km mountain is just a lot of accumulated stamps.
	private buildNumberField(
		parent: HTMLElement,
		label: string,
		min: number,
		value: number,
		onChange: (value: number) => void
	): void {
		const wrap = parent.createDiv({ cls: "cartographer-slider" });
		wrap.createEl("label", { text: label });
		const input = wrap.createEl("input", { type: "number", cls: "cartographer-number-field" });
		input.min = String(min);
		input.step = "1";
		input.value = String(value);
		input.addEventListener("input", () => {
			const v = parseFloat(input.value);
			if (!Number.isNaN(v) && v >= min) onChange(v);
		});
	}

	private setActiveMode(mode: HeightBrushMode): void {
		for (const [id, btn] of this.modeButtons) {
			btn.toggleClass("is-active", id === mode);
		}
	}
}
