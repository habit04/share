/**
 * P31A WIRING acceptance tests — PROPOSAL-P31-A-WIRING (FILED in LEDGER.md,
 * status: awaiting contracts owner). This prototype is FILED-UNADMITTED: it
 * is built under the proposal as filed and is marked unadmitted in every
 * artifact; nothing here is admitted, integrated or merged.
 *
 * The wiring surface under test (proposal items (1)–(5)):
 *   (1) Project.sheetSetPath — one optional key on the project file.
 *   (2) DocumentSession.sheetId — one optional field, parked with the session.
 *   (3) fieldContextFor(doc, extra, sheet?) + sheetFieldContextFor(host, session)
 *       in src/tools/drafting-annot.ts — the \AcSm hookup through the EXISTING
 *       FieldContext.sheetSet channel (src/core/fields.ts); no second channel.
 *   (4) SheetSetHost (src/app/sheet-set-host.ts) — holds the open set + file
 *       path + dirty flag + last link issues; no filesystem/DOM access.
 *   (5) These tests. NO DrawingState change, NO codec change, NO UI.
 *
 * Acceptance examples (1)–(6) from the proposal. Written before the
 * implementation: at head 38a8704 every case fails (the surface does not
 * exist — the host module is absent and the new fields/parameter are not
 * declared).
 *
 * ADDENDUM — RULING-P31-A-WIRING conformance delta (the proposal was
 * ADMITTED WITH CONDITIONS C1–C8 after the prototype above): tests (8)–(9)
 * are condition C3's evidence (same-drawing disambiguation, confined to
 * src/app/sheet-set-host.ts + these tests) and tests (10)–(11b) are
 * condition C2's evidence (load rebinding: the session layer re-derives or
 * clears DocumentSession.sheetId on every session content/file change).
 * Written before the conformance implementation: at head 3a3e63b every new
 * case fails — sheetForDrawing first-matches on path alone, and nothing in
 * the session layer re-derives or clears a binding on content replacement.
 */
import { describe, expect, it } from 'vitest';
import { Drawing } from '../src/core/document';
import { defaultLayout } from '../src/core/layouts';
import { evaluateFields, FIELD_UNAVAILABLE } from '../src/core/fields';
import {
  addSheet,
  createSheetSet,
  parseDstSubsetXml,
  type SheetSet,
  type SheetSetLinkResolver,
} from '../src/project/sheet-set';
import { SheetSetHost } from '../src/app/sheet-set-host';
import { parseProject, serializeProject, type Project } from '../src/app/project';
import { applySaveResult, SessionManager, type DocumentSession, type SessionHost } from '../src/app/sessions';
import { fieldContextFor, sheetFieldContextFor } from '../src/tools/drafting-annot';
import type { DrawingState } from '../src/core/document';

/** A two-sheet set over two drawings, mirroring the checkpoint-1 fixtures. */
function sampleSet(): { set: SheetSet; powerId: string; coverId: string } {
  let set = createSheetSet({ name: 'Plant A', description: 'Demo plant' });
  set = addSheet(set, { number: 'E-101', title: 'Power plan', drawingPath: 'drawings/power.dwg', layoutName: 'Layout1', revision: 'A', subset: 'Electrical' });
  set = addSheet(set, { number: 'E-001', title: 'Cover', drawingPath: 'drawings/cover.dwg', layoutName: 'Layout1' });
  const [power, cover] = set.sheets;
  return { set, powerId: power!.id, coverId: cover!.id };
}

const resolverFor = (files: Record<string, readonly string[]>): SheetSetLinkResolver =>
  (path) => {
    const layouts = files[path];
    return layouts ? { exists: true, layouts } : { exists: false, layouts: [] };
  };

