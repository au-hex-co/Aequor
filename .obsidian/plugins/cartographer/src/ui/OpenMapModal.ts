import { App, FuzzySuggestModal, TFile } from "obsidian";

export class OpenMapModal extends FuzzySuggestModal<TFile> {
	constructor(app: App, private files: TFile[], private onChoose: (file: TFile) => void) {
		super(app);
		this.setPlaceholder("Choose a Cartographer map…");
	}

	getItems(): TFile[] {
		return this.files;
	}

	getItemText(file: TFile): string {
		return file.path;
	}

	onChooseItem(file: TFile): void {
		this.onChoose(file);
	}
}
