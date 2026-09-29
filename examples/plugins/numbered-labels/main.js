// NUMLABEL: prompt for a prefix, then place "<prefix><n>" labels at picked points,
// counting up. The prefix and the next number are remembered between runs.

const TEXT_HEIGHT = 0.125;

jcad.commands.register({
  name: 'NUMLABEL',
  aliases: ['NLABEL'],
  description: 'Place numbered text labels (prefix + 1, 2, 3 ...) at picked points',
  async run(jcad) {
    const lastPrefix = jcad.settings.get('plugin:prefix') ?? 'P';
    const prefix = await jcad.ui.prompt('Label prefix', String(lastPrefix));
    if (prefix === null) return; // Esc
    const startText = await jcad.ui.prompt('First number', String(jcad.settings.get('plugin:next') ?? 1));
    if (startText === null) return;
    let n = parseInt(startText, 10);
    if (!Number.isFinite(n)) {
      jcad.ui.log('The first number must be an integer.');
      return;
    }
    jcad.settings.set('plugin:prefix', prefix);
    let placed = 0;
    for (;;) {
      const p = await jcad.ui.pick.point(`Location for ${prefix}${n} (Enter to finish):`);
      if (!p) break;
      // Each label is its own undo step, like TEXT.
      jcad.document.add({ type: 'text', position: p, text: `${prefix}${n}`, height: TEXT_HEIGHT, align: 'center' });
      n += 1;
      placed += 1;
    }
    jcad.settings.set('plugin:next', n);
    jcad.ui.log(`${placed} label${placed === 1 ? '' : 's'} placed; the next number is ${prefix}${n}.`);
  },
});
