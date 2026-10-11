const fs = require('node:fs');
const path = require('node:path');
/** @param {unknown} config @returns {boolean} */
function hasTrustedPublisher(config) {
  if (!config || typeof config !== 'object') return false;
  const value = /** @type {{ publisherName?: unknown }} */ (config).publisherName;
  const names = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
  return names.length > 0 && names.every(name => typeof name === 'string' && name.trim().length > 0);
}
function installationHasTrustedPublisher(resourcesPath) {
  try {
    const { load } = require('js-yaml');
    return hasTrustedPublisher(load(fs.readFileSync(path.join(resourcesPath, 'app-update.yml'), 'utf8')));
  } catch { return false; }
}
module.exports = { hasTrustedPublisher, installationHasTrustedPublisher };
