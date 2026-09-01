export interface CellRect {
	minCx: number;
	minCy: number;
	maxCx: number;
	maxCy: number;
}

export function mergeCellRect(a: CellRect | null, b: CellRect): CellRect {
	if (!a) return b;
	return {
		minCx: Math.min(a.minCx, b.minCx),
		minCy: Math.min(a.minCy, b.minCy),
		maxCx: Math.max(a.maxCx, b.maxCx),
		maxCy: Math.max(a.maxCy, b.maxCy),
	};
}
