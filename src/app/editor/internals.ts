/**
 * What the Editor's modules (src/app/editor/*.ts) share besides its public members: the editor's
 * private working state and the UI used when none is attached. The Editor creates the state and
 * passes it to the module functions its methods delegate to; nothing else holds it.
 */
import type { Point } from '../../core/geometry';
import type { Entity } from '../../core/entities';
import type { ViewportOverlay } from '../../render/viewport';
import type { ToolContext, LadderSettings } from '../../tools/types';
import type { SelectionRequest } from './types';

export interface EditorInternals {
  /** What the viewport draws over the drawing (the Editor's `overlay`: previews, ghosts, selection box, snap marker, cursor). */
  readonly overlay: ViewportOverlay;
  /** The "Select objects:" request a tool is waiting on. */
  selReq: SelectionRequest | null;
  /** Where a selection box drag started. */
  dragStart: Point | null; // screen
  dragWorld: Point | null;
  /** Panning with the middle button (or the left one in PAN). */
  panning: boolean;
  lastMouse: Point;
  /** The cursor in world coordinates, snapped (status bar, direct distance entry). */
  cursorWorld: Point | null;
  /** Session id -> save-queue revision of the newest save of that drawing that completed. */
  readonly savedRevisions: Map<number, number>;
  /** Bumped by every project change (updateProject) and by open / new. */
  projectRev: number;
  /** Bumped when another project is opened or created: saves bind to the project that started them. */
  projectGen: number;
  /** Latest completed save in this generation, including saves to different destinations. */
  projectSavedRevision: number;
  /** The grip being dragged (grip stretch of a selected object). */
  gripDrag: { entity: Entity; index: number; start: Point } | null;
  /** Points acquired for object snap tracking; cleared whenever a point is accepted. */
  acquired: Point[];
}

/** The working state of a new editor, around its overlay. */
export function createInternals(overlay: ViewportOverlay): EditorInternals {
  return {
    overlay,
    selReq: null,
    dragStart: null,
    dragWorld: null,
    panning: false,
    lastMouse: { x: 0, y: 0 },
    cursorWorld: null,
    savedRevisions: new Map<number, number>(),
    projectRev: 0,
    projectGen: 0,
    projectSavedRevision: 0,
    gripDrag: null,
    acquired: [],
  };
}

/** The UI tools get when none is attached (tests, scripts): defaults and no dialogs. */
export const fallbackUi: ToolContext['ui'] = {
  pickSymbol: async () => null,
  editComponent: async (init) => ({ tag: init.tag, desc: init.desc, mfg: init.mfg ?? '', cat: init.cat ?? '' }),
  ladderSettings: async (init: LadderSettings) => init,
  textInput: async (_t, _l, init) => init,
  confirm: async () => true,
};
