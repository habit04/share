/** Version parsing and ordering shared by the updater and its tests (no Electron dependency). */

/** Parse "v1.2.3" / "1.2.3-beta.1" into comparable parts; null when not a version. */
function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(v || '').trim());
  if (!m) return null;
  return { parts: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] || '' };
}

/** SemVer pre-release identifier order: numeric < alphanumeric, numerics compare as numbers. */
function comparePre(a, b) {
  const xs = a.split('.');
  const ys = b.split('.');
  for (let i = 0; i < Math.max(xs.length, ys.length); i += 1) {
    if (xs[i] === undefined) return -1;
    if (ys[i] === undefined) return 1;
    const xn = /^\d+$/.test(xs[i]);
    const yn = /^\d+$/.test(ys[i]);
    if (xn && yn) {
      const d = Number(xs[i]) - Number(ys[i]);
      if (d !== 0) return d > 0 ? 1 : -1;
    } else if (xn !== yn) {
      return xn ? -1 : 1;
    } else if (xs[i] !== ys[i]) {
      return xs[i] > ys[i] ? 1 : -1;
    }
  }
  return 0;
}

/** 1 if a > b, -1 if a < b, 0 if equal or unparsable. */
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i += 1) {
    if (pa.parts[i] !== pb.parts[i]) return pa.parts[i] > pb.parts[i] ? 1 : -1;
  }
  // A pre-release is older than the final release of the same number.
  if (pa.pre && !pb.pre) return -1;
  if (!pa.pre && pb.pre) return 1;
  return comparePre(pa.pre, pb.pre);
}

module.exports = { parseVersion, compareVersions };
