export const TERRAIN_VIEW_TYPE = "cartographer-terrain-view";
export const CANVAS_VIEW_TYPE = "cartographer-canvas-view";

// A single-segment extension (not "cartographer.json") so it can be
// registered with Obsidian via registerExtensions() without colliding with
// every other .json file in the vault — TFile.extension is only ever the
// substring after the last dot. Registering it is also what makes the file
// show up in the File Explorer at all: Obsidian hides unrecognized
// extensions from the tree by default. Content is still plain JSON text.
export const MAP_FILE_EXTENSION = "cartomap";
