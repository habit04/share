// Dependency-free validation of build records. Aggregate/publication jobs need no npm install.
export const shippingFuseValues = {
  RunAsNode:false,
  EnableNodeOptionsEnvironmentVariable:false,
  EnableNodeCliInspectArguments:false,
  EnableEmbeddedAsarIntegrityValidation:true,
  OnlyLoadAppFromAsar:true,
  GrantFileProtocolExtraPrivileges:false,
};
export function platformExecutables(platform) {
  const mac = 'JCad Electrical.app/Contents/MacOS/JCad Electrical';
  const paths = { Windows:['win-unpacked/JCad Electrical.exe'], macOS:[`mac/${mac}`, `mac-arm64/${mac}`], Linux:['linux-unpacked/jcad-electrical'] };
  if (!paths[platform]) throw new Error('Unsupported platform fuse evidence');
  return paths[platform];
}
export function validateFuseEvidence(platform, evidence) {
  const expected = platformExecutables(platform);
  if (!Array.isArray(evidence) || evidence.length !== expected.length) throw new Error('Missing shipping executable fuse evidence');
  for (const path of expected) {
    const entries = evidence.filter((entry) => entry?.path === path);
    if (entries.length !== 1) throw new Error(`Missing or duplicate shipping fuse evidence: ${path}`);
    const policy = entries[0].policy;
    if (!policy || policy.role !== 'shipping' || policy.version !== '1' || Object.entries(shippingFuseValues).some(([name, enabled]) => policy[name] !== enabled)) throw new Error('Unsafe or test-build fuse evidence in shipping provenance');
  }
  return evidence;
}
