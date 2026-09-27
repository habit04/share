/**
 * Dialog contract for the electrical workflows. The Editor exposes it as
 * `hooks.electrical`; the default implementation lives in
 * src/ui/electrical-dialogs.ts and is installed lazily by the command
 * registry, so the UI layer can replace any dialog.
 */
import type { Point } from '../core/geometry';
import type { CatalogItem } from './catalog';
import type { ParentInfo } from './xref';
import type { SchematicListRow, TerminalRow } from './panel';
import type { WdSettings } from './wdm';
import type { WireNumberEdit, BusSettings } from './wires';
import type { CircuitOptions } from './circuits';
import type { AuditIssue } from './audit';
import type { Report } from './reports';
import type { Project, ProjectDrawing } from '../app/project';

export interface PinField {
  tag: string;
  label: string;
  value: string;
}

export interface ComponentDialogInit {
  block: string;
  blockDescription: string;
  family: string;
  isNew: boolean;
  /** Current attribute values (TAG1, DESC1-3, INST, LOC, MFG, CAT, ASSYCODE, RATING1-2 ...). */
  attrs: Record<string, string>;
  pins: PinField[];
  /** Tags already used by this family (the "Used" list). */
  used: string[];
  /** Suggested next tag from the drawing's tag format. */
  nextTag: string;
  /** For child contacts: parents the contact can be linked to. */
  parents?: ParentInfo[];
  /** Whether the symbol is a child contact (tag comes from the parent). */
  isChild: boolean;
}

export interface ComponentDialogResult {
  attrs: Record<string, string>;
  /** Parent chosen for a child contact (its tag / data were copied into attrs). */
  parentId?: string;
}

export interface PickItem {
  value: string;
  label: string;
  detail?: string;
}

export interface DrawingPropertiesInit {
  settings: WdSettings;
  drawing: ProjectDrawing | null;
  fileName: string;
}

export interface DrawingPropertiesResult {
  settings: WdSettings;
  description: string;
  sheet: string;
  dwgno: string;
}

export interface WireNumberDialogInit extends WireNumberEdit {
  /** Existing wire numbers for the find / replace section. */
  all: string[];
}

export interface WireNumberDialogResult {
  edit: WireNumberEdit;
  findReplace?: { find: string; replace: string };
}

export interface ReportsDialogOptions {
  initialKey: string;
  /** Build a report for the current drawing or the whole project. */
  build(key: string, projectWide: boolean): Promise<Report>;
  projectAvailable: boolean;
  saveCsv(name: string, csv: string): Promise<string | null>;
  /** Start the "put on drawing" placement for a report. */
  putOnDrawing(report: Report): void;
}

export interface ElectricalUi {
  editComponent(init: ComponentDialogInit): Promise<ComponentDialogResult | null>;
  catalogBrowser(init: { family?: string; query?: string; type?: string }): Promise<CatalogItem | null>;
  pickList(title: string, items: PickItem[], opts?: { detailHeader?: string; okLabel?: string }): Promise<string | null>;
  schematicList(rows: SchematicListRow[]): Promise<SchematicListRow | null>;
  terminalStripEditor(rows: TerminalRow[]): Promise<TerminalRow[] | null>;
  drawingProperties(init: DrawingPropertiesInit): Promise<DrawingPropertiesResult | null>;
  projectProperties(init: Project): Promise<Project | null>;
  wireNumberEdit(init: WireNumberDialogInit): Promise<WireNumberDialogResult | null>;
  busSettings(init: BusSettings): Promise<BusSettings | null>;
  circuitBuilder(init: CircuitOptions): Promise<CircuitOptions | null>;
  audit(issues: AuditIssue[], onJump: (issue: AuditIssue) => void, onRefresh: () => AuditIssue[]): void;
  reports(opts: ReportsDialogOptions): void;
  /** Pick a file (browser or desktop) and return its text, for the user catalog. */
  openTextFile?(accept: string): Promise<{ path: string; text: string } | null>;
}

export type { Point };
