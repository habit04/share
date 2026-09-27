import type { Point } from '../core/geometry';
import type { Entity } from '../core/entities';
import type { Drawing } from '../core/document';
import type { SnapSettings } from '../core/snap';

export interface ToolContext {
  readonly doc: Drawing;
  readonly snap: SnapSettings;
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
    pickSymbol(): Promise<string | null>;
    editComponent(init: { tag: string; desc: string; block: string }): Promise<{ tag: string; desc: string } | null>;
    ladderSettings(init: LadderSettings): Promise<LadderSettings | null>;
    textInput(title: string, label: string, init: string): Promise<string | null>;
    confirm(title: string, message: string): Promise<boolean>;
  };
  /** Selection mode flag used by tools that need a selection set first. */
  requestSelection(prompt: string, onDone: (ids: string[]) => void): void;
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
}
