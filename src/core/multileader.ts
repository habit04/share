/**
 * Native MULTILEADER data (P18 slice 1: MTEXT content; slice 2: block content;
 * slice 3: multi-context / annotative scale, PROPOSAL-P18-S3).
 *
 * A LeaderEntity with `kind: 'mleader'` and this data present is a native
 * multileader: it is written to DXF as a MULTILEADER entity (AcDbMLeader with a
 * CONTEXT_DATA section) plus an MLEADERSTYLE object, and read back from one.
 * A mleader WITHOUT this data (every pre-P18 save, and block-content imports
 * whose block reference does not resolve) keeps the legacy LEADER + MTEXT
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

/** What a native multileader carries: MTEXT (slice 1), no content, or a block
 *  reference with attribute values (slice 2, PROPOSAL-P18-S2). */
import type { Point } from './geometry';

export type MLeaderContentType = 'mtext' | 'none' | 'block';

/** One attribute value of a block-content multileader (slice 2). */
export interface MLeaderBlockAttribute {
  /** Index into the content block's `BlockDef.attributes` (trailing group 177). */
  readonly index: number;
  /** The definition tag at that index, resolved on import (the value's identity in-session). */
  readonly tag: string;
  /** The attribute's text value (trailing group 302). */
  readonly value: string;
  /** Trailing group 44: attribute width factor, when the source carries it. */
  readonly width?: number;
}

/**
 * Block content of a native multileader (slice 2): a reference to a block
 * definition in the same drawing plus this instance's placement and attribute
 * values. The block's geometry/ATTDEFs live in the BlockDef itself; only the
 * reference and the per-instance data are carried here.
 */
export interface MLeaderBlockContent {
  /** Block name (CONTEXT_DATA 341 / trailing 344 name the record by handle; resolved on import). */
  readonly name: string;
  /** Block position (context 15; fallback: the context 10 content base point). */
  readonly position: Point;
  /** Block scale X/Y (context 16; fallback: the trailing 10 scale point). Z is 1 (2D model). */
  readonly scale: Point;
  /** Block rotation in radians (context 46; fallback: trailing 43). */
  readonly rotation: number;
  /** Attribute values in source order; empty when the block content carries none. */
  readonly attributes: readonly MLeaderBlockAttribute[];
}

/** Block placement of ONE additional context (slice 3): the context's own
 *  15/16/46 values. The block name and the attribute values are entity-level
 *  (one content block per entity, as the file carries them); only the
 *  placement varies per annotation scale. */
export interface MLeaderContextBlock {
  /** Block position for this context (context 15; fallbacks mirror the primary's chain). */
  readonly position: Point;
  /** Block scale X/Y for this context (context 16). Z is 1 (2D model). */
  readonly scale: Point;
  /** Block rotation for this context (context 46). */
  readonly rotation: number;
}

/**
 * ONE additional CONTEXT_DATA section of an annotative multileader (slice 3,
 * PROPOSAL-P18-S3): the representation at one more annotation scale. The
 * FIRST context in file order is the primary — it lives on the LeaderEntity
 * fields and the scalar fields of MLeaderNative exactly as slices 1/2 left
 * them; `MLeaderNative.contexts` carries contexts 2..n in file order. Each
 * record mirrors the primary's modelled group set for its own section.
 */
export interface MLeaderContext {
  /** CONTEXT_DATA group 40: this context's scale factor (its identity — no fallback). */
  readonly scaleFactor: number;
  /** CONTEXT_DATA group 145 for this context (fallback: the primary's resolved gap). */
  readonly landingGap: number;
  /** CONTEXT_DATA group 41 for this context (fallback: the primary's resolved text height). */
  readonly textHeight: number;
  /** CONTEXT_DATA group 140 for this context (fallback: the primary's resolved arrow size). */
  readonly arrowSize: number;
  /** This context's leader geometry: every LEADER_LINE path (arrow -> ... -> landing)
   *  of the context's LEADER{ sections, flattened in file order exactly as the
   *  primary flattens them into vertices + extraPaths. Empty for a content-only
   *  context (no LEADER{ section). */
  readonly paths: readonly (readonly Point[])[];
  /** Landing (dogleg) vector of this context's first LEADER{ section, when it carries one. */
  readonly dogleg?: Point;
  /** This context's MTEXT content (its own group 304), plain text; absent when the
   *  context carries no MTEXT. Not required to equal the primary's text. */
  readonly text?: string;
  /** The context's formatted MTEXT source, when its 304 carries formatting. */
  readonly raw?: string;
  /** Text STYLE name for this context (its group 340, resolved like the primary's). */
  readonly textStyleName?: string;
  /** MTEXT position for this context (group 12), when it carries MTEXT. */
  readonly textPosition?: Point;
  /** MTEXT rotation for this context in radians (groups 13/42), when nonzero. */
  readonly textRotation?: number;
  /** MTEXT width for this context (group 43), when positive. */
  readonly textWidth?: number;
  /** MTEXT attachment for this context (group 171, 1..9). */
  readonly textAttachment?: number;
  /** Block placement for this context, present iff the content is a block. */
  readonly block?: MLeaderContextBlock;
}

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
  /** Block content payload (slice 2); present iff `contentType` is 'block'. */
  readonly block?: MLeaderBlockContent;
  /**
   * Additional annotative contexts (slice 3, PROPOSAL-P18-S3): CONTEXT_DATA
   * sections 2..n in file order. Absent for single-context multileaders (the
   * overwhelming majority, and every authored entity today); when present it
   * holds at least one record.
   */
  readonly contexts?: readonly MLeaderContext[];
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
  /** Style group 170: content type (2 = MTEXT, 1 = block, 0 = none). */
  readonly contentType: 0 | 1 | 2;
  /** Content block name for block styles (slice 2): the writer resolves style group
   *  343 (content block record handle) from it; absent for MTEXT/none styles. */
  readonly blockName?: string;
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
 *  Retained source style values (V-1) win over the specimen constants for their groups; for a
 *  block style, the entity's own block placement supplies the style-level block scale/rotation
 *  when nothing was retained (retained-over-derived-over-constant). */
