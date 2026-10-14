/**
 * Globals the Node scripts reach inside the page they drive (Playwright `page.evaluate`
 * callbacks run in the browser, where the application exposes these for tests and the
 * developer console). Typed loosely on purpose: the scripts poke at internals.
 */
export {};

declare global {
  interface Window {
    /** The running Editor (src/main.ts). */
    editor: any;
    gpuPrototype: any;
    __demoLossControl: any;
    /** The preload bridge (electron/preload.cjs); absent in the browser edition. */
    jcad: any;
    jacUi: any;
    __uiLog: any;
    __sbSession: any;
    require?: unknown;
    process?: unknown;
  }
}
