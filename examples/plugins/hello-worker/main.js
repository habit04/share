// HELLOISO: the v1 HELLO example, ported to the isolated realm (API v2).
// The manifest opts in with "isolation": "worker" and declares exactly the
// capabilities used below; everything else is denied by the host. Every
// jcad call is mediated by the host and returns a promise, so v2 code is
// async where v1 was synchronous.

await jcad.commands.register({
  name: 'HELLOISO',
  description: 'Say hello from the isolated realm and report how many objects are selected',
  run: async (jcad) => {
    const n = (await jcad.document.selection()).length;
    await jcad.ui.log(`Hello from isolated ${jcad.plugin.name}! ${n} object${n === 1 ? '' : 's'} selected.`);
  },
});