export function mleaderStyleData(native: MLeaderNative, effective: { arrowSize: number; textHeight: number; doglegLength: number; textStyleName?: string }): MLeaderStyleData {
  const retained = native.styleRetained;
  const block = native.contentType === 'block' ? native.block : undefined;
  return {
    name: native.styleName,
    arrowSize: effective.arrowSize,
    textHeight: effective.textHeight,
    doglegLength: effective.doglegLength,
    landingGap: native.landingGap,
    scaleFactor: native.scaleFactor,
    contentType: native.contentType === 'mtext' ? 2 : native.contentType === 'block' ? 1 : 0,
    ...(block ? { blockName: block.name } : {}),
    leaderLineType: native.leaderLineType,
    textStyleName: effective.textStyleName ?? native.textStyleName ?? 'Standard',
    alignSpace: retained?.alignSpace ?? STANDARD_MLEADER_STYLE.alignSpace,
    blockScale: retained?.blockScale ?? (block ? { x: block.scale.x, y: block.scale.y, z: 1 } : STANDARD_MLEADER_STYLE.blockScale),
    blockRotation: retained?.blockRotation ?? block?.rotation ?? STANDARD_MLEADER_STYLE.blockRotation,
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
  if (native.contentType !== 'mtext' && native.contentType !== 'none' && native.contentType !== 'block') return 'multileader content type is not modeled by this slice';
  if (native.contentType === 'block') {
    const b = native.block;
    if (!b) return 'multileader block content is missing its block payload';
    if (!b.name || /[\r\n]/.test(b.name)) return 'multileader block name is missing or invalid';
    if (!Number.isFinite(b.position.x) || !Number.isFinite(b.position.y)) return 'multileader block position must be finite';
    if (!Number.isFinite(b.scale.x) || !Number.isFinite(b.scale.y) || b.scale.x === 0 || b.scale.y === 0) return 'multileader block scale must be finite and non-zero';
    if (!Number.isFinite(b.rotation)) return 'multileader block rotation must be finite';
    for (const a of b.attributes) {
      if (!Number.isInteger(a.index) || a.index < 0) return 'multileader block attribute index must be a non-negative integer';
      if (!a.tag) return 'multileader block attribute tag is missing';
      if (typeof a.value !== 'string') return 'multileader block attribute value must be text';
      if (a.width !== undefined && (!Number.isFinite(a.width) || a.width <= 0)) return 'multileader block attribute width must be a positive finite number';
    }
  }
  // Slice 3: additional annotative contexts validate to the primary's standard.
  if (native.contexts !== undefined) {
    if (native.contexts.length === 0) return 'multileader contexts list must not be empty when present';
    for (const c of native.contexts) {
      if (!Number.isFinite(c.scaleFactor) || c.scaleFactor <= 0) return 'multileader context scale factor must be a positive finite number';
      if (!Number.isFinite(c.landingGap) || c.landingGap < 0) return 'multileader context landing gap must be a non-negative finite number';
      if (!Number.isFinite(c.textHeight) || c.textHeight <= 0) return 'multileader context text height must be a positive finite number';
      if (!Number.isFinite(c.arrowSize) || c.arrowSize < 0) return 'multileader context arrow size must be a non-negative finite number';
      for (const path of c.paths) {
        for (const p of path) {
          if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return 'multileader context leader points must be finite';
        }
      }
      if (c.dogleg !== undefined && (!Number.isFinite(c.dogleg.x) || !Number.isFinite(c.dogleg.y))) return 'multileader context dogleg must be finite';
      if (c.textPosition !== undefined && (!Number.isFinite(c.textPosition.x) || !Number.isFinite(c.textPosition.y))) return 'multileader context text position must be finite';
      if (c.textRotation !== undefined && !Number.isFinite(c.textRotation)) return 'multileader context text rotation must be finite';
      if (c.textWidth !== undefined && (!Number.isFinite(c.textWidth) || c.textWidth < 0)) return 'multileader context text width must be a non-negative finite number';
      if (c.textAttachment !== undefined && (!Number.isInteger(c.textAttachment) || c.textAttachment < 1 || c.textAttachment > 9)) return 'multileader context text attachment must be an integer from 1 to 9';
      if (c.block !== undefined) {
        if (native.contentType !== 'block') return 'multileader context block placement requires block content';
        if (!Number.isFinite(c.block.position.x) || !Number.isFinite(c.block.position.y)) return 'multileader context block position must be finite';
        if (!Number.isFinite(c.block.scale.x) || !Number.isFinite(c.block.scale.y) || c.block.scale.x === 0 || c.block.scale.y === 0) return 'multileader context block scale must be finite and non-zero';
        if (!Number.isFinite(c.block.rotation)) return 'multileader context block rotation must be finite';
      }
    }
  }
  return undefined;
}
