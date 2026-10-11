import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const require = createRequire(import.meta.url);
const { assetPath } = require('../electron/renderer-origin.cjs') as { assetPath(root: string, url: string): string };
const { appUrlTest } = require('../electron/ipc-guard.cjs') as { appUrlTest(index: string): (url: string) => boolean };
describe('bundled renderer origin', () => {
  const root = resolve('dist');
  it('maps bundled assets and excludes other hosts, credentials and encoded path escapes', () => {
    expect(assetPath(root, 'jcad://app/index.html')).toBe(resolve(root, 'index.html'));
    expect(assetPath(root, 'jcad://app/assets/main.js')).toBe(resolve(root, 'assets/main.js'));
    for (const url of ['file:///secret', 'jcad://other/index.html', 'jcad://user@app/index.html', 'jcad://app:123/index.html', 'jcad://app/%2e%2e%2fsecret', 'jcad://app/%5c..%5csecret', 'jcad://app/C:%5csecret', 'jcad://app/%00']) expect(() => assetPath(root, url)).toThrow();
  });
  it('accepts IPC only from the application page rather than another bundled resource', () => {
    const trusted = appUrlTest(resolve(root, 'index.html'));
    expect(trusted('jcad://app/index.html?demo=1#tools')).toBe(true);
    expect(trusted('jcad://app/assets/page.html')).toBe(false);
    expect(trusted('jcad://other/index.html')).toBe(false);
    expect(trusted('jcad://user@app/index.html')).toBe(false);
  });
});
