# Windows SHX font milestone

`SHXFONT` (alias `SHXLOAD`) opens a native Windows picker for one SHX file. The file is read
only, with no general directory grant or automatic search of installed CAD products. Matching
STYLE filenames in that drawing tab use supported native glyphs. The original STYLE and text
remain drawing data; selected programs, paths and decoded geometry remain runtime resources.
Fresh reopen requires explicit loading again. Filename matching ignores ASCII case and preserves
exact non-ASCII spelling, avoiding aliases between distinct Unicode Windows filenames.

Each document session owns its resources. Switching tabs, undoing STYLE edits and loading a
new document cannot reuse another tab's same-basename font. A later successful selection wins
even if an earlier hash finishes later. Failed choices keep the prior valid binding. A plot
captures immutable decoded programs and filename bindings before asynchronous work; later font
selection, tab switches and reloads cannot alter that plot.

## Supported geometry

The reader handles bounded AutoCAD-86 shapes/unifont 1.0 records and supported SHP vector,
pen, scale, position-stack, subshape, displacement, octant-arc and bulge instructions. Horizontal
Unicode fonts supply advances and ink bounds to Canvas, selection/bounds, annotation geometry,
MTEXT measurement and captured plots. Shape resources are decoded; embedded complex-linetype
glyph painting remains a separate milestone.

Native TEXT fitting uses ink right rather than terminal pen-up advance. Centering uses ink
left/right; a final decoded space instead uses the full logical advance from zero. Numeric
space controls and trailing decoration controls follow the same rule. MIDDLE uses the ink
center, BOTTOM uses the header below/above ratio, and oblique shear is applied outside width
factor. DXF omission of TEXT/ATTDEF/ATTRIB 41/51 means entity defaults 1/0, regardless of STYLE
creation defaults. First export emits canonical defaults for generated labels/attributes too.

Canvas and vector PDF share transformed line/cubic-arc paths, keeping physical stroke width
independent of font shear. Vector outlines currently accept only Unicode font header type 0.
Restricted/read-only/unknown headers retain display/raster geometry and use a reported vector
substitute. This is a conservative implementation limit; it does not claim that type 2 can
never be used in a read-only PDF. No proprietary font programs are committed.

## Bounds and validation

Limits include 8 MiB input, 1 MiB total program bytes, 8,192 records, 2,000 bytes per program,
65,536 decoded instructions, 16,384 glyph work units and 65,536 cumulative run work units.
Moves/arcs with the pen up consume work too. Registry limits are 32 resources, 16 MiB loaded
plus pending bytes, four pending hashes, 131,072 cached instructions and 32,768 cached segments.
Reservations precede copying/hashing and remain charged across clearing until hashing settles.
Captured registries share immutable programs with separate glyph caches. These are bounded
data/work limits, not an operating-system RSS guarantee.

The held-file reader checks canonical containment, file identity, size, timestamps and paths
before/after reading. Canonical paths use exact stored spelling: Windows `path.relative` and
Unicode folding can wrongly classify distinct NTFS siblings as contained. Seven actual Windows
junction cases verify Unicode pre/post-read retarget refusal and stable aliases. A file-link
case is explicitly conditional on Windows link privileges; junction checks do run.

Native validation passes **1,477 checks**, including 1,328 exact placement/path comparisons and
144 independent calibrated Canvas/raster/Poppler comparisons. Actual Windows SHXFONT, STYLE
edit/undo/redo, Save As, ordinary Save, exact backup, fresh reopen/reload and vector/raster Plot
routes pass. A final rebuilt-app gate verifies first-export 41/51 defaults on 27 TEXT, 12 ATTDEF
and one generated ATTRIB; its saved drawing passes two native AUDIT0 runs. Native references
use fixed 1e-8 placement and 0.05 mm device-bound tolerances. Contaminated reference crop margins
were replaced by separately plotted rows without widening tolerances. Four missing literal
U+2300 cases remain explicit whole-run substitutes; `%%c` maps to native U+2205.

The committed `interchange/r2018-shx-text.dxf` has 20 synthetic native TEXTs, with two AUDIT0
runs and provenance. Original authored SHP fixtures cover font/shape instructions; installed
font bytes and reference PDFs stay private. Combined validation passes **3,092 tests with 28
conditional skips**, all three TypeScript projects, broad lint, fixtures and production build.
Eight dense benchmarks pass. Source geometry/reader hashes remain verified through the final
writer build `index-CMlY_8w4.js`.

BigFont/packed encodings, vertical and mirrored generation modes, fractional arcs, persistent
scale/vertical run state, contextual shaping, absent glyphs and unsupported programs retain
substitutes. Native MTEXT leading/wrapping, further annotation fitting, older font encodings,
complex-linetype glyph placement and DWG field/reference exposure require further validation.
The broader Unicode save-path identity/admission issue remains priority 24; this font-specific
containment correction does not claim that saving issue is fixed.
