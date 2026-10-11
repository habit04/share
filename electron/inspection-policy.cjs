// No command-line debugging endpoint in production. Test builds are separately marked
// in their ASAR metadata and never enter release upload/provenance paths.
function hasDebugArguments(args) {
  return args.some((arg) => typeof arg === 'string' && /^--(?:inspect(?:-[a-z-]+)?|remote-debugging(?:-[a-z-]+)?)(?:=|$)/.test(arg));
}
function rejectsProductionDebugging(packaged, testBuild, args) {
  return packaged === true && testBuild !== true && hasDebugArguments(args);
}
function developmentServerUrl(packaged, value) { return packaged ? undefined : value; }
module.exports = { hasDebugArguments, rejectsProductionDebugging, developmentServerUrl };
