import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertRequiredSigning } from './signing-policy.mjs';

export function configureMacSigning(build) {
  return {
    ...build,
    forceCodeSigning:true,
    mac:{ ...build.mac, hardenedRuntime:true, notarize:true, gatekeeperAssess:false, entitlements:'build/entitlements.mac.plist', entitlementsInherit:'build/entitlements.mac.plist' },
    dmg:{ ...build.dmg, sign:true },
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assertRequiredSigning('macOS', true, process.env);
  const file = resolve(import.meta.dirname, '..', 'package.json');
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  pkg.build = configureMacSigning(pkg.build);
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log('macOS publisher build requires code signing, hardened runtime, signed DMGs and notarized applications.');
}
