// HELLO: the smallest useful JCad Electrical plugin.
// The file body runs once when the plugin loads; `jcad` is the plugin API (docs/PLUGIN-API.md).

jcad.commands.register({
  name: 'HELLO',
  aliases: ['HI'],
  description: 'Say hello and report how many objects are selected',
  run(jcad) {
    const n = jcad.document.selection().length;
    jcad.ui.log(`Hello from ${jcad.plugin.name}! ${n} object${n === 1 ? '' : 's'} selected.`);
  },
});
