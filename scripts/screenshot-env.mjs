// Shared page set-up for the screenshot scripts, so their images can be compared with approved
// baselines (scripts/screenshot-compare.mjs) on any day, on any machine running the same
// Playwright Chromium:
//  - a fixed time zone and locale (dates and numbers format the same everywhere);
//  - a pinned calendar date: `new Date()` and `Date.now()` start from 2026-01-15 12:00 UTC and
//    then run normally, so title-block DATE fields, field codes and "saved at" stamps never change
//    while timers, debounces and elapsed-time logic keep working.

/** Browser-context options every screenshot page uses (merge into newPage / newContext). */
export const SHOT_CONTEXT = { timezoneId: 'UTC', locale: 'en-US' };

/** The date the pages believe it is when they load. */
export const PINNED_DATE = Date.UTC(2026, 0, 15, 12, 0, 0);

/**
 * Pin the calendar date in every page of this context or page (before navigation).
 * @param {import('playwright').Page | import('playwright').BrowserContext} target
 */
export async function pinDate(target) {
  await target.addInitScript((fixed) => {
    const RealDate = Date;
    const offset = fixed - RealDate.now();
    class PinnedDate extends RealDate {
      /** @param {any[]} args */
      constructor(...args) {
        if (args.length === 0) super(RealDate.now() + offset);
        // @ts-expect-error -- the Date constructor overloads take these arguments as given
        else super(...args);
      }
      static now() {
        return RealDate.now() + offset;
      }
    }
    globalThis.Date = /** @type {DateConstructor} */ (/** @type {unknown} */ (PinnedDate));
  }, PINNED_DATE);
}
