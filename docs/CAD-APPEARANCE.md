# CAD transparency and named colors

Entity and layer appearance keeps ACI color, true-color RGB, and the supplied named/color-book identity as separate values. DXF group 430 is retained exactly, including a `Book$Name` identity. JCad uses the supplied RGB or ACI fallback to draw it; it does not load vendor color-book palettes or infer a missing RGB value from a name.

Transparency is an opacity byte: 0 is fully transparent and 255 is opaque. DXF group 440 carries a serialized method, not a percentage or an untagged byte. The supported values are ByLayer (`0`), ByBlock (`0x01000000`), and explicit alpha (`0x02000000 + alpha`). Invalid method bits and out-of-range alpha are reported instead of being masked into a plausible value. Layer transparency is written through the registered `AcCmTransparency` application's XDATA group 1071; the reader also accepts a layer group 440 value.

Nested block references select the alpha source. ByBlock uses the enclosing reference's appearance; ByLayer uses the entity's effective layer, including layer-0 inheritance. Explicit alpha overrides both. These source values are not multiplied together. Canvas preview and vector PDF use the same resolution; a temporary selection/ghost alpha remains a separate display multiplier. PDF plots emit stroke and fill opacity through PDF 1.4 ExtGState resources in color, grayscale and monochrome modes.

Native appearance survives DXF export/reimport, geometric transforms, permanent explosion, clipboard copies, document sessions, symbol creation and user-library JSON. MATCHPROP copies RGB, name and transparency and clears old destination overrides when the source has none. Drawings with transparency use AutoCAD 2010 DXF (`AC1024`); RGB or named-color drawings use at least AutoCAD 2004 (`AC1018`). ACI-only drawings retain AutoCAD 2000 output when no other native property requires a newer format. The highest required version anywhere in the drawing wins.

DWG import preserves the appearance fields exposed by the installed LibreDWG converter. Its entity `alpha_type` values differ from serialized DXF methods: 0 is ByLayer, 1 is ByBlock and 3 accompanies an explicit alpha byte. The converter currently omits the separate color-book portion and layer transparency XDATA/method in some records. A default layer alpha of zero cannot safely distinguish an opaque/default layer from an explicit fully transparent one. JCad reports this reader limitation and keeps unambiguous exposed values; it does not claim complete DWG metadata fidelity.

The hand-authored `tests/fixtures/interchange/r2010-appearance.dxf` is independent of JCad's writer. Its regressions check layer/entity codes, UTF-8 names, nested alpha inheritance, screen/PDF output and persistence. An actual AutoCAD AUDIT is an additional integration check; the fixture tests alone do not establish interoperability with every CAD application.

## Format references

- [Autodesk common entity group codes](https://help.autodesk.com/cloudhelp/2023/ENU/AutoCAD-DXF/files/GUID-3610039E-27D1-4E23-B6D3-7E60B22BB5BD.htm) documents groups 420, 430 and 440.
- [Autodesk transparency methods](https://help.autodesk.com/cloudhelp/2018/ENU/OARX-RefGuide/files/OREF-AcCmTransparency__transparencyMethod.html) and [alpha semantics](https://help.autodesk.com/cloudhelp/2018/ENU/OARX-RefGuide/files/OREF-AcCmTransparency__setAlpha_Adesk__UInt8.html) define inheritance and 0–255 opacity.
- [LibreDWG's color structure](https://github.com/LibreDWG/libredwg/blob/master/include/dwg.h) defines the reader's alpha methods and separate name/book-name fields.
