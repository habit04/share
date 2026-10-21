/**
 * Native MULTILEADER data (P18 slice 1: MTEXT content).
 *
 * A LeaderEntity with `kind: 'mleader'` and this data present is a native
 * multileader: it is written to DXF as a MULTILEADER entity (AcDbMLeader with a
 * CONTEXT_DATA section) plus an MLEADERSTYLE object, and read back from one.
 * A mleader WITHOUT this data (every pre-P18 save, and block-content imports
 * whose content slice 1 does not model) keeps the legacy LEADER + MTEXT
 * write-back exactly as before; the import report says so, it is not silent.
 *
 * Everything else about a multileader — path vertices, landing (dogleg),
 * arrow, text and its placement — lives on LeaderEntity itself and is shared
 * with plain leaders, so Canvas, selection, grips, transforms and plot (all of
 * which consume `leaderParts`) see no difference. This module holds only the
 * native-only remainder: content kind, style identity, context scale, landing
 * gap and leader-line type, plus the MLEADERSTYLE values JCad synthesizes.
 *
 * Group-code semantics follow Autodesk's DXF reference for MULTILEADER /
 * MLEADERSTYLE and the real AutoCAD specimens already in the tree:
 * tests/leader.test.ts (CONTEXT_DATA entity fixture) and
 * tests/fixtures/interchange/r2018-minsert.dxf (MLEADERSTYLE handle 16F,
 * "Standard"). Constants whose meaning the reference leaves implicit are
 * marked "specimen" below; they mirror those files byte-for-byte in shape.
 */

/** What a native multileader carries. Slice 1 models 'mtext' and 'none';
 *  'block' is slice 2 (PROPOSAL-P18-S2) — the union already names it because
 *  the committed V-2 caller reports modelled block content as such; the block
 *  payload type and codec land with the slice-2 implementation commits. */
export type MLeaderContentType = 'mtext' | 'none' | 'block';

export interface MLeaderNative {
  readonly contentType: MLeaderContentType;
  /** MLEADERSTYLE name (dictionary key). 'Standard' when the source names none. */
  readonly styleName: string;
  /** CONTEXT_DATA group 40: the multileader's overall (annotative) scale factor. */
  readonly scaleFactor: number;
  /** CONTEXT_DATA group 145: gap between the landing and the content. */
  readonly landingGap: number;
  /** Trailing group 170: 0 = no leader lines, 1 = straight, 2 = spline. */
  readonly leaderLineType: 0 | 1 | 2;
  /** Name of the text STYLE the MTEXT content uses (CONTEXT_DATA group 340 names it by handle). */
  readonly textStyleName?: string;
  /**
   * MLEADERSTYLE values captured from the source style object that no
   * entity-level field supplies (slice-1 acceptance must-fix V-1): present
   * only for the groups whose source values diverge from the specimen
   * constants JCad synthesizes, so a read -> write round trip emits the
   * source values instead of silently resetting them to the constants.
   * Absent for authored data and for styles that match the constants.
   */
  readonly styleRetained?: MLeaderStyleRetained;
}

/**
 * The retained MLEADERSTYLE groups (V-1): style-object values with no
 * entity-level source in MLeaderNative. Only divergent groups are present;
 * `mleaderStyleData` falls back to the specimen constants for the rest.
 */
export interface MLeaderStyleRetained {
  /** Style group 46: align space. */
  readonly alignSpace?: number;
  /** Style groups 47/49/140: block-content scale X/Y/Z, retained as one triple. */
  readonly blockScale?: { readonly x: number; readonly y: number; readonly z: number };
  /** Style group 141: block-content rotation. */
  readonly blockRotation?: number;
  /** Style group 271: text attachment direction. */
  readonly textAttachmentDirection?: number;
  /** Style group 272: bottom text attachment direction. */
  readonly bottomTextAttachmentDirection?: number;
  /** Style group 273: top text attachment direction. */
  readonly topTextAttachmentDirection?: number;
  /** Style group 298: undocumented flag observed in AutoCAD-generated objects. */
  readonly flag298?: number;
}

/** The values an MLEADERSTYLE object is synthesized from (slice 1: derived per style name).
 *  Group semantics per Autodesk's MLEADERSTYLE reference (as mapped by the
 *  libredwg-web object types JCad already depends on). */
