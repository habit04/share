#!/usr/bin/env node
/**
 * azure-signing: switch on Azure Artifact Signing (formerly Trusted Signing) for the
 * Windows build when the repository has all of its secrets, and leave the build
 * unsigned otherwise. Run by .github/workflows/release.yml on the Windows job before
 * electron-builder; it edits the checked-out package.json in the runner only.
 *
 *   node scripts/azure-signing.mjs
 *
 * Reads AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET (the app registration
 * login, read by the TrustedSigning PowerShell module itself) and
 * AZURE_SIGNING_ENDPOINT, AZURE_SIGNING_ACCOUNT, AZURE_CERT_PROFILE,
 * AZURE_PUBLISHER_NAME (written into build.win.azureSignOptions). The publisher
 * name must equal the certificate's subject CN: the updater compares it against
 * the signature on every downloaded update.
 *
 * Writes `enabled=true|false` to $GITHUB_OUTPUT when present.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED = [
  'AZURE_TENANT_ID',
  'AZURE_CLIENT_ID',
  'AZURE_CLIENT_SECRET',
  'AZURE_SIGNING_ENDPOINT',
  'AZURE_SIGNING_ACCOUNT',
  'AZURE_CERT_PROFILE',
  'AZURE_PUBLISHER_NAME',
];

const env = (name) => (process.env[name] ?? '').trim();
const missing = REQUIRED.filter((name) => !env(name));
const enabled = missing.length === 0;

if (enabled) {
  const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  pkg.build.win = {
    ...pkg.build.win,
    azureSignOptions: {
      publisherName: env('AZURE_PUBLISHER_NAME'),
      endpoint: env('AZURE_SIGNING_ENDPOINT'),
      codeSigningAccountName: env('AZURE_SIGNING_ACCOUNT'),
      certificateProfileName: env('AZURE_CERT_PROFILE'),
    },
  };
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`Azure signing enabled: account ${env('AZURE_SIGNING_ACCOUNT')}, profile ${env('AZURE_CERT_PROFILE')}.`);
} else {
  console.log(`Azure signing skipped, the Windows build stays unsigned. Missing secrets: ${missing.join(', ')}.`);
}

if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `enabled=${enabled}\n`);