describe('PROPOSAL-P31-A-WIRING (FILED-UNADMITTED prototype)', () => {
  it('(1) host JSON round trip preserves the set exactly, including sheet ids and preservation records', () => {
    const { set } = sampleSet();
    const host = new SheetSetHost();
    host.openSet(JSON.stringify(set), 'sets/plant-a.json');
    expect(host.current()).toEqual(set);
    expect(host.filePath).toBe('sets/plant-a.json');
    expect(host.dirty).toBe(false);
    const text = host.serializeSet('json');
    const host2 = new SheetSetHost();
    host2.openSet(text, 'sets/copy.json');
    expect(host2.current()).toEqual(set);
    // preservation records ride along too: a DST-imported set keeps its
    // attribute records through the host's JSON form
    const withAttrs = parseDstSubsetXml(
      `<AcSmSheetSet Version="3"><Name>Plant A</Name><AcSmSheet DataOwner="smith"><Number>E-101</Number><Title>Power plan</Title><LayoutName>Layout1</LayoutName><FilePath>drawings/power.dwg</FilePath></AcSmSheet></AcSmSheetSet>`,
    );
    const host3 = new SheetSetHost();
    host3.openSet(JSON.stringify(withAttrs), 'sets/attrs.json');
    expect(host3.current()).toEqual(withAttrs);
    expect(host3.current()?.sheets[0]?.dstAttributes).toEqual({ DataOwner: 'smith' });
  });

  it('(1b) strict parse failure holds no partial set', () => {
    const host = new SheetSetHost();
    expect(() => host.openSet('{not json', 'sets/bad.json')).toThrow();
    expect(host.current()).toBeUndefined();
    expect(host.filePath).toBeNull();
    expect(host.dirty).toBe(false);
  });

  it('(2) link issues are reported at the host and the set is never mutated or retargeted', () => {
    const { set, powerId } = sampleSet();
    const host = new SheetSetHost();
    host.openSet(JSON.stringify(set), 'sets/plant-a.json');
    const before = host.serializeSet('json');
    // power.dwg was renamed on disk; cover.dwg exists but its layout was renamed
    const issues = host.validateLinks(resolverFor({ 'drawings/cover.dwg': ['Cover sheet'] }));
    expect(issues.map((i) => i.kind)).toEqual(['missing-drawing', 'missing-layout']);
    expect(issues[0]?.sheetId).toBe(powerId);
    expect(host.lastIssues).toEqual(issues);
    // nothing dropped, nothing retargeted: the held set is byte-identical
    expect(host.serializeSet('json')).toBe(before);
    expect(host.dirty).toBe(false);
  });

  it('(2b) duplicate numbers are reported, not repaired', () => {
    let set = createSheetSet({ name: 'Dup' });
    set = addSheet(set, { number: 'E-101', title: 'One', drawingPath: 'a.dwg', layoutName: 'Layout1' });
    set = addSheet(set, { number: 'E-101', title: 'Two', drawingPath: 'b.dwg', layoutName: 'Layout1' });
    const host = new SheetSetHost();
    host.openSet(JSON.stringify(set), 'sets/dup.json');
    const issues = host.validateLinks(resolverFor({ 'a.dwg': ['Layout1'], 'b.dwg': ['Layout1'] }));
    expect(issues.map((i) => i.kind)).toEqual(['duplicate-number']);
    expect(host.current()?.sheets).toHaveLength(2);
  });

  it('(3) a bound session evaluates \\AcSm fields through the real evaluator; unbound yields ####', () => {
    const { set, powerId } = sampleSet();
    const host = new SheetSetHost();
    host.openSet(JSON.stringify(set), 'sets/plant-a.json');
    const doc = new Drawing({ entities: [], layouts: [defaultLayout('Layout1')] });
    doc.filePath = 'drawings/power.dwg';
    const session = { filePath: 'drawings/power.dwg' } as DocumentSession;
    // unbound: no sheet context, \AcSm is unavailable exactly as today
    const unbound = sheetFieldContextFor(host, doc, session);
    expect(unbound.sheetSet).toBeUndefined();
    expect(evaluateFields('%<\\AcSm Sheet.Number>%', unbound)).toBe(FIELD_UNAVAILABLE);
    // bind by drawing path: the sheet whose recorded path matches the session file
    const bound = host.bindSession(session, doc.filePath);
    expect(bound?.id).toBe(powerId);
    expect(session.sheetId).toBe(powerId);
    const fc = sheetFieldContextFor(host, doc, session);
    expect(evaluateFields('%<\\AcSm Sheet.Number>%', fc)).toBe('E-101');
    expect(evaluateFields('%<\\AcSm Sheet.Title>%', fc)).toBe('Power plan');
    expect(evaluateFields('%<\\AcSm SheetSet.Name>%', fc)).toBe('Plant A');
    expect(evaluateFields('%<\\AcSm Sheet.SheetIndex>%', fc)).toBe('1');
    expect(evaluateFields('%<\\AcSm SheetSet.SheetCount>%', fc)).toBe('2');
    // an unknown sheet id degrades to the plain context, never to another sheet
    const stale = { filePath: 'drawings/power.dwg', sheetId: 'sheet-does-not-exist' } as DocumentSession;
    const fcStale = sheetFieldContextFor(host, doc, stale);
    expect(fcStale.sheetSet).toBeUndefined();
    expect(evaluateFields('%<\\AcSm Sheet.Number>%', fcStale)).toBe(FIELD_UNAVAILABLE);
  });

  it('(3b) the sheet binding survives drawing state replacement: paper-space transact and outsideHistory settings', () => {
    const { set, powerId } = sampleSet();
    const host = new SheetSetHost();
    host.openSet(JSON.stringify(set), 'sets/plant-a.json');
    const doc = new Drawing({ entities: [], layouts: [defaultLayout('Layout1', 'in')] });
    doc.filePath = 'drawings/power.dwg';
    const session = { filePath: 'drawings/power.dwg' } as DocumentSession;
    host.bindSession(session, doc.filePath);
    const before = evaluateFields('%<\\AcSm Sheet.Number>%', sheetFieldContextFor(host, doc, session));
    expect(before).toBe('E-101');
    // activate the layout's paper space and edit through the projection path
    doc.setSpace({ layout: 'Layout1' });
    doc.transact((s) => s);
    // settings-class rewrites (outsideHistory): header patch + current layer
    doc.setHeader({ ltscale: 2 });
    // undo/redo of an ordinary edit
    doc.addEntities([{ id: 'e1', type: 'line', layer: '0', color: 'ByLayer', a: { x: 0, y: 0 }, b: { x: 1, y: 1 } }]);
    expect(doc.undo()).toBe(true);
    expect(doc.redo()).toBe(true);
    const after = evaluateFields('%<\\AcSm Sheet.Number>%', sheetFieldContextFor(host, doc, session));
    expect(after).toBe('E-101');
    expect(session.sheetId).toBe(powerId);
  });

  it('(4) sheetId parks and restores with the session through SessionManager tab switches', () => {
    const { set, powerId } = sampleSet();
    const host = new SheetSetHost();
    host.openSet(JSON.stringify(set), 'sets/plant-a.json');
    const docA = new Drawing({ entities: [] });
    docA.filePath = 'drawings/power.dwg';
    const fakeHost: SessionHost = {
      doc: docA,
      viewport: { center: { x: 0, y: 0 }, scale: 1 },
      selection: new Set<string>(),
      loadState(state: DrawingState, path: string | null) {
        docA.load(state, path);
      },
    };
    const mgr = new SessionManager(fakeHost);
    const active = mgr.current;
    active.filePath = 'drawings/power.dwg';
    expect(host.bindSession(active, active.filePath)?.id).toBe(powerId);
    expect(active.sheetId).toBe(powerId);
    const secondIndex = mgr.add(new Drawing({ entities: [] }).snapshot, 'drawings/cover.dwg');
    const second = mgr.all[secondIndex]!;
    expect(second.sheetId).toBeUndefined();
    expect(mgr.switchTo(0)).toBe(true);
    expect(mgr.current.sheetId).toBe(powerId);
    expect(mgr.switchTo(1)).toBe(true);
    expect(mgr.current.sheetId).toBeUndefined();
  });

  it('(5) DST subset text opens through the host and re-serializes with opaque fragments re-emitted', () => {
    const DST = `<?xml version="1.0" encoding="UTF-8"?>
<AcSmSheetSet>
  <Name>Plant A</Name>
  <AcSmSheet><Number>E-001</Number><Title>Cover</Title><LayoutName>Layout1</LayoutName><FilePath>drawings/cover.dwg</FilePath><VendorExtension>opaque-keepme</VendorExtension></AcSmSheet>
  <FutureComponent version="99">unmodeled</FutureComponent>
</AcSmSheetSet>`;
    const host = new SheetSetHost();
    host.openSet(DST, 'sets/plant-a.dst');
    expect(host.current()?.name).toBe('Plant A');
    expect(host.current()?.sheets.map((s) => s.number)).toEqual(['E-001']);
    const xml = host.serializeSet('dst');
    expect(xml).toContain('FutureComponent');
    expect(xml).toContain('opaque-keepme');
    // and the DST form opens again through the host (modelled subset stable)
    const host2 = new SheetSetHost();
    host2.openSet(xml, 'sets/copy.dst');
    expect(host2.current()?.sheets.map((s) => [s.number, s.drawingPath, s.layoutName])).toEqual([['E-001', 'drawings/cover.dwg', 'Layout1']]);
  });

  it('(6) inertness control: no sheet argument means no sheetSet key; a project without the key round-trips as base', () => {
    const doc = new Drawing({ entities: [] });
    const fc = fieldContextFor(doc);
    expect('sheetSet' in fc).toBe(false);
    const withExtra = fieldContextFor(doc, { title: 'T' });
    expect('sheetSet' in withExtra).toBe(false);
    const project: Project = { name: 'P', drawings: [{ file: 'a.dwg' }] };
    const text = serializeProject(project);
    expect(text).not.toContain('sheetSet');
    expect(parseProject(text)).toEqual({ name: 'P', drawings: [{ file: 'a.dwg' }] });
    // with the key: it round-trips through parse/serialize
    const withSet: Project = { name: 'P', drawings: [], sheetSetPath: 'sets/plant-a.dst' };
    const back = parseProject(serializeProject(withSet));
    expect(back.sheetSetPath).toBe('sets/plant-a.dst');
  });

  it('(7) set edits through the host dirty the HOST only — never a drawing, never an undo entry', () => {
    const { set } = sampleSet();
    const host = new SheetSetHost();
    host.openSet(JSON.stringify(set), 'sets/plant-a.json');
    const doc = new Drawing({ entities: [] });
    const undoDepth = doc.undoLimit;
    expect(host.dirty).toBe(false);
    const edited = host.applyEdit((s) => ({ ...s, name: 'Plant B' }));
    expect(edited.name).toBe('Plant B');
    expect(host.current()?.name).toBe('Plant B');
    expect(host.dirty).toBe(true);
    expect(doc.dirty).toBe(false);
    expect(doc.canUndo()).toBe(false);
    expect(undoDepth).toBe(doc.undoLimit);
    // opening another set resets the host dirty flag and issues
    host.openSet(JSON.stringify(set), 'sets/other.json');
    expect(host.dirty).toBe(false);
    expect(host.lastIssues).toEqual([]);
  });
});

