// Fixed main-authored startup checks shared by the two ordinary GPU probes.
// Self-contained so the exact function can be serialized into the renderer.
/** @param {any} w @param {Pick<Document, 'querySelectorAll'>} dom */
function shippingGpuAssertLazy3d(w, dom) {
  const ed = w.editor, c = w.jcad3d;
  if (ed.settings.experimental3d !== true || !c || !['BOX', '3DMODE', '3DVIEW', 'UNION'].every(name => ed.commands.has(name))) {
    throw new Error('GPU acceptance requires default-ready 3D tools and their installed controller');
  }
  if (c.active !== false || c.viewport !== null || c.kernelStarted !== false
    || dom.querySelectorAll('canvas.viewport3d').length !== 0 || ed.viewport.canvas.style.visibility === 'hidden') {
    throw new Error('GPU acceptance requires inactive 3D tools without a viewport, context or started kernel');
  }
  if (ed.settings.importForeign3d !== false) throw new Error('GPU acceptance requires foreign 3D import disabled');
}

module.exports = { shippingGpuAssertLazy3d };
