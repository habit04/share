/**
 * The manifold-3d version the kernel wrapper is written and tested against (pinned exactly in
 * package.json). Kept in its own module so main-thread code can name the version without
 * importing the WebAssembly package itself.
 */
export const MANIFOLD_VERSION = '3.5.4';
