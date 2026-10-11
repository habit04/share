import { parseBrowserDwg } from './dwg-browser-reader';
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<{ bytes: ArrayBuffer }>) => void) | null;
  postMessage(message: unknown): void;
};
scope.onmessage = (event) => {
  void parseBrowserDwg(event.data.bytes).then(
    (result) => scope.postMessage({ ok: true, ...result }),
    (error: unknown) => scope.postMessage({ ok: false, message: error instanceof Error ? error.message : String(error) }),
  );
};
