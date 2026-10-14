// The test-build configuration as a function of the environment (scripts/electron-test-build.cjs).
const pkg = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'package.json'), 'utf8'));

/**
 * The test-build configuration for `env`.
 *
 * JCAD_TEST_BUILD_WITHOUT_DWG_WRITER=1 (`npm run dist:test:no-dwg`) is a local-only opt-out for
 * machines without the Rust toolchain: the unpacked test app is built without the portable DWG
 * writer (no `dwg-writer` extra resource; DWG saving then reports the writer unavailable), into its
 * own `release-test-no-dwg/` folder and marked `jcadTestBuildWithoutDwgWriter`, so it can never be
 * mistaken for the full test build that release.yml builds with `npm run dist:test` and drives with
 * `npm run e2e:test-build`. It is honoured only by this test-build config (never by package.json's
 * shipping config) and refused on CI; it also skips electron-builder's native-module rebuild
 * (`npmRebuild: false`; there are no native production dependencies), so a local build never
 * modifies node_modules. Used for the 3D security verification
 * (docs/3D-PACKAGED-TEST.md), which needs no DWG saving.
 * @param {Record<string, string | undefined>} env
 */
function testBuildConfig(env) {
  const withoutDwgWriter = env.JCAD_TEST_BUILD_WITHOUT_DWG_WRITER === '1';
  if (withoutDwgWriter && (env.CI || env.GITHUB_ACTIONS)) throw new Error('JCAD_TEST_BUILD_WITHOUT_DWG_WRITER is for local test builds only; CI test builds must include the DWG writer.');
  const config = {
    ...pkg.build,
    directories: { ...pkg.build.directories, output: 'release-test' },
    electronFuses: { ...pkg.build.electronFuses, enableNodeCliInspectArguments: true },
    extraMetadata: { jcadTestBuild: true },
    publish: null,
    artifactName: 'TEST-ONLY-${name}-${version}-${os}-${arch}.${ext}',
  };
  if (!withoutDwgWriter) return config;
  return {
    ...config,
    directories: { ...config.directories, output: 'release-test-no-dwg' },
    // The app has no native production dependencies; a local build never touches node_modules.
    npmRebuild: false,
    win: { ...pkg.build.win, extraResources: (pkg.build.win.extraResources ?? []).filter((r) => r.to !== 'dwg-writer') },
    extraMetadata: { ...config.extraMetadata, jcadTestBuildWithoutDwgWriter: true },
    artifactName: 'TEST-ONLY-NO-DWG-WRITER-${name}-${version}-${os}-${arch}.${ext}',
  };
}

module.exports = { testBuildConfig };