export interface MLeaderStyleData {
  readonly name: string;
  /** Style group 44: arrowhead size. */
  readonly arrowSize: number;
  /** Style group 45: text height. */
  readonly textHeight: number;
  /** Style group 43: landing (dogleg) length. */
  readonly doglegLength: number;
  /** Style group 42: landing gap. */
  readonly landingGap: number;
  /** Style group 142: overall scale factor. */
  readonly scaleFactor: number;
  /** Style group 170: content type (2 = MTEXT, 0 = none). */
  readonly contentType: 0 | 2;
  /** Style group 172/171-era line type is carried per entity; the style's is straight. */
  readonly leaderLineType: 0 | 1 | 2;
  /** Text STYLE name the content uses (style groups 3 / 342 name it by name and handle). */
  readonly textStyleName: string;
  /** Style group 46: align space (specimen constant unless retained from the source style). */
  readonly alignSpace: number;
  /** Style groups 47/49/140: block-content scale X/Y/Z (constants unless retained). */
  readonly blockScale: { readonly x: number; readonly y: number; readonly z: number };
  /** Style group 141: block-content rotation (constant unless retained). */
  readonly blockRotation: number;
  /** Style group 271: text attachment direction (constant unless retained). */
  readonly textAttachmentDirection: number;
  /** Style group 272: bottom text attachment direction (constant unless retained). */
  readonly bottomTextAttachmentDirection: number;
  /** Style group 273: top text attachment direction (constant unless retained). */
  readonly topTextAttachmentDirection: number;
  /** Style group 298: undocumented flag (constant unless retained). */
  readonly flag298: number;
}

/** AutoCAD's "Standard" multileader style defaults, as the R2018 specimen records them. */
export const STANDARD_MLEADER_STYLE: Omit<MLeaderStyleData, 'name'> = {
  arrowSize: 0.18,
  textHeight: 0.18,
  doglegLength: 0.36,
  landingGap: 0.09,
  scaleFactor: 1,
  contentType: 2,
  leaderLineType: 1,
  textStyleName: 'Standard',
  alignSpace: 0.18,
  blockScale: { x: 1, y: 1, z: 1 },
  blockRotation: 0,
  textAttachmentDirection: 0,
  bottomTextAttachmentDirection: 9,
  topTextAttachmentDirection: 9,
  flag298: 0,
};

/** Native data for a newly authored multileader (the MLEADER command, DWG MTEXT imports). */
export function defaultMLeaderNative(over: Partial<MLeaderNative> = {}): MLeaderNative {
  return {
    contentType: 'mtext',
    styleName: 'Standard',
    scaleFactor: STANDARD_MLEADER_STYLE.scaleFactor,
    landingGap: STANDARD_MLEADER_STYLE.landingGap,
    leaderLineType: STANDARD_MLEADER_STYLE.leaderLineType,
    ...over,
  };
}

/** The synthesized style for one style name: Standard values with the entity's effective overrides.
 *  Retained source style values (V-1) win over the specimen constants for their groups. */
export function mleaderStyleData(native: MLeaderNative, effective: { arrowSize: number; textHeight: number; doglegLength: number; textStyleName?: string }): MLeaderStyleData {
  const retained = native.styleRetained;
  return {
    name: native.styleName,
    arrowSize: effective.arrowSize,
    textHeight: effective.textHeight,
    doglegLength: effective.doglegLength,
    landingGap: native.landingGap,
    scaleFactor: native.scaleFactor,
    contentType: native.contentType === 'mtext' ? 2 : 0,
    leaderLineType: native.leaderLineType,
    textStyleName: effective.textStyleName ?? native.textStyleName ?? 'Standard',
    alignSpace: retained?.alignSpace ?? STANDARD_MLEADER_STYLE.alignSpace,
    blockScale: retained?.blockScale ?? STANDARD_MLEADER_STYLE.blockScale,
    blockRotation: retained?.blockRotation ?? STANDARD_MLEADER_STYLE.blockRotation,
    textAttachmentDirection: retained?.textAttachmentDirection ?? STANDARD_MLEADER_STYLE.textAttachmentDirection,
    bottomTextAttachmentDirection: retained?.bottomTextAttachmentDirection ?? STANDARD_MLEADER_STYLE.bottomTextAttachmentDirection,
    topTextAttachmentDirection: retained?.topTextAttachmentDirection ?? STANDARD_MLEADER_STYLE.topTextAttachmentDirection,
    flag298: retained?.flag298 ?? STANDARD_MLEADER_STYLE.flag298,
  };
}

/** Why native data cannot be written, or undefined when it is well-formed. Writers refuse on this. */
export function mleaderNativeProblem(native: MLeaderNative): string | undefined {
  if (!native.styleName || /[\r\n]/.test(native.styleName)) return 'multileader style name is missing or invalid';
  if (!Number.isFinite(native.scaleFactor) || native.scaleFactor <= 0) return 'multileader scale factor must be a positive finite number';
  if (!Number.isFinite(native.landingGap) || native.landingGap < 0) return 'multileader landing gap must be a non-negative finite number';
  if (native.leaderLineType !== 0 && native.leaderLineType !== 1 && native.leaderLineType !== 2) return 'multileader leader line type must be 0, 1 or 2';
  if (native.contentType === 'block') return 'multileader block content is not modeled by this slice yet';
  if (native.contentType !== 'mtext' && native.contentType !== 'none') return 'multileader content type is not modeled by this slice';
  return undefined;
}
