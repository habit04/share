export interface BrowserMeasurements { entities: number; selected: number; coldStateLoad: number; firstGeometry: number; coldRender: number; coldReady: number; load: number; renderExtents: number; renderZoomed: number; hover: number; windowSelect: number }
export const BROWSER_BUDGETS: Readonly<Omit<BrowserMeasurements, 'entities' | 'selected'>>;
export function checkBrowserBudgets(result: BrowserMeasurements, factor?: number): string[];
export interface ProjectMeasurements { files: number; drawings: number; componentRows: number; readBytes: number; diskRead: number; prepare: number; reports: number; total: number }
export function checkProjectBudgets(result: ProjectMeasurements, factor?: number): string[];
