/** Types for scripts/make-icons.mjs (plain JS so it runs without a build). */
export const PNG_SIZES: number[];
export const ICO_SIZES: number[];
export function render(size: number): Buffer;
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer;
export function ico(images: Array<{ size: number; data: Buffer }>): Buffer;
export function icns(entries: Array<[string, Buffer]>): Buffer;
export function svg(): string;
export function buildAll(): Map<string, Buffer>;
export function pngPixels(png: Buffer): Buffer;
export function sameIcon(name: string, a: Buffer, b: Buffer): boolean;
