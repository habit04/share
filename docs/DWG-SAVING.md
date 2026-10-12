# DWG copies on Windows

In the Windows desktop edition, choose **J menu > Export > DWG copy**, or type **EXPORTDWG**. Choose the destination for the DWG copy.

The portable DWG writer is included in the Windows desktop app. Users do not need an installed copy of AutoCAD. If the writer is unavailable, JCad explains the error and you can continue saving DXF files.

JCad exports a snapshot through its DXF writer and converts it to DWG. This cannot restore drawing content that JCad dropped or simplified during import. Review **IMPORTREPORT**, and export to a new file when you need to preserve the original. Selecting the imported original asks for confirmation when the report records lost or unreadable content.

Exporting a DWG copy does not change the working drawing's DXF destination or mark its edits as saved. Use **SAVE** or **SAVEAS** to save the working drawing as DXF. Edits made while conversion runs stay in the working drawing and are not included in the captured copy. Canceling or a conversion failure keeps the working drawing and its recovery records.

This feature is Windows only and emits AutoCAD 2018-format DWG (`AC1032`). macOS and Linux desktop updates are paused at 0.4.5; the browser edition does not provide this export.

The writer refuses unsupported retained records, including REGION, 3DSOLID, BODY, surfaces and proxy entities, rather than omitting them. It reopens its generated DWG and compares supported semantic fields before success. These checks do not cover every CAD extension dictionary, field, dynamic-block behavior or font. The [support matrix](SUPPORT-MATRIX.md) describes the drawing content JCad can hold in the first place.

Input and output are each limited to 128 MiB. The helper verifies a Windows Job Object 1 GiB process-memory limit before parsing. It accepts at most 250,000 DXF records, 20,000 blocks and 2,000,000 code/value pairs, with additional bounds on splines and hatch collections. Conversion has a 60-second base deadline plus one second per input MiB, up to 188 seconds. Large valid drawings can be refused by these limits; save DXF when that happens.

Mixed control-point/fit-point splines keep the control-point curve used by JCad. Auxiliary fit points, tangents and construction settings travel in a bounded registered `JCAD_SPLINE_FIT` XDATA packet tied to that curve's geometry. Other CAD software may ignore that auxiliary metadata; it is not a promise of native fit-mode editing. The existing DWG import path may omit application XDATA, as disclosed in IMPORTREPORT.

Published Windows packages require a valid publisher signature on the helper. An unsigned local development build may be blocked by Windows Security. Use a verified signed build for testing on such a system and leave Windows Security enabled.
