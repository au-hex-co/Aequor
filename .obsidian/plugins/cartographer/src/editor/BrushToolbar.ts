import { TerrainType } from "../model/types";
import { TERRAIN_COLORS } from "../rendering/palette";
import { BrushSettings } from "./BrushEngine";

const TERRAIN_ORDER: TerrainType[] = ["plains", "forest", "water", "river", "sand", "road", "mountain", "snow"];

export interface BrushToolbarCallbacks {
	onTypeChange: (type: TerrainType) => void;
	onEraseToggle: (erase: boolean) => void;
	onRadiusChange: (radius: number) => void;
	onFalloffChange: (falloff: number) => void;
	onOpacityChange: (opacity: number) => void;
	onDensityChange: (density: number) => void;
}

export class BrushToolbar {
	private typeButtons = new Map<TerrainType, HTMLButtonElement>();
	private eraseButton: HTMLButtonElement | null = null;

	constructor(
		private container: HTMLElement,
		private settings: BrushSettings,
		private callbacks: BrushToolbarCallbacks
	) {
		this.render();
	}

	private render(): void {
		this.container.empty();
		this.container.addClass("cartographer-brush-toolbar");

		const typeRow = this.container.createDiv({ cls: "cartographer-brush-types" });
		for (const type of TERRAIN_ORDER) {
			const btn = typeRow.createEl("button", { cls: "cartographer-brush-type", text: type });
			btn.style.setProperty("--brush-color", TERRAIN_COLORS[type]);
			btn.addEventListener("click", () => {
				this.settings.erase = false;
				this.callbacks.onEraseToggle(false);
				this.callbacks.onTypeChange(type);
				this.setActiveType(type);
			});
			this.typeButtons.set(type, btn);
		}

		const eraseBtn = typeRow.createEl("button", { cls: "cartographer-brush-type cartographer-brush-erase", text: "eraser" });
		eraseBtn.addEventListener("click", () => {
			this.settings.erase = true;
			this.callbacks.onEraseToggle(true);
			this.setActiveType(null);
		});
		this.eraseButton = eraseBtn;

		this.setActiveType(this.settings.erase ? null : this.settings.type);

		const sliders = this.container.createDiv({ cls: "cartographer-brush-sliders" });
		this.buildNumberField(sliders, "Size", 1, this.settings.radius, (v) => this.callbacks.onRadiusChange(v));
		this.buildSlider(sliders, "Falloff", 0, 1, 0.05, this.settings.falloff, (v) => this.callbacks.onFalloffChange(v));
		this.buildSlider(sliders, "Opacity", 0.05, 1, 0.05, this.settings.opacity, (v) => this.callbacks.onOpacityChange(v));
		this.buildSlider(sliders, "Density", 0, 1, 0.05, this.settings.density, (v) => this.callbacks.onDensityChange(v));
	}

	// No upper bound — a huge stroke is a legitimate thing to want on a map
	// that itself has no size limit. A range input can't represent "no max"
	// so size gets a plain number field instead of a slider.
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

	private buildSlider(
		parent: HTMLElement,
		label: string,
		min: number,
		max: number,
		step: number,
		value: number,
		onChange: (value: number) => void
	): void {
		const wrap = parent.createDiv({ cls: "cartographer-slider" });
		wrap.createEl("label", { text: label });
		const input = wrap.createEl("input", { type: "range" });
		input.min = String(min);
		input.max = String(max);
		input.step = String(step);
		input.value = String(value);
		const valueEl = wrap.createEl("span", { cls: "cartographer-slider-value", text: String(value) });
		input.addEventListener("input", () => {
			const v = parseFloat(input.value);
			valueEl.setText(v.toFixed(2));
			onChange(v);
		});
	}

	private setActiveType(type: TerrainType | null): void {
		for (const [t, btn] of this.typeButtons) {
			btn.toggleClass("is-active", t === type);
		}
		this.eraseButton?.toggleClass("is-active", type === null);
	}
}
