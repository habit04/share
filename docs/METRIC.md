# Metric drawings

JCad Electrical's symbol library is drawn in inches, like AutoCAD
Electrical's JIC and IEC libraries: a normally-open contact is 0.75" wide,
attribute text is 0.125" high, wire numbers sit 0.05" above the wire. A
drawing can be **imperial** (1 drawing unit = 1 inch) or **metric** (1 drawing
unit = 1 mm). In a metric drawing everything the electrical tools create from
the library is multiplied by **25.4**, the same scale AutoCAD Electrical uses
when a drawing's units are set to millimetres, so the symbols keep their real
size and their pin geometry.

## Where the setting lives

Two places, kept in step by the Drawing Units page and `WDUNITS`:

| Setting | Values | Meaning |
| --- | --- | --- |
| `$INSUNITS` (DXF header) | 1 inches, 4 millimetres (5 cm, 6 m are read as metric) | the drawing's insertion units, what AutoCAD and other programs see |
| WD_M block attribute `UNITS` | `INCHES` / `MM` | the electrical setting stored with the other drawing settings (tag formats, rung spacing …) in the WD_M block at the origin |

When a drawing is opened:

1. a WD_M block with a `UNITS` value decides;
2. otherwise `$INSUNITS` does: 4 (mm), 5 (cm) and 6 (m) are metric, anything
   else imperial. A DXF saved by AutoCAD in millimetres therefore opens metric
   without any further step.

The unit scale (drawing units per library inch) is 1 for inches and 25.4 for
millimetres (2.54 for a centimetre drawing and 0.0254 for a metre drawing when
`$INSUNITS` says so). Code reads it with `drawingUnitScale(doc)` in
`src/electrical/wdm.ts`.

## What changes in a metric drawing

| Item | Imperial | Metric |
| --- | --- | --- |
| Symbol insert scale (AECOMPONENT) | 1 | 25.4 |
| Junction dots (AEWIRE) | 1 | 25.4 |
| Ladder rung spacing default | 1 | 25 mm |
| Ladder width default | 9 | 230 mm |
| Rung reference text height / offset from the rail | 0.125 / 0.25 | 3.175 / 6.35 mm |
| 3-phase bus spacing | 0.5 | 12.7 mm |
| Wire number height / gap to the wire (`ladderMetrics`) | 0.125 / 0.05 | 3.175 / 1.27 mm |
| Rung reference search tolerance | 0.6 | 15.24 mm |
| Snap spacing presets in the status bar | 1/16 … 1 | 1, 2.5, 5, 10, 25 |

The ladder defaults are round millimetre values rather than 25.4 and 228.6;
they are ordinary WD_M settings (Drawing Properties, `AEDRAWINGPROPS`) and can be
changed per drawing. Symbol geometry is always scaled by exactly 25.4 so pins
land where the library expects them.

## Switching a drawing

**Drafting Settings > Drawing Units** (`DSETTINGS 4`, or the status bar's
units menu > *Drawing Units*):

- choose *Inches* or *Millimeters*;
- *Rescale existing objects* (on by default when the drawing is not empty)
  scales every object about the origin by 25.4 (or 1/25.4) so the drawing keeps
  its real size; the WD_M block stays at the origin and the limits scale too.
  Off: existing objects keep their coordinates and only new symbols, ladders
  and wire numbers use the new units;
- *Apply to drawing* sets `$INSUNITS`, the WD_M `UNITS` value and converts the
  ladder settings (untouched defaults become the other system's round
  defaults, custom values convert exactly). It is one undo step.

**Command line**: `WDUNITS` reports the current units and scale;
`WDUNITS MM`, `WDUNITS IN` switch; add `RESCALE` to scale the existing objects
(`WDUNITS MM RESCALE`), or `KEEP` (the default) to leave them. Aliases:
`AEUNITS`, `DRAWINGUNITS`. (AutoCAD Electrical has no `AEMETRIC` /
`AEIMPERIAL` command; its Drawing Properties dialog holds the setting, which is
what the Drawing Units page mirrors.)

`UNITS` (the AutoCAD command) still changes only how lengths are displayed and
`$INSUNITS`; it does not rescale anything. Options > Units changes the status
bar display only.

## Notes and limits

- The block library itself is not duplicated in millimetres: inserts carry the
  scale, like AutoCAD Electrical's scaled library inserts. Exploding a metric
  symbol gives millimetre geometry.
- Title blocks and sheet templates are drawn in inches; insert them with a
  25.4 scale in metric drawings (or rescale an imperial sheet with the Drawing
  Units page).
- Tools outside the electrical set (plain TEXT, DIM) use their own heights and
  dimension styles; set `DIMSCALE` / text heights as usual for millimetres.
- `src/electrical/wires.ts` (AEWIRENO placement) should read its gaps from
  `ladderMetrics(drawingUnitScale(doc))`; see the integration notes in the
  change that introduced this page.