describe('RULING-P31-A-WIRING C3 — same-drawing disambiguation', () => {
  /** One drawing file, two layouts recorded as two sheets (the lead's DST recipe shape). */
  function multiLayoutSet(): { set: SheetSet; firstId: string; secondId: string } {
    let set = createSheetSet({ name: 'Multi' });
    set = addSheet(set, { number: 'M-1', title: 'First layout sheet', drawingPath: 'drawings/multi.dwg', layoutName: 'Layout1' });
    set = addSheet(set, { number: 'M-2', title: 'Second layout sheet', drawingPath: 'drawings/multi.dwg', layoutName: 'Layout2' });
    const [first, second] = set.sheets;
    return { set, firstId: first!.id, secondId: second!.id };
  }

  function docOnLayout(layout: string | null): Drawing {
    const doc = new Drawing({ entities: [], layouts: [defaultLayout('Layout1'), defaultLayout('Layout2')] });
    doc.filePath = 'drawings/multi.dwg';
    if (layout) doc.setSpace({ layout });
    return doc;
  }

  it('(8) two sheets recording one drawing bind each session to its OWN layout\'s sheet', () => {
    const { set, firstId, secondId } = multiLayoutSet();
    const host = new SheetSetHost();
    host.openSet(JSON.stringify(set), 'sets/multi.json');
    const docA = docOnLayout('Layout1');
    const sessionA = { filePath: 'drawings/multi.dwg', state: docA.snapshot } as DocumentSession;
    expect(host.bindSession(sessionA, sessionA.filePath)?.id).toBe(firstId);
    expect(sessionA.sheetId).toBe(firstId);
    expect(evaluateFields('%<\\AcSm Sheet.Number>%', sheetFieldContextFor(host, docA, sessionA))).toBe('M-1');
    const docB = docOnLayout('Layout2');
    const sessionB = { filePath: 'drawings/multi.dwg', state: docB.snapshot } as DocumentSession;
    // the second sheet in file order: a path-only first-match would serve M-1 here
    expect(host.bindSession(sessionB, sessionB.filePath)?.id).toBe(secondId);
    expect(sessionB.sheetId).toBe(secondId);
    expect(evaluateFields('%<\\AcSm Sheet.Number>%', sheetFieldContextFor(host, docB, sessionB))).toBe('M-2');
    // a decided bind leaves no ambiguity on the host's binding issue list
    expect(host.bindingIssues).toEqual([]);
  });

  it('(9) where the layout cannot disambiguate, the session stays UNBOUND and the ambiguity is surfaced', () => {
    const { set, firstId, secondId } = multiLayoutSet();
    const host = new SheetSetHost();
    host.openSet(JSON.stringify(set), 'sets/multi.json');
    // Model tab: the session document has no relevant layout, so neither
    // candidate may be served — never the first by file order
    const docModel = docOnLayout(null);
    const sessionModel = { filePath: 'drawings/multi.dwg', state: docModel.snapshot } as DocumentSession;
    expect(host.bindSession(sessionModel, sessionModel.filePath)).toBeUndefined();
    expect(sessionModel.sheetId).toBeUndefined();
    expect(evaluateFields('%<\\AcSm Sheet.Number>%', sheetFieldContextFor(host, docModel, sessionModel))).toBe(FIELD_UNAVAILABLE);
    expect(host.bindingIssues).toHaveLength(1);
    expect(host.bindingIssues[0]?.kind).toBe('ambiguous-drawing');
    expect(host.bindingIssues[0]?.drawingPath).toBe('drawings/multi.dwg');
    expect(host.bindingIssues[0]?.sheetIds).toEqual([firstId, secondId]);
    // an active layout that no candidate records is equally undecidable
    const docOther = new Drawing({ entities: [], layouts: [defaultLayout('Layout1'), defaultLayout('Layout2'), defaultLayout('Layout3')] });
    docOther.filePath = 'drawings/multi.dwg';
    docOther.setSpace({ layout: 'Layout3' });
    const sessionOther = { filePath: 'drawings/multi.dwg', state: docOther.snapshot } as DocumentSession;
    expect(host.bindSession(sessionOther, sessionOther.filePath)).toBeUndefined();
    expect(sessionOther.sheetId).toBeUndefined();
    expect(host.bindingIssues).toHaveLength(1);
    // two sheets recording the same drawing AND the same layout: even a
    // matching active layout cannot choose between them
    let dup = createSheetSet({ name: 'Dup layout' });
    dup = addSheet(dup, { number: 'D-1', title: 'One', drawingPath: 'drawings/dup.dwg', layoutName: 'Layout1' });
    dup = addSheet(dup, { number: 'D-2', title: 'Two', drawingPath: 'drawings/dup.dwg', layoutName: 'Layout1' });
    const host2 = new SheetSetHost();
    host2.openSet(JSON.stringify(dup), 'sets/dup-layout.json');
    const docDup = new Drawing({ entities: [], layouts: [defaultLayout('Layout1')] });
    docDup.filePath = 'drawings/dup.dwg';
    docDup.setSpace({ layout: 'Layout1' });
    const sessionDup = { filePath: 'drawings/dup.dwg', state: docDup.snapshot } as DocumentSession;
    expect(host2.bindSession(sessionDup, sessionDup.filePath)).toBeUndefined();
    expect(sessionDup.sheetId).toBeUndefined();
    expect(host2.bindingIssues).toHaveLength(1);
    expect(host2.bindingIssues[0]?.sheetIds).toHaveLength(2);
  });
});

