export interface BrowserMeasurements { entities: number; selected: number; load: number; renderExtents: number; renderZoomed: number; hover: number; windowSelect: number }
export const BROWSER_BUDGETS: Readonly<Pick<BrowserMeasurements, 'load' | 'renderExtents' | 'renderZoomed' | 'hover' | 'windowSelect'>>;
export function checkBrowserBudgets(result: BrowserMeasurements, factor?: number): string[];
