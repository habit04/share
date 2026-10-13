import type { Point } from '../core/geometry';
import type { Entity } from '../core/entities';
import type { Drawing } from '../core/document';
import type { SnapSettings } from '../core/snap';
import type { Frame3, Ray, Vec3 } from '../model3d/math';
import type { Dimension3D, Model3D, Solid3D } from '../model3d/types';
import type { GeometryKernel } from '../model3d/kernel/kernel';
import type { PickHit } from '../render3d/picking';

export interface ToolContext {
  readonly doc: Drawing;
  readonly snap: SnapSettings;
  /** Applied model-to-view rotation in radians; absent in older contexts means zero. */
  readonly viewTwist?: number;
  /** Current selection (ids). Tools may read or replace it. */
  selection: Set<string>;
  /** Pick-box aperture in world units at the current zoom. */
  aperture(): number;
  /** Set the command-line prompt (e.g. "Specify next point or [Undo]:"). */
  prompt(text: string): void;
  /** Append a line to the command history. */
  log(text: string): void;
  setPreview(entities: readonly Entity[]): void;
  setGhost(entities: readonly Entity[]): void;
  /** Base point for ortho/polar tracking and relative input. */
  setTrackFrom(p: Point | null): void;
  /** Dynamic input lines shown next to the cursor. */
  setDynText(lines: string[]): void;
  /** Tool has completed; editor returns to the default Select tool. */
  finish(): void;
  /** Ask editor to run another command by name. */
  runCommand(name: string): void;
  /** Modal helpers implemented by the UI layer. */
  ui: {
    /** Icon menu: the chosen block (a bare name means horizontal) or null when cancelled. */
    pickSymbol(): Promise<SymbolPick | string | null>;
    editComponent(init: { tag: string; desc: string; block: string; mfg?: string; cat?: string }): Promise<{ tag: string; desc: string; mfg: string; cat: string } | null>;
    ladderSettings(init: LadderSettings): Promise<LadderSettings | null>;
    textInput(title: string, label: string, init: string): Promise<string | null>;
    confirm(title: string, message: string): Promise<boolean>;
    /** AutoCAD-style Save / Don't Save / Cancel prompt. */
    saveChanges?(fileName: string): Promise<'save' | 'discard' | 'cancel'>;
  };
  /** Selection mode flag used by tools that need a selection set first. */
  requestSelection(prompt: string, onDone: (ids: string[]) => void): void;

  // ---- Experimental 3D (src/tools3d/context.ts). Present only when the `experimental3d` flag is
  // on; 2D tools never use them. For 3D tools, tool points (`onPoint`, `onMove`) are 2D
  // coordinates on the construction plane (plane-local X / Y; with the default plane simply world
  // x, y on z = 0).

  /**
   * The 3D point (world) for a tool point: a hit on a solid face when the point came from the 3D
   * view with the cursor over a solid, else the point on the construction plane.
   */
  point3?(p: Point): Vec3;
  /** The 3D view's cursor ray for a tool point that came from the 3D view, else null. */
  ray3?(p: Point): Ray | null;
  /** The solid face at a tool point (the 3D view's hit, else looking down the plane normal), or null. */
  face3?(p: Point): PickHit | null;
  /** Active construction plane (UCS-like); WCS XY by default and whenever 3D mode is off. */
  readonly constructionPlane?: Frame3;
  /** Display name of the construction plane ("World", "XY", "XZ", "YZ", "Face"). */
  readonly constructionPlaneName?: string;
  /** Make `frame` the construction plane (3DPLANE). */
  setConstructionPlane?(frame: Frame3, name: string): void;
  /** The drawing's 3D model. */
  solids?(): Model3D;
  /** The geometry kernel for Booleans (created on first use). */
  readonly kernel?: GeometryKernel;
  /** Solids drawn as a translucent ghost by the 3D view while a tool runs ([] clears). */
  setPreview3d?(solids: readonly Solid3D[]): void;
  /** False when nothing would draw ghosts (3D mode off): tools may skip building them. */
  wantsPreview3d?(): boolean;
  /** 3D dimensions drawn by the 3D view as the rubber band of a running DIM3D ([] clears). */
  setPreviewDimensions3d?(dims: readonly Dimension3D[]): void;
}

/** Result of the Insert Component icon menu: the block and the orientation radio (H = as drawn, V = vertical). */
export interface SymbolPick {
  name: string;
  orientation: 'H' | 'V';
}

export interface LadderSettings {
  width: number;
  spacing: number;
  rungs: number;
  firstReference: number;
  referenceStep: number;
  threePhase: boolean;
  /** Draw a wire on every rung (otherwise only rails and reference numbers). */
  drawRungs?: boolean;
}

export interface Tool {
  readonly name: string;
  start(ctx: ToolContext): void;
  onPoint(p: Point, ctx: ToolContext): void;
  onMove(p: Point, ctx: ToolContext): void;
  /** Non-point text entered at the command line (options, values, text). */
  onText(text: string, ctx: ToolContext): void;
  /** Enter / Space / right-click with no input. */
  onEnter(ctx: ToolContext): void;
  onCancel(ctx: ToolContext): void;
  /** Whether typed plain numbers should be treated as direct-distance entry. */
  readonly acceptsDistance?: boolean;
  /** When true, typed input is passed to onText verbatim (no point parsing, Space is a character). */
  acceptsFreeText?(): boolean;
  /**
   * When true, typed input is passed to onText (trimmed) without being parsed into a point
   * ("x,y", "@dx,dy", "d<a" stay text) or used for direct distance entry; unlike
   * `acceptsFreeText`, Space still submits. Experimental 3D tools parse 3D points themselves.
   */
  acceptsRawPoints?(): boolean;
}
