// Report missing names only. Never return or print credential values.
export const appleSigningNames = ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'];
export const azureSigningNames = ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET', 'AZURE_SIGNING_ENDPOINT', 'AZURE_SIGNING_ACCOUNT', 'AZURE_CERT_PROFILE', 'AZURE_PUBLISHER_NAME'];
export function missingSigningInputs(names, env) { return names.filter((name) => !String(env[name] ?? '').trim()); }
export function assertRequiredSigning(platform, required, env) {
  const names = platform === 'macOS' ? appleSigningNames : platform === 'Windows' ? azureSigningNames : [];
  const missing = missingSigningInputs(names, env);
  if (required && missing.length) throw new Error(`${platform} publisher signing required; missing inputs: ${missing.join(', ')}`);
  return { enabled:missing.length === 0, missing };
}
