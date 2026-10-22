import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';

it('preserves authenticated file bytes during a Windows text checkout', () => {
  const temporary = realpathSync(tmpdir());
  const root = mkdtempSync(join(temporary, 'jcad-byte-checkout-'));
  const owned = relative(temporary, realpathSync(root));
  if (!owned.startsWith('jcad-byte-checkout-') || owned.includes(sep) || isAbsolute(owned)) {
    throw new Error('Unexpected checkout test cleanup path');
  }
  try {
    const repository = join(root, 'objects.git');
    const checkout = join(root, 'checkout');
    mkdirSync(checkout);
    const attributes = readFileSync(join(__dirname, '..', '.gitattributes'));
    writeFileSync(join(checkout, '.gitattributes'), attributes);
    const emptyConfig = join(root, 'empty.config');
    writeFileSync(emptyConfig, '', { flag: 'wx' });
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyConfig, GIT_ATTR_NOSYSTEM: '1', GIT_CONFIG_COUNT: '0' };
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) {
      delete env[key];
    }
    const git = (args: string[], input?: Buffer): Buffer => {
      const result = spawnSync('git', args, { cwd: root, env, input, windowsHide: true, timeout: 4000 });
      if (result.error) throw result.error;
      expect(result.signal).toBeNull();
      expect(result.status, result.stderr.toString()).toBe(0);
      return result.stdout;
    };
    git(['init', '--bare', '--template=', '--quiet', repository]);
    // Per-command settings exercise Windows conversion even on Linux. Neither
    // the user's Git configuration nor any existing checkout is modified.
    const options = ['-c', 'core.autocrlf=true', '-c', 'core.eol=crlf', '-c', 'core.attributesFile=', `--git-dir=${repository}`, `--work-tree=${checkout}`];
    const protectedPaths = [
      'electron/shaping/assets/harfbuzz.js',
      'tests/fixtures/native-dynamic-constraint-handbuilt/PROVENANCE-Q12-HANDBUILT.md',
      'tests/fixtures/native-dynamic-array-handbuilt/oracle-measure.json',
      'tests/fixtures/xref/leaf.dxf',
    ];
    const lf = Buffer.from('authenticated first line\nsecond line\n');
    const crlf = Buffer.from('native first line\r\nsecond line\r\n');
    const nativePath = 'tests/fixtures/native-dynamic-array-handbuilt/checks/check-C1.json';
    const files: [string, Buffer][] = [
      ['.gitattributes', attributes],
      ...protectedPaths.map((path): [string, Buffer] => [path, lf]),
      ['conversion-control.txt', lf],
      [nativePath, crlf],
    ];
    // Seed raw blobs, without applying a text clean filter to the native CRLF
    // control. This is the same byte contract as authenticated source artifacts.
    const index = files.map(([path, bytes]) => {
      const blob = git([...options, 'hash-object', '-w', '--stdin'], bytes).toString().trim();
      return `100644 ${blob}\t${path}\0`;
    }).join('');
    git([...options, 'update-index', '-z', '--index-info'], Buffer.from(index));
    git([...options, 'checkout-index', '--all', '--force']);
    const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
    for (const path of protectedPaths) {
      expect.soft(digest(readFileSync(join(checkout, path))), path).toBe(digest(lf));
    }
    // A control proves conversion was active; intentional native CRLF must
    // also survive unchanged, rather than being indiscriminately normalized.
    expect(readFileSync(join(checkout, 'conversion-control.txt'))).toEqual(Buffer.from(lf.toString().replace(/\n/g, '\r\n')));
    expect(readFileSync(join(checkout, nativePath))).toEqual(crlf);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
