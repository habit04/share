# Native polygon viewport fixture

This small drawing was authored for JCad tests, exported from this branch and normalized by
installed AutoCAD 2027 Core Console on 2026-10-12. It contains one model-space line and one
paper-space concave L-shaped viewport with a 30-degree planar view twist. The closed LWPOLYLINE
boundary is linked by native VIEWPORT group 340 with nonrectangular clipping flag 65536.

AutoCAD opened the private input, ran `AUDIT` with zero errors and `DXFOUT` at precision 16.
The independent native-record check confirmed that the clipping flag and boundary pointer
survived, the boundary and viewport shared their paper-space owner, and JCad reopened the
same six vertices. The source was a private, generated test document; no user drawing was
opened or overwritten. Personal paths/usernames were absent from the normalized output.

This proves the polygon DXF case only. It does not certify curved clips, DWG clip import or
the portable DWG writer. `viewport-polygon-clipping.test.ts` covers edit/save/reopen on this
native fixture, disabled clips, shared geometry copies, appearance, budgets and plot paths.
