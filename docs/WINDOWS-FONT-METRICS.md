# Windows font metrics

This development milestone replaces Hershey measurements for installed TrueType text with
a per-drawing font context. It does not complete priorities 11, 12 or 21.

The Windows desktop bridge reads installed fonts from the Windows Fonts directory. A bounded
SFNT parser validates TrueType outlines, character maps, advances, face names and embedding
permission metadata in separate workers. Only metrics cross this bridge. Source font names
remain unchanged in drawing data; font programs are neither saved in drawings nor redistributed.
Unsupported or missing faces keep actual Canvas fallback measurement and retain their source
STYLE records. SHX text keeps its existing Hershey substitute.

Drawing height uses the installed capital A outline height. Verified glyph origins and unkerned
advances feed Canvas painting, TEXT bounds, hit testing, snapping, block bounds, MTEXT wrapping,
masks, annotation fitting and raster plots. Native TEXT FIT/ALIGNED uses the right overhang;
center/right placement includes bearings. Bottom justification uses the face's Windows descent;
special MIDDLE uses the measured ink midpoint. Ordinary middle/top offsets retain nominal height.
Explicit entity width/oblique defaults still override STYLE values.

Runtime font arrival and STYLE edits invalidate geometry and viewport caches without changing
saved state, dirty status or undo history. Registered metric arrays are copied and frozen. Pending
plots await the drawing's faces and keep captured STYLE/block definitions even if the editor changes.

## Reference and limits

Private synthetic DXF drawings were opened and normalized by installed AutoCAD 2027, with zero
AUDIT errors. Arial, Arial Bold, Courier New and Times New Roman native TEXTBOX and PDF positions
establish capital-height normalization, fitting, bearings and vertical placement. Font programs and
embedded-font reference PDFs stay in private worktree directories. The committed fixture contains
only DXF font references and geometry.

Ordinary glyphs use bearing-corrected outline boxes. Verified composite metric ownership uses its
child origin while retaining the parent's advance. Unverified composite origins, monochrome bitmap
glyphs, missing glyphs, contextual scripts and combining sequences use actual Canvas measurement/shaping. Rasterization,
hinting and unusual Unicode glyphs can still differ from native CAD. Native TEXTBOX can clamp
overflowing glyphs to face bounds even when their visible ink extends farther; selection bounds
keep visible outline extent, so special MIDDLE for these cases remains approximate.

MTEXT now attaches each default-aligned line by ink bearings and includes first-line ascent and
lowest descender in its vertical anchor. Wrapping uses ink span while pen placement retains advances;
explicit paragraph alignment keeps reference-width slack. Native AP1/5/9 and Times width55/60
comparisons pass. Exact tall-glyph line leading, inline font changes/tracking and automatic column
balancing remain open. Existing formatting source is
retained. Reader-omitted leader/table font fields require the separate DWG workstream.

Vector PDF still uses Helvetica/Helvetica-Bold or stroke paths and does not embed installed fonts.
This milestone improves Canvas and raster plotting; exact vector PDF font fidelity remains priority 12.
Real SHX decoding remains priority 21. CFF OpenType, variable/color fonts and unverified font structures
fall back without claiming native metric support. No installer or installed-release validation is implied.
