/** Distinguish a requested DWG process teardown from an unexpected Chromium child failure. */
const EXPECTED_EXIT_TTL_MS = 60_000;
const MAX_EXPECTED_EXITS = 64;
const expected = new Map();
const validName = (name) => typeof name === 'string' && /^JCad DWG Reader:[0-9a-f-]{36}$/.test(name);
function prune() {
  const now = Date.now();
  for (const [name, expires] of expected) if (expires <= now) expected.delete(name);
}
function expectDwgProcessExit(name) {
  if (!validName(name)) throw new Error('Invalid DWG process identity.');
  prune();
  while (expected.size >= MAX_EXPECTED_EXITS) expected.delete(expected.keys().next().value);
  expected.set(name, Date.now() + EXPECTED_EXIT_TTL_MS);
}
function forgetDwgProcessExit(name) { expected.delete(name); }
function shouldLogChildProcessGone(details) {
  prune();
  const name = [details?.name, details?.serviceName].find((candidate) => validName(candidate) && expected.has(candidate));
  if (!name || details.type !== 'Utility') return true;
  expected.delete(name);
  // Even a process we intended to stop must report a real crash, OOM or integrity failure.
  return details.reason !== 'killed' && details.reason !== 'clean-exit';
}
module.exports = { expectDwgProcessExit, forgetDwgProcessExit, shouldLogChildProcessGone, EXPECTED_EXIT_TTL_MS };
