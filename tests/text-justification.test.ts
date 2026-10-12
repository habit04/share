import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { readDxf, writeDxf } from '../src/io/dxf';
import { importReportOf, geometryProblem } from '../src/io/import-report';
import { Drawing } from '../src/core/document';
import { inflateSync } from 'node:zlib';
import { convertDwg, type DwgImportPayload } from '../src/io/dwg';
import { placedText, textAnchor } from '../src/core/text-placement';
import { textWidth, textBounds, rotateEntity, scaleEntityBy, translateEntity, mirrorEntityAcross, moveGrip, gripPoints, explodeInsert, type TextEntity, type Entity, type InsertEntity } from '../src/core/entities';
import { drawEntity } from '../src/render/draw';
import { vectorPdf, drawingContext } from '../src/io/pdf-vector';
import { parsePdfBasics, pageContents, parseContentStream } from './helpers/pdf';

const fixture = readFileSync(new URL('./fixtures/interchange/r2000-text-justification.dxf', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const sample = () => readDxf(fixture);
const txt = (text: string) => sample().entities.find((e): e is TextEntity => e.type === 'text' && e.text === text)!;
const unwrap = (e: Entity) => { expect(e.type).toBe('text'); return e as TextEntity; };

/** Inspect native groups independently, rather than asking JCad to re-read its own result. */
function records(dxf: string, kind: string) {
  const lines = dxf.trimEnd().split(/\r?\n/);
  const objects: Array<Map<number, string>> = [];
  let object: Map<number, string> | null = null;
  for (let i = 0; i < lines.length; i += 2) {
    const code = Number(lines[i]); const value = lines[i + 1]!;
    if (code === 0) { if (object) objects.push(object); object = value === kind ? new Map() : null; }
    else object?.set(code, value);
  }
  if (object) objects.push(object);
  return objects;
}

describe('native TEXT and attribute justification', () => {
  it('retains source anchors and all fifteen legal justification combinations, even at the origin', () => {
    for (let v = 0; v <= 3; v++) for (let h = 0; h <= (v === 0 ? 5 : 2); h++) {
      const first = h === 3 || h === 5 ? [10, 0, 20, -10] : [10, 999, 20, 999];
      const s = readDxf([0, 'SECTION', 2, 'ENTITIES', 0, 'TEXT', ...first, 40, 2, 1, 'Ag', 72, h, 11, 0, 21, 0, 73, v, 0, 'ENDSEC', 0, 'EOF'].join('\n'));
      const t = unwrap(s.entities[0]!);
      expect(t.firstAlignmentPoint ?? t.position).toEqual({ x: Number(first[1]), y: Number(first[3]) });
      expect(t.alignmentPoint).toEqual({ x: 0, y: 0 });
      const rec = records(writeDxf(s), 'TEXT')[0]!;
      expect(Number(rec.get(72) ?? 0)).toBe(h);
      expect(Number(rec.get(73) ?? 0)).toBe(v);
      expect([Number(rec.get(11)), Number(rec.get(21))]).toEqual([0, 0]);
    }
  });

  it('positions top and middle against the native second anchor and rotation, without source mutation', () => {
    const top = txt('TOP AT ORIGIN');
    expect(placedText(top, textWidth).position).toEqual({ x: 0, y: -2 });
    expect(placedText(txt('MIDDLE'), textWidth).position).toEqual({ x: 30, y: 39 });
    const rotated = placedText(txt('ROTATED TOP'), textWidth);
    expect(rotated.position.x).toBeCloseTo(52);
    expect(rotated.position.y).toBeCloseTo(50);
    expect(top.firstAlignmentPoint).toEqual({ x: 999, y: 999 });
    expect(top.position).toEqual({ x: 0, y: 0 });
    expect(textBounds(top).max.y).toBeCloseTo(0);
    expect(textBounds(top).min.y).toBeCloseTo(-2);
  });

  it('FIT changes width only; ALIGNED scales height and width together and follows the two anchors', () => {
    const fit = placedText(txt('FIT'), textWidth);
    expect(fit.rotation).toBeCloseTo(Math.PI / 2);
    expect(fit.height).toBe(2);
    expect(textWidth(fit.text, fit.height) * fit.widthFactor!).toBeCloseTo(10);
    const aligned = placedText(txt('ALIGNED'), textWidth);
    expect(aligned.rotation).toBeCloseTo(Math.PI / 4);
    expect(aligned.widthFactor).toBe(1);
    expect(textWidth(aligned.text, aligned.height)).toBeCloseTo(Math.sqrt(200));
    expect(aligned.height).not.toBe(2);
  });

  it('native anchors survive move, rotate, scale, mirror, grips, export and undo', () => {
    const e = txt('FIT');
    const moved = unwrap(translateEntity(e, { x: 3, y: 4 }));
    expect(moved.position).toEqual({ x: 3, y: 4 });
    expect(moved.alignmentPoint).toEqual({ x: 3, y: 14 });
    const rotated = unwrap(rotateEntity(e, { x: 0, y: 0 }, -Math.PI / 2));
    expect(rotated.alignmentPoint!.x).toBeCloseTo(10);
    expect(placedText(rotated, textWidth).rotation).toBeCloseTo(0);
    const scaled = unwrap(scaleEntityBy(e, { x: 0, y: 0 }, 2));
    expect(scaled.height).toBe(4);
    expect(scaled.alignmentPoint).toEqual({ x: 0, y: 20 });
    const mirrored = unwrap(mirrorEntityAcross(e, { x: 0, y: 0 }, { x: 1, y: 0 }));
    expect(mirrored.alignmentPoint).toEqual({ x: 0, y: -10 });
    expect(gripPoints(e)).toEqual([{ x: 0, y: 0 }, { x: 0, y: 10 }]);
    expect(unwrap(moveGrip(e, 1, { x: 0, y: 20 })!).alignmentPoint).toEqual({ x: 0, y: 20 });
    const doc = new Drawing({ entities: [e] });
    doc.replaceEntities([moved]); doc.undo();
    expect(unwrap(doc.entities[0]!).alignmentPoint).toEqual(e.alignmentPoint);
    const rt = readDxf(writeDxf({ ...sample(), entities: [rotated] }));
    expect(unwrap(rt.entities[0]!).justification).toEqual({ horizontal: 5, vertical: 0 });
    expect(unwrap(rt.entities[0]!).alignmentPoint!.x).toBeCloseTo(10);
  });

  it('preserves an ATTRIB override instead of replacing it with the ATTDEF label placement', () => {
    const s = sample(); const ins = s.entities.find((e): e is InsertEntity => e.type === 'insert')!;
    const label = explodeInsert(ins, (n) => s.blocks[n]).find((e): e is TextEntity => e.type === 'text')!;
    expect(textAnchor(label)).toEqual({ x: 120, y: 130 });
    expect(label.justification).toEqual({ horizontal: 2, vertical: 3 });
    expect(placedText(label, textWidth).position).toEqual({ x: 120, y: 128 });
    const moved = translateEntity(ins, { x: 10, y: 20 }) as InsertEntity;
    const label2 = explodeInsert(moved, (n) => s.blocks[n]).find((e): e is TextEntity => e.type === 'text')!;
    expect(textAnchor(label2)).toEqual({ x: 130, y: 150 });
    const output = writeDxf(s);
    const a = records(output, 'ATTRIB')[0]!;
    expect([a.get(72), a.get(74), a.get(11), a.get(21)]).toEqual(['2', '3', '120', '130']);
    const def = records(output, 'ATTDEF')[0]!;
    expect([def.get(72), def.get(74)]).toEqual(['1', '3']);
  });

  it('imports exposed DWG justification without treating an origin anchor as missing', () => {
    const payload = { header: {}, layers: [], blocks: [], entities: [{ type: 'TEXT', layer: '0', startPoint: { x: 99, y: 99 }, endPoint: { x: 0, y: 0 }, text: 'DWG', textHeight: 2, rotation: Math.PI / 2, halign: 2, valign: 3, xScale: 1, obliqueAngle: 0.1 }] } as unknown as DwgImportPayload;
    const t = unwrap(convertDwg(payload).state.entities[0]!);
    expect(t.justification).toEqual({ horizontal: 2, vertical: 3 });
    expect(t.alignmentPoint).toEqual({ x: 0, y: 0 });
    expect(placedText(t, textWidth).position.x).toBeCloseTo(2);
    const output = records(writeDxf(convertDwg(payload).state), 'TEXT')[0]!;
    expect([output.get(72), output.get(73), output.get(11), output.get(21)]).toEqual(['2', '3', '0', '0']);
  });

  it('rejects incomplete or impossible fitting geometry with source warnings', () => {
    for (const extra of [[72, 5], [72, 3, 11, 0, 21, 0], [72, 5, 73, 3, 11, 10, 21, 0]]) {
      const r = readDxf([0, 'SECTION', 2, 'ENTITIES', 0, 'TEXT', 5, 'BEEF', 10, 0, 20, 0, 40, 1, 1, 'BAD', ...extra, 0, 'ENDSEC', 0, 'EOF'].join('\n'));
      expect(r.entities).toHaveLength(0);
      expect(JSON.stringify(importReportOf(r))).toContain('BEEF');
      expect(JSON.stringify(importReportOf(r))).toMatch(/justification|alignment/);
    }
  });

  it('tiny finite insert scales never store overflowing inverse ATTRIB placement', () => {
    const input = fixture.replace('2\nLABEL\n66\n1\n10\n100\n20\n100', '2\nLABEL\n66\n1\n10\n100\n20\n100\n41\n1e-320\n42\n1e-320');
    const s = readDxf(input);
    const ins = s.entities.find((e): e is InsertEntity => e.type === 'insert')!;
    expect(ins.scale).toBeGreaterThan(0);
    expect(ins.attributePlacements).toBeUndefined();
    expect(ins.attributes.TAG1).toBe('OVERRIDE');
    expect(geometryProblem(ins)).toBeNull();
    expect(JSON.stringify(importReportOf(s))).toContain('local coordinates');
    for (const part of explodeInsert(ins, (n) => s.blocks[n])) expect(geometryProblem(part)).toBeNull();
    expect(writeDxf(s)).not.toMatch(/NaN|Infinity/);
  });

  it('screen strokes and vector PDF use identical fitted/rotated glyph placement', () => {
    const s = { ...sample(), entities: [txt('FIT'), txt('ROTATED TOP')] };
    const screen: number[][] = [];
    const ctx = new Proxy({ lineWidth: 1 }, { get: (obj, key) => key === 'moveTo' || key === 'lineTo' ? (x: number, y: number) => screen.push([x, y]) : Reflect.get(obj, key) ?? (() => {}), set: (obj, key, value) => Reflect.set(obj, key, value) }) as unknown as CanvasRenderingContext2D;
    for (const e of s.entities) drawEntity(ctx, e, { toScreen: (p) => p, scale: 10 }, s.layers, () => undefined);
    const pdf = vectorPdf([{ width: 200, height: 200, label: 'Text', groups: [{ entities: s.entities, k: 1, e: 0, f: 0, hidden: new Set(), ltUnit: 1, annoFactor: 1 }] }], drawingContext(s, () => undefined), { mode: 'color', lineweights: true, usePlotStyles: true });
    const info = parsePdfBasics(pdf);
    expect(info.errors).toEqual([]);
    const paths = parseContentStream(pageContents(info, (bytes) => new Uint8Array(inflateSync(bytes)))[0]!).ops.filter((op) => op.op === 'm' || op.op === 'l').map((op) => op.args.map(Number));
    expect(paths.length).toBe(screen.length);
    for (let i = 0; i < paths.length; i++) for (let j = 0; j < 2; j++) expect(paths[i]![j]).toBeCloseTo(screen[i]![j]!, 2);
  });
});
