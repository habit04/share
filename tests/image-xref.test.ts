import { describe, it, expect } from 'vitest';
import type { ImageEntity, InsertEntity, BlockDef, TextEntity, PolylineEntity } from '../src/core/entities';
import { imageCorners, imageBoundary, imageParts, imageLabel, entityBounds, distanceToEntity, translateEntity, rotateEntity, mirrorEntityAcross, entityTypeName, explodeInsert, snapCandidates } from '../src/core/entities';
import { readDxf, writeDxf } from '../src/io/dxf';
import { convertDwg, type DwgImportPayload } from '../src/io/dwg';
import { Drawing } from '../src/core/document';
import { fakeContext, drive } from './fake-context';
import { DraftingExplodeTool } from '../src/tools/drafting-modify';
import { imageBitmap, renderSettings, clearImageCache } from '../src/render/draw';

const props = { layer: '0', color: 'ByLayer' as const };
const lookup = () => undefined;
const image = (over: Partial<ImageEntity> = {}): ImageEntity => ({ id: 'im', ...props, type: 'image', path: 'C:\\photos\\site plan.png', position: { x: 1, y: 2 }, u: { x: 0.01, y: 0 }, v: { x: 0, y: 0.01 }, size: { x: 400, y: 200 }, ...over });

describe('IMAGE entity', () => {
  it('frame from the insertion point and the U / V pixel vectors; label is the file name', () => {
    expect(imageCorners(image())).toEqual([{ x: 1, y: 2 }, { x: 5, y: 2 }, { x: 5, y: 4 }, { x: 1, y: 4 }]);
    expect(imageLabel(image())).toBe('site plan.png');
    const parts = imageParts(image());
    expect(parts[0]!.type).toBe('polyline');
    expect((parts[1] as TextEntity).text).toBe('site plan.png');
    expect(entityTypeName(image())).toBe('IMAGE');
  });
  it('rectangular clip boundary in pixel coordinates (origin at the top-left pixel)', () => {
    const clipped = image({ clipOn: true, clip: [{ x: -0.5, y: -0.5 }, { x: 199.5, y: 99.5 }] });
    const b = imageBoundary(clipped);
    // Left half, top half of the image.
    const xs = b.map((p) => p.x);
    const ys = b.map((p) => p.y);
    expect(Math.min(...xs)).toBeCloseTo(1);
    expect(Math.max(...xs)).toBeCloseTo(3);
    expect(Math.min(...ys)).toBeCloseTo(3);
    expect(Math.max(...ys)).toBeCloseTo(4);
  });
  it('bounds, pick inside the frame, snaps, transforms', () => {
    const im = image();
    expect(entityBounds(im, lookup)).toEqual({ min: { x: 1, y: 2 }, max: { x: 5, y: 4 } });
    expect(distanceToEntity({ x: 3, y: 3 }, im, lookup)).toBe(0);
    expect(snapCandidates(im, lookup)).toHaveLength(5);
    expect((translateEntity(im, { x: 1, y: 1 }) as ImageEntity).position).toEqual({ x: 2, y: 3 });
    const r = rotateEntity(im, { x: 1, y: 2 }, Math.PI / 2) as ImageEntity;
    expect(r.u.x).toBeCloseTo(0);
    expect(r.u.y).toBeCloseTo(0.01);
    const m = mirrorEntityAcross(im, { x: 0, y: 0 }, { x: 0, y: 1 }) as ImageEntity;
    expect(m.u.x).toBeCloseTo(-0.01);
  });
  it('the bitmap hook loads once per path and asks for a repaint', async () => {
    clearImageCache();
    let loads = 0;
    let redraws = 0;
    const fake = { width: 1, height: 1 } as unknown as ImageBitmap;
    renderSettings.imageLoader = async () => {
      loads += 1;
      return fake;
    };
    renderSettings.requestRedraw = () => void (redraws += 1);
    expect(imageBitmap('a.png')).toBeNull(); // pending
    expect(imageBitmap('a.png')).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(imageBitmap('a.png')).toBe(fake);
    expect(loads).toBe(1);
    expect(redraws).toBe(1);
    renderSettings.imageLoader = undefined;
    renderSettings.requestRedraw = undefined;
    clearImageCache();
    expect(imageBitmap('a.png')).toBeNull(); // no loader: frame + name only
  });
});