describe('RULING-P31-A-WIRING C2 — load rebinding', () => {
  /**
   * A SessionManager over a fake host whose live document is the power
   * drawing. When `wireHook` is set, the manager's session-file-changed
   * hook is composed with the SheetSetHost exactly as the app layer will
   * compose it: re-derive the binding from the session's NEW file path.
   */
  function managerWith(setHost: SheetSetHost, wireHook: boolean): { doc: Drawing; fakeHost: SessionHost; mgr: SessionManager } {
    const doc = new Drawing({ entities: [], layouts: [defaultLayout('Layout1')] });
    doc.filePath = 'drawings/power.dwg';
    const fakeHost: SessionHost = {
      doc,
      viewport: { center: { x: 0, y: 0 }, scale: 1 },
      selection: new Set<string>(),
      loadState(state: DrawingState, path: string | null) {
        doc.load(state, path);
      },
    };
    const mgr = new SessionManager(fakeHost);
    if (wireHook) {
      mgr.onSessionFileChanged = (s) => {
        setHost.bindSession(s, s.filePath);
      };
    }
    return { doc, fakeHost, mgr };
  }

  it('(10) a bound session whose content is replaced evaluates the NEW drawing\'s values or #### — never the previous drawing\'s', () => {
    const { set, powerId, coverId } = sampleSet();
    const host = new SheetSetHost();
    host.openSet(JSON.stringify(set), 'sets/plant-a.json');
    const { doc, mgr } = managerWith(host, true);
    const id = mgr.current.id;
    host.bindSession(mgr.current, mgr.current.filePath);
    expect(mgr.current.sheetId).toBe(powerId);
    expect(evaluateFields('%<\\AcSm Sheet.Number>%', sheetFieldContextFor(host, doc, mgr.current))).toBe('E-101');
    // open a different drawing INTO the session: the binding re-derives
    // against the new file — the cover sheet's values, not the power sheet's
    const coverDoc = new Drawing({ entities: [], layouts: [defaultLayout('Layout1')] });
    expect(mgr.loadInto(id, coverDoc.snapshot, 'drawings/cover.dwg')).toBe(true);
    expect(mgr.current.sheetId).toBe(coverId);
    expect(evaluateFields('%<\\AcSm Sheet.Number>%', sheetFieldContextFor(host, doc, mgr.current))).toBe('E-001');
    // replace again with a drawing no sheet records: unbound and #### —
    // never the previous drawing's E-001
    const otherDoc = new Drawing({ entities: [] });
    expect(mgr.loadInto(id, otherDoc.snapshot, 'drawings/other.dwg')).toBe(true);
    expect(mgr.current.sheetId).toBeUndefined();
    expect(evaluateFields('%<\\AcSm Sheet.Number>%', sheetFieldContextFor(host, doc, mgr.current))).toBe(FIELD_UNAVAILABLE);
  });

  it('(10b) with NO re-derivation hook connected, a replaced session\'s binding is CLEARED by the session layer itself', () => {
    const { set, powerId } = sampleSet();
    const host = new SheetSetHost();
    host.openSet(JSON.stringify(set), 'sets/plant-a.json');
    const { doc, mgr } = managerWith(host, false);
    const id = mgr.current.id;
    host.bindSession(mgr.current, mgr.current.filePath);
    expect(mgr.current.sheetId).toBe(powerId);
    const coverDoc = new Drawing({ entities: [], layouts: [defaultLayout('Layout1')] });
    expect(mgr.loadInto(id, coverDoc.snapshot, 'drawings/cover.dwg')).toBe(true);
    // the stale id did not survive onto the different drawing: worst case
    // is an unbound session (####), never the previous drawing's values
    expect(mgr.current.sheetId).toBeUndefined();
    expect(evaluateFields('%<\\AcSm Sheet.Number>%', sheetFieldContextFor(host, doc, mgr.current))).toBe(FIELD_UNAVAILABLE);
  });

  it('(11) save-as re-derives the binding against the new path; a plain save keeps it', () => {
    const { set, powerId, coverId } = sampleSet();
    const host = new SheetSetHost();
    host.openSet(JSON.stringify(set), 'sets/plant-a.json');
    const { doc, fakeHost, mgr } = managerWith(host, true);
    const session = mgr.current;
    host.bindSession(session, session.filePath);
    expect(session.sheetId).toBe(powerId);
    // plain save at the same path: the file did not change, binding kept
    expect(applySaveResult(mgr, fakeHost, session.id, doc.snapshot, 'drawings/power.dwg', session.contentGeneration)).toBe('clean');
    expect(mgr.current.sheetId).toBe(powerId);
    // save-as onto the cover drawing's path: the binding follows the file
    const s2 = mgr.current;
    expect(applySaveResult(mgr, fakeHost, s2.id, doc.snapshot, 'drawings/cover.dwg', s2.contentGeneration)).toBe('clean');
    expect(mgr.current.sheetId).toBe(coverId);
    expect(evaluateFields('%<\\AcSm Sheet.Number>%', sheetFieldContextFor(host, doc, mgr.current))).toBe('E-001');
    // save-as onto a path no sheet records: unbound and ####, never E-001
    const s3 = mgr.current;
    expect(applySaveResult(mgr, fakeHost, s3.id, doc.snapshot, 'drawings/other.dwg', s3.contentGeneration)).toBe('clean');
    expect(mgr.current.sheetId).toBeUndefined();
    expect(evaluateFields('%<\\AcSm Sheet.Number>%', sheetFieldContextFor(host, doc, mgr.current))).toBe(FIELD_UNAVAILABLE);
  });

  it('(11b) a save result recorded for a PARKED session re-derives that session\'s binding too', () => {
    const { set, powerId, coverId } = sampleSet();
    const host = new SheetSetHost();
    host.openSet(JSON.stringify(set), 'sets/plant-a.json');
    const { fakeHost, mgr } = managerWith(host, true);
    const coverDoc = new Drawing({ entities: [], layouts: [defaultLayout('Layout1')] });
    const idx = mgr.addInBackground(coverDoc.snapshot, 'drawings/cover.dwg');
    const parked = mgr.all[idx]!;
    host.bindSession(parked, parked.filePath);
    expect(parked.sheetId).toBe(coverId);
    // the parked tab's save completes under the power drawing's path
    expect(applySaveResult(mgr, fakeHost, parked.id, parked.state, 'drawings/power.dwg', parked.contentGeneration)).toBe('clean');
    expect(parked.filePath).toBe('drawings/power.dwg');
    expect(parked.sheetId).toBe(powerId);
  });
});
