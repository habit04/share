// Unpublished unpacked CI test build only. This factory never builds or launches.
const assert = require('node:assert/strict');
const path = require('node:path');
const { testBuildConfig } = require('./electron-test-build-config.cjs');

function ciTestAsarConfig({ repo, output, electronDist }) {
  assert.equal(repo, path.resolve(__dirname, '..'), 'Use the current source checkout');
  assert.equal(electronDist, path.join(repo, 'node_modules', 'electron', 'dist'), 'Use the already installed locked Electron');
  assert.equal(path.basename(output), 'output');
  const run = path.dirname(output);
  assert.equal(path.dirname(run), path.join(repo, '.codex-local', 'ci-test-asar'));
  assert.match(path.basename(run), /^run-[A-Za-z0-9_-]+$/);
  const base = testBuildConfig({});
  assert.equal(base.win.icon, 'build/icon.ico', 'This reviewed no-download recipe requires the existing ICO input');
  assert.equal(base.extraMetadata.jcadTestBuild, true);
  assert.ok(!base.extraMetadata.jcadTestBuildWithoutDwgWriter);
  return {
    ...base,
    extends: null,
    asar: true,
    directories: { ...base.directories, output },
    electronVersion: '44.9.3', electronDist,
    npmRebuild: false, nodeGypRebuild: false, buildDependenciesFromSource: false,
    downloadAlternateFFmpeg: false, forceCodeSigning: false, publish: null,
    win: { ...base.win, target: ['dir'], signExecutable: false, signAndEditExecutable: true, forceCodeSigning: false },
  };
}
module.exports = { ciTestAsarConfig };