describe('IMAGE in DXF', () => {
  it('reads IMAGE + IMAGEDEF (path from the OBJECTS section, size, U/V, clipping)', () => {
    const dxf = [
      '0', 'SECTION', '2', 'ENTITIES',
      '0', 'IMAGE', '5', '40', '8', 'IMG', '100', 'AcDbEntity', '100', 'AcDbRasterImage', '90', '0',
      '10', '0', '20', '0', '30', '0', '11', '0.02', '21', '0', '31', '0', '12', '0', '22', '0.02', '32', '0', '13', '100', '23', '50',
      '340', '41', '70', '7', '280', '1', '281', '50', '282', '50', '283', '0', '360', '42', '71', '1', '91', '2', '14', '-0.5', '24', '-0.5', '14', '49.5', '24', '49.5',
      '0', 'ENDSEC',
      '0', 'SECTION', '2', 'OBJECTS',
      '0', 'DICTIONARY', '5', 'C', '100', 'AcDbDictionary', '3', 'ACAD_IMAGE_DICT', '350', '43',
      '0', 'IMAGEDEF', '5', '41', '330', '43', '100', 'AcDbRasterImageDef', '90', '0', '1', 'photos/logo.jpg', '10', '100', '20', '50', '11', '1', '21', '1', '280', '1', '281', '0',
      '0', 'ENDSEC', '0', 'EOF',
    ].join('\n');
    const im = readDxf(dxf).entities[0] as ImageEntity;
    expect(im).toMatchObject({ type: 'image', layer: 'IMG', path: 'photos/logo.jpg', size: { x: 100, y: 50 }, clipOn: true });
    expect(im.clip).toHaveLength(2);
    expect(entityBounds(im, lookup)!.max).toEqual({ x: 1, y: 1 }); // clipped to the left half
  });
  it('round-trips with IMAGEDEF, reactor, ACAD_IMAGE_DICT and the class records', () => {
    const d = new Drawing();
    d.addEntities([image(), image({ id: 'im2', position: { x: 10, y: 0 } }), image({ id: 'im3', path: 'other.bmp', clipOn: true, clip: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 80 }] })]);
    const text = writeDxf(d.snapshot);
    expect(text).toContain('\r\nCLASS\r\n1\r\nIMAGE\r\n');
    expect(text).toContain('ACAD_IMAGE_DICT');
    expect(text.match(/\r\n0\r\nIMAGEDEF\r\n/g)).toHaveLength(2); // one per file
    expect(text.match(/\r\n0\r\nIMAGEDEF_REACTOR\r\n/g)).toHaveLength(3);
    const back = readDxf(text).entities as ImageEntity[];
    expect(back.map((e) => e.path)).toEqual(['C:\\photos\\site plan.png', 'C:\\photos\\site plan.png', 'other.bmp']);
    expect(back[2]!.clip).toHaveLength(3);
    expect(back[0]!.u.x).toBeCloseTo(0.01);
    // The reactor points at the image's own handle.
    const imgHandle = /\r\n0\r\nIMAGE\r\n5\r\n([0-9A-F]+)\r\n/.exec(text)![1];
    expect(text).toMatch(new RegExp(`IMAGEDEF_REACTOR\\r\\n5\\r\\n[0-9A-F]+\\r\\n330\\r\\n${imgHandle}\\r\\n`));
  });
});

