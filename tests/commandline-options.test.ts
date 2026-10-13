/**
 * Clickable prompt options (src/ui/commandline.ts `optionInput`): a click sends the option's
 * capitalised abbreviation (the rule `matchKeyword` uses), the whole option when the abbreviation
 * would select another option. Checked against every `[A/B/C]` option list in the sources: each
 * click selects its own option, and every option the old click (its first letter) already
 * selected still sends that one letter.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { optionInput } from '../src/ui/commandline';
import { matchKeyword } from '../src/tools/script';

/** Every `[A/B/...]` option group found in src (prompt texts and descriptions). */
function optionGroups(): string[][] {
  const out: string[][] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts')) for (const m of readFileSync(p, 'utf8').matchAll(/\[([A-Za-z0-9 ?]+(?:\/[A-Za-z0-9 ?]+)+)\]/g)) out.push(m[1]!.split('/').map((s) => s.trim()));
    }
  };
  walk('src');
  return out;
}

/** What a click sent before (the first letter of the option). */
const oldClick = (opt: string) => opt.replace(/[^A-Za-z]/g, '').slice(0, 1);

describe('prompt option clicks', () => {
  const groups = optionGroups();
  it('finds the prompts', () => {
    expect(groups.length).toBeGreaterThan(50);
  });

  it('each click selects its own option', () => {
    for (const g of groups) {
      for (const opt of g) {
        if (!/[A-Z]/.test(opt)) continue; // argument lists in lower case are not keyword prompts
        expect(matchKeyword(optionInput(opt, g), g), `${opt} in [${g.join('/')}]`).toBe(opt.toUpperCase());
      }
    }
  });

  it('options the old first-letter click already selected send the same letter', () => {
    let checked = 0;
    for (const g of groups) {
      for (const opt of g) {
        const caps = opt.replace(/[^A-Z]/g, '');
        if (caps.length !== 1 || oldClick(opt) !== caps || matchKeyword(oldClick(opt), g) !== opt.toUpperCase()) continue;
        expect(optionInput(opt, g), opt).toBe(oldClick(opt));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(150);
    // Where the old click picked another option, the whole option is sent now.
    expect(optionInput('Multiple', ['Undo', 'Polyline', 'Distance', 'Angle', 'Trim', 'mEthod', 'Multiple'])).toBe('Multiple');
    // Lower-case options keep their first letter; "?" sends itself (it used to send Enter).
    expect(optionInput('bom', ['bom', 'wires'])).toBe('b');
    expect(optionInput('?', ['?', 'Make'])).toBe('?');
  });

  it('multi-capital and clashing options select the right one', () => {
    const linear = ['Aligned', 'ANgular', 'Plane', 'Text'];
    expect(optionInput('ANgular', linear)).toBe('AN');
    expect(matchKeyword(optionInput('ANgular', linear), ['Aligned', 'ANgular', 'Plane', 'Text', 'Linear'])).toBe('ANGULAR');
    expect(optionInput('WPolygon', ['Window', 'WPolygon'])).toBe('WP');
    expect(optionInput('OFF', ['ON', 'OFF'])).toBe('OFF');
    expect(optionInput('TS32', ['TS35', 'TS32', 'TS15'])).toBe('TS32');
    expect(optionInput('Cube', ['Center', 'Cube', 'Length', '2Point'])).toBe('Cube');
    expect(optionInput('3Points', ['Current', 'Face', '3Points'])).toBe('P');
  });
});
