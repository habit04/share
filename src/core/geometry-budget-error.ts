/** A rejected resource-heavy edit/import, distinct from unexpected programming failures. */
export class GeometryBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeometryBudgetError';
  }
}
