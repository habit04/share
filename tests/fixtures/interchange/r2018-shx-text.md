# Native SHX TEXT reference

This synthetic R2018 ASCII DXF contains 20 TEXT entities: five diagnostic cases for each of `txt.shx`, `simplex.shx`, `romans.shx` and `romant.shx`. It contains no font programs, user drawings or private paths. The installed fonts were read only, using AutoCAD 2027 Core Console X.60.0.0 in an isolated private profile. Native DXFOUT followed by two AUDIT runs reported zero errors found and zero fixed. No installer or original drawing was changed.

The five cases per font are, in entity order:

1. LEFT `%%c10 %%d %%p`, native diameter/degree/plus-minus controls, height 10.
2. LEFT `Ag` with a CUSTOM STYLE whose creation defaults are width 0.8 and oblique 10 degrees. The entity explicitly used width 1 and oblique 0; native DXFOUT omits groups 41 and 51 at those defaults. Those omissions mean entity defaults 1/0, rather than inheriting the STYLE creation defaults.
3. MIDDLE ` A `, including one leading and one trailing space. Preserve both spaces in group 1.
4. FIT `A `, including one trailing space, between insertion and alignment points 100 units apart. Preserve the trailing space in group 1.
5. RIGHT `AVATAR`, height 10.

The font headers expose above/below values 6/2 for txt and 21/7 for the other three fonts. All four tested installed fonts have Unicode-font type 0, mode 2 and encoding 0. TEXT height scales the above value. This records the tested files' metadata; it does not redistribute those files or make a general font licensing claim.

Native reference measurements (unrotated, height 10):

| Font | RIGHT AVATAR ink right | MIDDLE ` A ` baseline X relative to anchor | FIT `A ` width factor | CUSTOM Ag ink box relative to baseline |
| --- | ---: | ---: | ---: | --- |
| txt | 60 | -15 | 5 | (0, -3.33333333333333)–(16.66666666666667, 10) |
| simplex | 56.19047619047621 | -14.2857142857143 | 5.121951219512195 | (0, -3.33333333333333)–(16.19047619047619, 10) |
| romans | 50.47619047619049 | -14.2857142857143 | 5.384615384615385 | (0.47619047619048, -3.33333333333333)–(15.71428571428571, 10) |
| romant | 57.14285714285710 | -14.7619047619049 | 5.121951219512195 | (0.47619047619048, -3.33333333333333)–(17.61904761904761, 10) |

For all four MIDDLE cases, baseline Y is five units below the alignment point. RIGHT uses the unsheared ink right extent. With a trailing decoded space, FIT uses the full logical advance, and MIDDLE uses half that advance for X. The displayed ink of a FIT string ending in space can stop well before the second alignment point.

Additional private synthetic reference cases checked leading-only spaces, all-space strings, LEFT/CENTER/RIGHT/FIT/ALIGNED/MIDDLE, vertical bottom/middle/top, width factors 0.5 and 2, oblique 25 degrees, descenders, and the control-code equivalents U+00B0/U+00B1/U+2205. They established the selected fixture cases, rather than enlarging this fixture. Literal U+2300 was a distinct unsupported glyph and was recorded as a whole-run substitute; it must not be silently aliased to the native diameter symbol.

Validation must explicitly load the four SHX files through SHXFONT/SHXLOAD for native JCad stroke rendering; per-session font resources are not saved in the drawing. Test import, STYLE edit, undo/redo, DXF save and fresh reopen, reload the fonts, and compare group 1 spaces and native anchor/default values. Missing fonts remain a reported/substitute rendering case.

These cases establish a horizontal Unicode SHX TEXT subset. They do not establish BigFont, vertical text, mirrored generation flags, arbitrary Unicode glyph coverage, perfect MTEXT wrapping, fractional-arc support or restricted-font vector export. Native PDF path coordinates were independently calibrated using synthetic colored lines; the native device quantization is about 0.043 mm, with a fixed 0.05 mm ink-bound tolerance. Exact native TEXTBOX and normalized alignment values were recorded separately at 14 decimal places.

A private production Electron check passed actual DXF Open, native SHXFONT/SHXLOAD file selection and reads, STYLE-only font edit with changed metrics, undo/redo, DXF Save As, ordinary Save with an exact prior-byte backup, and fresh disk-copy reopen. Loaded resources changed neither the drawing snapshot nor its dirty state or file binding. The fresh document began with no selected runtime programs and required explicit loading again. Native group 1 strings, including spaces, survived saving; no runtime program bytes, resource identities or private resource paths were saved. Both actual production vector and raster Plot routes produced PDFs without changing the drawing. Only native path dialogs were substituted with test paths; file reads, codecs, backups, plot dialogs and saves used production code. All owned processes were closed.

Actual source Chrome rendering using programs returned by Windows Electron IPC passed 1,333 fixed-tolerance checks, including the 336 placement cases and captured-program stability. Four literal U+2300 runs remained documented substitutes. Thirty-six Canvas, raster plot and vector PDF crops passed 144 independent geometry/pixel-bound checks. Native raster comparison used independently plotted 40-unit row spacing to prevent nearby diagnostic rows from entering crop margins; the pixel tolerance remained two pixels at 300 dpi. Source hashes and the production bundle were unchanged throughout the proof, including the final SHX resource containment reader. These are ink-bound and visible-path checks, not a claim of identical antialiasing.

AutoCAD independently reopened the private production DXF save, reported zero errors in two AUDIT runs, and retained all 20 native text strings, STYLE names and entity defaults. FIT width is a derived value: after changing the txt STYLE to simplex, AutoCAD recalculated its FIT width from 5 to 5.121951219512195. Numeric DXF normalization is checked separately from exact strings, at relative tolerance 1e-11. This does not establish preservation of unrelated unsupported AutoCAD object metadata.

After the combined suite corrected first-export stability for generated text defaults, a fresh production gate repeated SHX loading, STYLE edit/undo/redo, save/backup/reopen/reload and both plot routes against the rebuilt app. It added an original synthetic attribute block to cover an actual generated ATTRIB. All 40 first-export text records (27 TEXT, 12 ATTDEF, one ATTRIB) explicitly included groups 41 and 51; the generated attribute used canonical width 1 and oblique 0. Native reopening passed two zero-error AUDIT runs and retained that attribute's tag, text, STYLE and defaults, as well as the 20 reference TEXT strings. Final writer and application hashes were stable during the gate. The prior geometry proof is reused because all 16 corresponding reader/geometry/plot source hashes remained identical.

Primary references: Autodesk's [Unicode font header and font type flags](https://help.autodesk.com/cloudhelp/2019/ENU/AutoCAD-Customization/files/GUID-D38A5A7B-1877-46B3-8120-32DA5F7430D1.htm), [SHX PDF geometry behavior](https://help.autodesk.com/cloudhelp/2025/ENU/AutoCAD-Core/files/GUID-79A946C3-7E9C-4E7F-B175-23CC55978028.htm), and [special font symbol numbers](https://help.autodesk.com/cloudhelp/2026/ENU/AutoCAD-MAC-Customization/files/GUID-DE941DB5-7044-433C-AA68-2A9AE98A5713.htm). Type 0 is the tested unrestricted vector-outline subset; these references do not establish a blanket right to convert restricted font types into editable outlines.
