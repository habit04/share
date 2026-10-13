/** One-use native SHX selection. It grants no general file or directory access. */
const { dialog } = require('electron');
const path = require('node:path');
const { readShxResource } = require('../shx-resources.cjs');

/** @typedef {import('./context.cjs').MainContext} MainContext */

/** @param {MainContext} ctx */
function registerShxIpc(ctx) {
  if (process.platform !== 'win32') return;
  const { ipcMain, senderWindow } = ctx;
  let pending = false;
  ipcMain.handle('open-shx-font', async (event, ...args) => {
    // Even a trusted renderer cannot supply a path, filename or search root.
    if (args.length) throw new Error('SHX selection takes no renderer arguments.');
    if (pending) throw new Error('A SHX selection or resource read is already pending.');
    pending = true;
    try {
      const picked = await dialog.showOpenDialog(senderWindow(event), {
        title: 'Load SHX Font or Shapes',
        properties: ['openFile'],
        filters: [{ name: 'SHX Font or Shapes', extensions: ['shx'] }],
      });
      if (picked.canceled) return null;
      if (!Array.isArray(picked.filePaths) || picked.filePaths.length !== 1) throw new Error('Select exactly one SHX file.');
      const selected = picked.filePaths[0];
      if (typeof selected !== 'string' || selected.length > 4096 || !path.isAbsolute(selected) || path.parse(selected).root !== path.parse(path.resolve(selected)).root || /^[\\/]{2}/.test(selected) || /[\u0000-\u001f\u007f]/.test(selected) || selected.replace(/^[A-Za-z]:/, '').includes(':') || path.extname(selected).toLowerCase() !== '.shx') throw new Error('Select a local absolute SHX file.');
      // The selection is the sole authority. The confined reader validates its
      // basename, canonical containment, held descriptor and content signature.
      return await readShxResource({ font: path.basename(selected) }, { directories: [path.dirname(selected)] });
    } finally {
      // Keep the slot until reading and descriptor cleanup have both settled.
      pending = false;
    }
  });
}

module.exports = { registerShxIpc };
