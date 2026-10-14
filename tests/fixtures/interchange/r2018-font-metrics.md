# Native Windows font metrics fixture

This synthetic drawing was authored and normalized in a private directory using
installed AutoCAD 2027 Core Console X.60.0.0 on 2026-10-13. AutoCAD reported
`AUDIT` with zero errors found or fixed, exported ASCII AutoCAD 2018 DXF with
precision 16, and plotted the same source through `DWG To PDF.pc3`. The native
PDF confirmed ArialMT, CourierNewPSMT, TimesNewRomanPSMT and Arial-BoldMT faces.
No user drawing was opened or changed. The committed DXF contains style/font
names and synthetic text; it contains no font programs or private filesystem
paths. Native PDFs remain private because they embed installed font programs.

The drawing contains twenty model-space entities, five for each of the four
styles `ARIAL_ORACLE`, `COURIER_ORACLE`, `TIMES_ORACLE` and `ARIAL_BOLD_ORACLE`.
Each group contains centered, right-aligned, FIT and ALIGNED `TEXT` containing
`AVATAR`, plus top-left `MTEXT` containing `iii iii iii iii iii`. The original
TEXT inputs used nominal height 10, first point x = 20 and second point x = 100;
each MTEXT uses nominal height 10 and reference width 60. AutoCAD recalculated
the alignment values before export, including FIT width and ALIGNED height.

| Installed face | Units/em | A outline maximum y | Center baseline x | Right baseline x | FIT width factor | ALIGNED height |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Arial | 2048 | 1466 | 72.0634379263 | 44.1064120055 | 1.431291188675 | 14.3129118867 |
| Courier New | 2048 | 1170 | 68.4871794872 | 36.9743589744 | 1.269324654190 | 12.6932465419 |
| Times New Roman | 2048 | 1387 | 69.1744772891 | 38.3489545782 | 1.297626008654 | 12.9762600865 |
| Arial Bold | 2048 | 1466 | 70.8969986357 | 41.7939972715 | 1.374428688621 | 13.7442868862 |

Independent native TEXTBOX and font-table checks establish the drawing-height
normalization for these faces as height divided by the uppercase A outline's
maximum y. Native `AVATAR` uses unkerned advances; right/FIT alignment includes
the final ink overhang, and horizontal centering includes a negative initial
bearing. For example, Times has total advance 8533 font units but rightmost ink
at 8551, explaining its native FIT result. These numbers are observations for
the tested installed faces, rather than a promise about every available font.

The native MTEXT plot wraps this string into 4 + 1 words for Arial, Times and
Arial Bold, and five one-word lines for Courier New. Times is a deliberate
boundary case: four words have an advance slightly greater than 60 but fit by
ink span. The subsequent MTEXT milestone uses that span for wrapping while
preserving advances, and compares default/qc/qr at widths55/60 and AP1/5/9 with
native positions. All nine attachment axes also have authored-metric regressions.
Tall-glyph line leading remains approximate; the native iii baseline gaps are
not claimed to match.

A private current-source check on 2026-10-13 passed 62 Chrome checks through
the actual Windows Electron font-metrics IPC: ordinary installed-face metrics,
TEXT alignment, bottom/MIDDLE anchors, STYLE bounds and spatial invalidation,
undo/redo, DXF save/reopen, Canvas ink bounds and captured raster-plot styles.
An owned production Electron application also imported a private copy of this
fixture, edited an Arial STYLE, undid/redid it, saved a private DXF and reopened
it with identical geometry and clean dirty state. Only native file-dialog paths
were test doubles; installed font reads, application filesystem writes and
DXF codecs were real. This does not prove DWG saving, all Unicode shaping or
glyph origins, exact MTEXT layout, SHX fonts, or JCad PDF font embedding.

Native reference semantics are described in Autodesk's
[text-height documentation](https://help.autodesk.com/cloudhelp/2025/ENU/AutoCAD-LT/files/GUID-7BC6132F-BF07-4A49-B8A8-4FCB524EB736.htm)
and [TEXTBOX reference](https://help.autodesk.com/cloudhelp/2026/PTB/AutoCAD-AutoLISP-Reference/files/GUID-D6C31C79-ECBF-4C7D-9285-1CFA95AC0918.htm).
