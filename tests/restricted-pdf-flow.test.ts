import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { Drawing } from '../src/core/document';
import type { TextEntity, Entity } from '../src/core/entities';
import { capturedPdfLookup, type PdfFontReader } from '../src/app/pdf-fonts';
import { ExportAdmission } from '../src/app/export-admission';
import type { FileBridge } from '../src/app/editor';
import type { FontMetricsRequest } from '../src/core/text-metrics';
import { pdfFontFixture } from './helpers/pdf-font-fixture';

const style = (name = 'FACE', font = 'arial.ttf') => ({ name, font, bigFont: '', flags: 0, height: 0, widthFactor: 1, oblique: 0, generation: 0 });
const text = (id = 'text', extra: Partial<TextEntity> = {}): TextEntity => ({ id, type: 'text', layer: '0', color: 'ByLayer', style: 'FACE', text: 'AB', position: { x: 3, y: 4 }, height: 7.3, rotation: 0, align: 'left', ...extra });
function drawing(entities: readonly Entity[] = [text()]) { return new Drawing({ entities: [...entities], meta: { textStyles: { FACE: style() } } }); }

describe('captured PDF lookup in restricted mode (12.4)', () => {
  it('ordinary mode refuses a preview/print face and names no restricted faces (control)', async () => {
    const seen: FontMetricsRequest[] = [];
    const reader: PdfFontReader = async (request) => { seen.push(request); return { font: pdfFontFixture({ family: request.family, fsType: 4 }) }; };
    const result = await capturedPdfLookup(drawing().snapshot, reader);
    expect(seen[0]).not.toHaveProperty('restricted');
    expect(result.issues.join(' ')).toContain('preview/print embedding requires a read-only PDF');
    expect(result.restrictedFaces).toEqual([]);
  });

  it('restricted mode marks the reads, admits the face, and names it with its exact request', async () => {
    const seen: FontMetricsRequest[] = [];
    const reader: PdfFontReader = async (request) => { seen.push(request); return { font: pdfFontFixture({ family: request.family, fsType: 4 }) }; };
    const result = await capturedPdfLookup(drawing().snapshot, reader, undefined, undefined, { restricted: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ font: 'arial.ttf', family: 'Arial', bold: false, italic: false, usedCodepoints: [65, 66], restricted: true });
    expect(result.issues).toEqual([]);
    expect(result.restrictedFaces).toHaveLength(1);
    expect(result.restrictedFaces[0]!.request).toEqual({ font: 'arial.ttf', family: 'Arial', bold: false, italic: false });
    expect(result.fonts).toBeDefined();
  });

  it('restricted mode still reports a restricted (0x0002) face as an issue', async () => {
    const reader: PdfFontReader = async (request) => ({ font: pdfFontFixture({ family: request.family, fsType: 2 }) });
    const result = await capturedPdfLookup(drawing().snapshot, reader, undefined, undefined, { restricted: true });
    expect(result.issues.join(' ')).toContain('restricted font embedding');
    expect(result.restrictedFaces).toEqual([]);
  });
});

interface Registration { ticket: string; claim: { path: string; sha256: string; byteLength: number; faces: readonly FontMetricsRequest[] } }
function admissionBridge() {
  const calls: string[] = [], registrations: Registration[] = [], saves: { bytes: Uint8Array; opts?: object }[] = [];
  const path = 'C:\\plots\\out.pdf';
  const bridge = {
    platform: 'win32',
    issueSaveAdmission: async () => { calls.push('issue'); return 'ticket-1'; },
    bindSaveAdmission: async () => { calls.push('bind'); return { identityPath: path, exists: false }; },
    cancelSaveAdmission: async () => { calls.push('cancel'); },
    choosePdfPath: async () => { calls.push('choose'); return path; },
    saveAdmissionResult: async () => ({ path, identityPath: path }),
    registerRestrictedPdf: async (ticket: string, claim: Registration['claim']) => { calls.push('register'); registrations.push({ ticket, claim }); return true; },
    savePdf: async (bytes: Uint8Array, _name: string, opts?: object) => { calls.push('save'); saves.push({ bytes, opts }); return path; },
  } as unknown as FileBridge;
  return { bridge, calls, registrations, saves, path };
}

describe('ExportAdmission restricted save (12.4)', () => {
  const faces = [{ font: 'arial.ttf', family: 'Arial', bold: false, italic: false }];

  it('registers the frozen digest + face claims against the ticket before saving with the matching claim', async () => {
    const { bridge, calls, registrations, saves, path } = admissionBridge();
    const admission = new ExportAdmission(bridge, true);
    await admission.choose('out.pdf');
    const bytes = new TextEncoder().encode('%PDF-1.4\nfrozen plot bytes');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const out = await admission.savePdf(bytes, 'out.pdf', { faces });
    expect(out).toBe(path);
    expect(calls.indexOf('register')).toBeLessThan(calls.indexOf('save'));
    expect(registrations).toEqual([{ ticket: 'ticket-1', claim: { path, sha256, byteLength: bytes.byteLength, faces } }]);
    expect(saves[0]!.opts).toEqual({ path, admission: 'ticket-1', restricted: { sha256, byteLength: bytes.byteLength } });
    await admission.close();
  });

  it('an ordinary save never registers and carries no restricted claim', async () => {
    const { bridge, registrations, saves } = admissionBridge();
    const admission = new ExportAdmission(bridge, true);
    await admission.choose('out.pdf');
    await admission.savePdf(new TextEncoder().encode('%PDF-1.4\nplain'), 'out.pdf');
    expect(registrations).toEqual([]);
    expect(saves[0]!.opts).not.toHaveProperty('restricted');
    await admission.close();
  });

  it('a restricted save without the host bridge method refuses before saving', async () => {
    const { bridge, saves } = admissionBridge();
    delete (bridge as { registerRestrictedPdf?: unknown }).registerRestrictedPdf;
    const admission = new ExportAdmission(bridge, true);
    await admission.choose('out.pdf');
    await expect(admission.savePdf(new TextEncoder().encode('%PDF-1.4\nx'), 'out.pdf', { faces })).rejects.toThrow(/Windows desktop host/);
    expect(saves).toEqual([]);
    await admission.close();
  });
});
