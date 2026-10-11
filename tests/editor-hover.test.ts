/**
 * Editor.setHover: the rollover highlight set from outside the canvas (the Symbol Builder
 * palette highlights the object of the row under the cursor) through the Editor's API instead of
 * its private overlay.
 */
import { describe, it, expect } from 'vitest';
import type { Editor } from '../src/app/editor';

async function makeEditor(): Promise<{ ed: Editor; hovers: Array<string | null> }> {
  const g = globalThis as Record<string, unknown>;
  g.requestAnimationFrame = () => 1;
  g.cancelAnimationFrame = () => {};
  const { Editor } = await import('../src/app/editor');
  const ed = new Editor({ getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }) } as unknown as HTMLCanvasElement);
  const hovers: Array<string | null> = [];
  ed.viewport.requestRender = (overlay) => void hovers.push(overlay?.hover ?? null);
  return { ed, hovers };
}

describe('Editor.setHover', () => {
  it('highlights the object in the next render and clears it with null', async () => {
    const { ed, hovers } = await makeEditor();
    ed.setHover('L1');
    ed.setHover(null);
    expect(hovers).toEqual(['L1', null]);
  });

  it('renders only when the highlight changes', async () => {
    const { ed, hovers } = await makeEditor();
    ed.setHover('L1');
    ed.setHover('L1');
    ed.setHover(null);
    ed.setHover(null);
    expect(hovers).toEqual(['L1', null]);
  });

  it('is the rollover the pointer sets: leaving the canvas clears it', async () => {
    const { ed, hovers } = await makeEditor();
    ed.setHover('L1');
    ed.onMouseLeave();
    expect(hovers).toEqual(['L1', null]);
  });
});