describe('external references (XREF blocks)', () => {
  const xrefBlock: BlockDef = { name: 'SITE', basePoint: { x: 0, y: 0 }, entities: [], attributes: [], xref: { path: '..\\xref\\site.dwg' } };
  const ins: InsertEntity = { id: 'x1', ...props, type: 'insert', block: 'SITE', position: { x: 5, y: 5 }, rotation: 0, scale: 2, attributes: {} };
  it('an insert of an unloaded xref draws a dashed frame with the name', () => {
    const parts = explodeInsert(ins, (n) => (n === 'SITE' ? xrefBlock : undefined));
    const frame = parts.find((p): p is PolylineEntity => p.type === 'polyline')!;
    expect(frame.linetype).toBe('DASHED');
    expect(frame.closed).toBe(true);
    expect(frame.points[0]).toEqual({ x: 5, y: 5 });
    expect((parts.find((p) => p.type === 'text') as TextEntity).text).toBe('SITE');
    expect(entityBounds(ins, (n) => (n === 'SITE' ? xrefBlock : undefined))!.max.x).toBeGreaterThan(6);
  });
  it('reads BLOCK flag 4 with the path in group 1 and keeps the record on write', () => {
    const dxf = [
      '0', 'SECTION', '2', 'BLOCKS',
      '0', 'BLOCK', '8', '0', '2', 'SITE', '70', '4', '10', '0', '20', '0', '3', 'SITE', '1', '..\\xref\\site.dwg',
      '0', 'ENDBLK',
      '0', 'BLOCK', '8', '0', '2', 'OVL', '70', '12', '10', '0', '20', '0', '3', 'OVL', '1', 'ovl.dwg',
      '0', 'ENDBLK',
      '0', 'ENDSEC',
      '0', 'SECTION', '2', 'ENTITIES', '0', 'INSERT', '8', '0', '2', 'SITE', '10', '5', '20', '5', '0', 'ENDSEC', '0', 'EOF',
    ].join('\n');
    const s = readDxf(dxf);
    expect(s.blocks.SITE!.xref).toEqual({ path: '..\\xref\\site.dwg' });
    expect(s.blocks.OVL!.xref).toEqual({ path: 'ovl.dwg', overlay: true });
    const out = writeDxf(s);
    expect(out).toMatch(/\r\n2\r\nSITE\r\n70\r\n4\r\n10\r\n0\r\n20\r\n0\r\n30\r\n0\r\n3\r\nSITE\r\n1\r\n\.\.\\xref\\site\.dwg\r\n/);
    expect(out).toMatch(/\r\n2\r\nOVL\r\n70\r\n12\r\n/);
    expect(readDxf(out).blocks.SITE!.xref!.path).toBe('..\\xref\\site.dwg');
  });
  it('EXPLODE refuses external references', () => {
    const doc = new Drawing({ blocks: { SITE: xrefBlock } });
    doc.addEntities([ins]);
    const ctx = fakeContext(doc);
    ctx.selection = new Set(['x1']);
    drive(new DraftingExplodeTool(), ctx, []);
    expect(doc.entities).toHaveLength(1);
    expect(ctx.logs.some((l) => l.includes('external reference'))).toBe(true);
  });
});

describe('IMAGE and XREF from DWG', () => {
  it('converts IMAGE with its IMAGEDEF file name and marks xref blocks; notes what is missing', () => {
    const payload: DwgImportPayload = {
      header: {},
      layers: [{ name: '0', colorIndex: 7, off: false, frozen: false, locked: false, lineweight: 29 }],
      blocks: [{ name: 'BASE', flags: 4, basePoint: { x: 0, y: 0, z: 0 }, entities: [], description: '' }],
      imageDefs: [{ handle: 'D1', fileName: 'scan.tif' }],
      entities: [
        { type: 'IMAGE', handle: 'I1', layer: '0', position: { x: 0, y: 0, z: 0 }, uPixel: { x: 0.5, y: 0, z: 0 }, vPixel: { x: 0, y: 0.5, z: 0 }, imageSize: { x: 10, y: 4 }, imageDefHandle: 'D1', clipping: 0, clippingBoundaryPath: [] } as never,
        { type: 'IMAGE', handle: 'I2', layer: '0', position: { x: 0, y: 0, z: 0 }, uPixel: { x: 1, y: 0, z: 0 }, vPixel: { x: 0, y: 1, z: 0 }, imageSize: { x: 1, y: 1 }, imageDefHandle: 'ZZ' } as never,
        { type: 'WIPEOUT', handle: 'W1', layer: '0' } as never,
      ],
    };
    const { state, notes, skipped } = convertDwg(payload);
    const [a, b] = state.entities as [ImageEntity, ImageEntity];
    expect(a.path).toBe('scan.tif');
    expect(entityBounds(a, lookup)!.max).toEqual({ x: 5, y: 2 });
    expect(b.path).toBe('');
    expect(state.blocks.BASE!.xref).toBeDefined();
    expect(skipped.WIPEOUT).toBe(1);
    expect(notes.some((n) => n.startsWith('IMAGE'))).toBe(true);
    expect(notes.some((n) => n.startsWith('XREF BASE'))).toBe(true);
    expect(notes.some((n) => n.startsWith('WIPEOUT'))).toBe(true);
  });
});
