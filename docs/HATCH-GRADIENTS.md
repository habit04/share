# Gradient hatch compatibility

The Windows 2D milestone preserves native DXF gradient definitions and renders verified
unshifted LINEAR fills. It does not complete nonlinear/shifted rendering or native DWG
conversion. The ordinary Canvas hatch renderer and descriptor-free pattern behavior remain.

## Retained data and edits

HATCH fields 450/451/452/453/460/461/462/470 and color records 463/63/421 retain
kind, reserved value, dialog mode, count, radians angle, shift, tint, name, color position
and optional ACI/RGB presence. Well-formed unsupported definitions retain their data and
report a display fallback. Malformed values/counts are explicitly rejected through the
existing hatch import report; they are not silently coerced. Export promotes to at least
AutoCAD 2004 DXF, which supports these fields.

HATCHEDIT Properties offers Angle, Shift and explicit Pattern conversion for active
gradients. Edits are undoable. Explicit SOLID conversion keeps the descriptor with kind 0;
inactive data does not change ordinary hatch display or picking. EXPLODE protects retained
gradient data, including mixed selections and gradient block instances. Retained gradient
DWG Save/Save As/Export Copy is refused before writing; DXF fallback keeps unsaved state.
Native AutoCAD rejects a non-solid pattern hatch carrying any gradient tail, including an
inactive empty-color descriptor. Imported combinations retain both pattern and gradient
data but report the export limit and refuse native DXF saving. HATCHEDIT refuses named
pattern conversion instead of introducing this unsaveable state. Ordinary pattern hatches
and solid hatches with inactive descriptors passed independent native AUDIT checks.

## Verified rendering

For LINEAR shift 0, the field projects the world-axis hatch bounding-box corners onto
the gradient angle, then interpolates the two stored sRGB endpoint colors. Explicit RGB
takes precedence; native gradient ACI 0 is black and 7 is white independently of the
entity layer and paper foreground. Single-color dialog flags/tint do not replace stored
endpoint colors. Holes, transparency and existing plot color modes remain effective.

Direct ROTATE/MIRROR/SCALE changes boundary geometry while retaining native angle 460.
INSERT display transforms the block-local gradient frame, including nested nonuniform
instances. Canvas uses the affine inverse's color axis; PDF uses smooth axial shading
under that affine frame and clips the hatch loops. Raster plots share the Canvas path.
Nonfinite frames and page matrices that become singular at PDF numeric precision refuse
plotting before emitting invalid resources; forbidden exponent operands are also rejected.
Permanent standalone transformed frames cannot be represented faithfully by a native
HATCH angle: export explicitly refuses them. Native block definitions plus INSERT save.

## Evidence and limits

The committed eighteen-hatch fixture covers all nine native names at shift 0 and 1.
AutoCAD 2027 AUDIT found zero errors before and after JCad DXF export; all native gradient
tails matched. Additional private native plots established the LINEAR projection,
colors and direct-versus-block transform behavior. Actual Canvas/raster/vector PDF
checks passed 111/111, and the final actual Electron import/edit/undo/save/backup/reopen/
DWG-refusal gate passed 6/6. No original user drawing, installer or other checkout changed.

Nonlinear names, nonzero shifts, unsupported flags and nonstandard color definitions use
a reported solid fill. Their exact spatial fields are still open; no approximation is
claimed. Native DWG conversion belongs to the separate reader/writer workstream.
Associative hatches, gradient creation/color-edit UI and CTB/STB interpretation remain open.

Primary format reference: [Autodesk HATCH DXF groups](https://help.autodesk.com/cloudhelp/2017/ENU/AutoCAD-DXF/files/GUID-C6C71CED-CE0F-4184-82A5-07AD6241F15B.htm).
Native names and shift semantics: [ObjectARX setGradient](https://help.autodesk.com/cloudhelp/2027/ENU/OARX-RefGuide/files/OARX-RefGuide-AcDbHatch__setGradient_AcDbHatch__GradientPatternType_ACHAR_.html),
[setGradientShift](https://help.autodesk.com/cloudhelp/2027/ENU/OARX-RefGuide/files/OARX-RefGuide-AcDbHatch__setGradientShift_float.html).
