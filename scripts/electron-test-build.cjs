// A dedicated, unpublished ASAR build for Playwright's main-process inspection.
// Shipping configuration stays in package.json with inspection disabled.
// See scripts/electron-test-build-config.cjs (JCAD_TEST_BUILD_WITHOUT_DWG_WRITER: local builds without the DWG writer).
module.exports = require('./electron-test-build-config.cjs').testBuildConfig(process.env);
