# DWG saving on Windows

In the Windows desktop edition, **SAVE** (Ctrl+S) saves to the drawing's current DXF or DWG file. **SAVEAS** (Ctrl+Shift+S) lets you choose **DXF Drawing** or **DWG Drawing** and a destination. A drawing opened from DWG keeps its DWG destination when portable saving is available; Save As lets you keep the original under a different name or switch formats.

The portable DWG writer is included in the Windows desktop app. Users do not need an installed copy of AutoCAD. If the writer is unavailable, JCad explains the error and you can continue saving DXF files.

JCad captures the drawing through its DXF writer, converts the snapshot to DWG and reopens it for validation. Only accepted output replaces the destination atomically; an existing file is kept as `<name>.dwg.bak`. Successful ordinary Save binds the drawing to that destination and marks the captured revision saved. Edits made during conversion remain unsaved. Canceling or a conversion failure keeps the destination, working drawing and recovery records.

Saving cannot restore drawing content that JCad dropped, simplified or could not read during import. Review **IMPORTREPORT** and use Save As to preserve the original. Saving over the imported original asks for confirmation when the report records lost or unreadable content. A recovered DWG drawing retains a conservative overwrite warning because its DXF recovery snapshot cannot establish that all original DWG metadata survived.

For a separate copy, choose **J menu > Export > DWG copy**, or type **EXPORTDWG**. Exporting a copy does not change the working drawing's destination, dirty state, undo history or recovery checkpoint. Use Save to save the working drawing separately. Edits made during export are not included in the captured copy.

DWG saving is Windows only and emits AutoCAD 2018-format DWG (`AC1032`). macOS and Linux desktop updates are paused at 0.4.5; those editions and the browser save DXF copies. Closed DWG sheets are skipped by project-wide updates: open them in tabs to apply changes, then use Save. Autosave and crash recovery continue to use DXF snapshots, including for DWG working files.

The writer refuses unsupported retained records, including REGION, 3DSOLID, BODY, surfaces and proxy entities, rather than omitting them. It reopens its generated DWG and compares supported semantic fields before success. These checks do not cover every CAD extension dictionary, field, dynamic-block behavior or font. The [support matrix](SUPPORT-MATRIX.md) describes the drawing content JCad can hold in the first place. Save As to DXF preserves supported retained DXF records when DWG conversion is refused.

Input and output are each limited to 128 MiB. The helper verifies a Windows Job Object 1 GiB process-memory limit before parsing. It accepts at most 250,000 DXF records, 20,000 blocks and 2,000,000 code/value pairs, with additional bounds on splines and hatch collections. Conversion has a 60-second base deadline plus one second per input MiB, up to 188 seconds. Large valid drawings can be refused by these limits; save DXF when that happens.

Mixed control-point/fit-point splines keep the control-point curve used by JCad. Auxiliary fit points, tangents and construction settings travel in a bounded registered `JCAD_SPLINE_FIT` XDATA packet tied to that curve's geometry. Other CAD software may ignore that auxiliary metadata; it is not a promise of native fit-mode editing. The existing DWG import path may omit application XDATA, as disclosed in IMPORTREPORT.

Published Windows packages require a valid publisher signature on the helper. An unsigned local development build may be blocked by Windows Security. Use a verified signed build for testing on such a system and leave Windows Security enabled.
