import { App, Modal, Setting } from "obsidian";
import { DEFAULT_METERS_PER_CELL } from "../model/types";

export interface NewMapOptions {
	name: string;
	folder: string;
	metersPerCell: number;
}

export class NewMapModal extends Modal {
	private options: NewMapOptions = {
		name: "New Map",
		folder: "",
		metersPerCell: DEFAULT_METERS_PER_CELL,
	};

	constructor(app: App, private onSubmit: (options: NewMapOptions) => void) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: "New Cartographer map" });
		contentEl.createEl("p", {
			cls: "setting-item-description",
			text: "Maps start empty and expand in any direction as you paint — there's no size to choose up front.",
		});

		new Setting(contentEl).setName("Map name").addText((text) =>
			text.setValue(this.options.name).onChange((value) => {
				this.options.name = value;
			})
		);

		new Setting(contentEl).setName("Folder").setDesc("Leave blank for the vault root.").addText((text) =>
			text.setPlaceholder("worldbuilding/maps").onChange((value) => {
				this.options.folder = value;
			})
		);

		new Setting(contentEl)
			.setName("Meters per cell")
			.setDesc("Real-world scale used by the coordinate grid and hover readout — how many meters one cell represents.")
			.addText((text) =>
				text.setValue(String(this.options.metersPerCell)).onChange((value) => {
					const parsed = parseFloat(value);
					if (!Number.isNaN(parsed) && parsed > 0) this.options.metersPerCell = parsed;
				})
			);

		new Setting(contentEl).addButton((btn) =>
			btn
				.setButtonText("Create")
				.setCta()
				.onClick(() => {
					this.close();
					this.onSubmit(this.options);
				})
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
