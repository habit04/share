/** AutoCAD Color Index approximation. Index 7 is white on a dark background. */
const BASE: Record<number, string> = {
  1: '#ff0000',
  2: '#ffff00',
  3: '#00ff00',
  4: '#00ffff',
  5: '#0000ff',
  6: '#ff00ff',
  7: '#ffffff',
  8: '#808080',
  9: '#c0c0c0',
  250: '#333333',
  251: '#505050',
  252: '#696969',
  253: '#828282',
  254: '#bebebe',
  255: '#ffffff',
};

export function aciToCss(index: number): string {
  if (BASE[index]) return BASE[index]!;
  if (index >= 10 && index <= 249) {
    // 24 hue groups of 10 entries: even = full sat, odd = half sat, brightness steps
    const hueIdx = Math.floor((index - 10) / 10);
    const step = (index - 10) % 10;
    const hue = (hueIdx * 15) % 360;
    const light = step % 2 === 0 ? 1 : 0.6;
    const brightness = [1, 1, 0.8, 0.8, 0.6, 0.6, 0.5, 0.5, 0.35, 0.35][step] ?? 1;
    return hslToCss(hue, light, brightness);
  }
  return '#ffffff';
}

function hslToCss(hue: number, sat: number, val: number): string {
  // HSV -> RGB
  const c = val * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = val - c;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hue < 60) [r, g, b] = [c, x, 0];
  else if (hue < 120) [r, g, b] = [x, c, 0];
  else if (hue < 180) [r, g, b] = [0, c, x];
  else if (hue < 240) [r, g, b] = [0, x, c];
  else if (hue < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const h = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

export const ACI_NAMES: Record<number, string> = {
  1: 'Red',
  2: 'Yellow',
  3: 'Green',
  4: 'Cyan',
  5: 'Blue',
  6: 'Magenta',
  7: 'White',
  8: 'Gray',
  9: 'Light Gray',
};
