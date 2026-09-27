/**
 * electron-builder afterPack hook. Without an Apple Developer identity the app
 * would be left completely unsigned, which Apple Silicon refuses to launch and
 * Gatekeeper reports as "damaged". An ad-hoc signature (identity "-") keeps the
 * bundle's seal valid; users still confirm once in System Settings > Privacy &
 * Security because the app is not notarized.
 */
const { execFileSync } = require('node:child_process');
const path = require('node:path');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (process.env.CSC_LINK || process.env.CSC_NAME) return; // a real identity is configured
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  console.log(`ad-hoc signed ${app}`);
};
