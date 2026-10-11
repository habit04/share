// A dedicated, unpublished ASAR build for Playwright's main-process inspection.
// Shipping configuration stays in package.json with inspection disabled.
const pkg = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'package.json'), 'utf8'));
module.exports = {
  ...pkg.build,
  directories: { ...pkg.build.directories, output: 'release-test' },
  electronFuses: { ...pkg.build.electronFuses, enableNodeCliInspectArguments: true },
  extraMetadata: { jcadTestBuild: true },
  publish: null,
  artifactName: 'TEST-ONLY-${name}-${version}-${os}-${arch}.${ext}',
};
