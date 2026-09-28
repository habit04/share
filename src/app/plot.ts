/**
 * Paper sizes and page layout for PLOT (PDF) and PRINT. The drawing extents are
 * scaled onto a chosen sheet (fit, or a fixed scale) inside the margins, so the
 * image handed to the PDF writer / printer has exactly the paper's proportions.
 */
export interface PaperSize {
  id: string;
  label: string;
  /** Portrait dimensions in inches. */
  width: number;
  height: number;
  /** Electron's named page size, when it has one. */
  electron?: 'A0' | 'A1' | 'A2' | 'A3' | 'A4' | 'Legal' | 'Letter' | 'Tabloid';
}

export const PAPER_SIZES: PaperSize[] = [
  { id: 'fit', label: 'Fit to drawing (custom sheet)', width: 0, height: 0 },
  { id: 'letter', label: 'Letter 8.5 x 11 in', width: 8.5, height: 11, electron: 'Letter' },
  { id: 'legal', label: 'Legal 8.5 x 14 in', width: 8.5, height: 14, electron: 'Legal' },
  { id: 'tabloid', label: 'Tabloid / Ledger 11 x 17 in (ANSI B)', width: 11, height: 17, electron: 'Tabloid' },
  { id: 'ansi-c', label: 'ANSI C 17 x 22 in', width: 17, height: 22 },
  { id: 'ansi-d', label: 'ANSI D 22 x 34 in', width: 22, height: 34 },
  { id: 'ansi-e', label: 'ANSI E 34 x 44 in', width: 34, height: 44 },
  { id: 'arch-c', label: 'Arch C 18 x 24 in', width: 18, height: 24 },
  { id: 'arch-d', label: 'Arch D 24 x 36 in', width: 24, height: 36 },
  { id: 'a4', label: 'ISO A4 210 x 297 mm', width: 8.27, height: 11.69, electron: 'A4' },
  { id: 'a3', label: 'ISO A3 297 x 420 mm', width: 11.69, height: 16.54, electron: 'A3' },
  { id: 'a2', label: 'ISO A2 420 x 594 mm', width: 16.54, height: 23.39, electron: 'A2' },
  { id: 'a1', label: 'ISO A1 594 x 841 mm', width: 23.39, height: 33.11, electron: 'A1' },
  { id: 'a0', label: 'ISO A0 841 x 1189 mm', width: 33.11, height: 46.81, electron: 'A0' },
];

export const PLOT_SCALES: Array<[string, string]> = [
  ['fit', 'Fit to paper'],
  ['1:1', '1:1 (drawing units = inches)'],
  ['1:2', '1:2'],
  ['1:4', '1:4'],
  ['2:1', '2:1'],
];

export interface PlotOptions {
  paper: string;
  orientation: 'auto' | 'landscape' | 'portrait';
  scale: string;
  /** Margin on every side, inches. */
  margin: number;
}

export interface PageLayout {
  /** Sheet size in inches, already oriented. */
  sheet: { width: number; height: number };
  landscape: boolean;
  /** Drawing-units-to-inches factor used. */
  scale: number;
  /** Offset (inches from the sheet's top-left) where the drawing's bounding box starts. */
  origin: { x: number; y: number };
  /** Electron named page size when the paper has one. */
  electron?: PaperSize['electron'];
  /** True when a fixed scale did not fit and was reduced to fit. */
  reducedToFit: boolean;
}

export function paperById(id: string): PaperSize {
  return PAPER_SIZES.find((p) => p.id === id) ?? PAPER_SIZES[0]!;
}

function scaleFactor(scale: string): number | null {
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(scale);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a > 0 && b > 0 ? a / b : null;
}

/**
 * Lay a drawing of size `w` x `h` (drawing units, treated as inches at 1:1) onto the
 * chosen paper. Fit-to-drawing sheets take the drawing size plus margins; fixed sheets
 * are oriented to the drawing unless forced, and the drawing is centred.
 */
export function layoutPage(w: number, h: number, opts: PlotOptions): PageLayout {
  const margin = Math.max(0, Math.min(opts.margin, 5));
  const paper = paperById(opts.paper);
  if (paper.id === 'fit' || paper.width <= 0) {
    const k = scaleFactor(opts.scale) ?? 1;
    const sw = w * k + 2 * margin;
    const sh = h * k + 2 * margin;
    return { sheet: { width: sw, height: sh }, landscape: sw >= sh, scale: k, origin: { x: margin, y: margin }, reducedToFit: false };
  }
  const wantLandscape = opts.orientation === 'landscape' ? true : opts.orientation === 'portrait' ? false : w >= h;
  const sheet = wantLandscape ? { width: paper.height, height: paper.width } : { width: paper.width, height: paper.height };
  const availW = Math.max(0.1, sheet.width - 2 * margin);
  const availH = Math.max(0.1, sheet.height - 2 * margin);
  const fit = Math.min(availW / w, availH / h);
  let k = scaleFactor(opts.scale) ?? fit;
  let reduced = false;
  if (k > fit) {
    k = fit;
    reduced = opts.scale !== 'fit';
  }
  const origin = { x: margin + (availW - w * k) / 2, y: margin + (availH - h * k) / 2 };
  return { sheet, landscape: wantLandscape, scale: k, origin, electron: paper.electron, reducedToFit: reduced };
}
