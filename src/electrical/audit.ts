/**
 * Electrical Audit (AutoCAD Electrical style): checks on tags, parent/child
 * links, wire numbers, wire connectivity and catalog data. Each issue
 * carries the entity and position so the audit dialog can jump to it.
 */
import type { Point } from '../core/geometry';
import type { Entity, InsertEntity, LineEntity } from '../core/entities';
import type { Drawing } from '../core/document';
import { isWire, isHorizontal, isVertical, nearestReference } from './ladder';
import { isParentComponent, isChild, isTerminal, isCoil, isExtraPole } from './families';
import { collectNets, netOfWireNumber, isWireNumber, wireDegree, WIRENO_LAYER, connectionLevels, symbolSpan } from './wires';
import { WIRE_DOT } from './symbols';

export interface AuditIssue {
  check: string;
  item: string;
  detail: string;
  severity: 'error' | 'warning';
  entityId?: string;
  position?: Point;
}

const fmt = (p: Point) => `${p.x.toFixed(2)}, ${p.y.toFixed(2)}`;

export function auditIssues(doc: Drawing): AuditIssue[] {
  const out: AuditIssue[] = [];
  const ents = doc.entities;
  const lookup = doc.lookupBlock;
  const parents = ents.filter(isParentComponent);
  const byTag = new Map<string, InsertEntity[]>();
  for (const p of parents) {
    const t = p.attributes.TAG1!;
    byTag.set(t, [...(byTag.get(t) ?? []), p]);
  }
  // duplicate tags
  for (const [t, list] of byTag) {
    if (list.length > 1) for (const p of list) out.push({ check: 'Duplicate tag', item: t, detail: `${list.length} devices share this tag (${p.block})`, severity: 'error', entityId: p.id, position: p.position });
  }
  // children
  const coilsByTag = new Map<string, InsertEntity>();
  for (const p of parents) coilsByTag.set(p.attributes.TAG1!, p);
  const contactCount = new Map<string, number>();
  for (const e of ents) {
    if (!isChild(e)) continue;
    const t = e.attributes.TAG1 ?? '';
    contactCount.set(t, (contactCount.get(t) ?? 0) + 1);
    const parent = coilsByTag.get(t);
    if (!t) out.push({ check: 'Contact without tag', item: e.block, detail: `at ${fmt(e.position)}`, severity: 'error', entityId: e.id, position: e.position });
    else if (!parent) out.push({ check: 'Contact without coil', item: t, detail: `no parent device tagged ${t} (${e.block})`, severity: 'error', entityId: e.id, position: e.position });
    else {
      for (const k of ['INST', 'LOC']) {
        const a = e.attributes[k] ?? '';
        const b = parent.attributes[k] ?? '';
        if (a && b && a !== b) out.push({ check: 'Child/parent mismatch', item: t, detail: `${k} "${a}" differs from parent "${b}"`, severity: 'warning', entityId: e.id, position: e.position });
      }
    }
  }
  for (const p of parents) {
    if (isCoil(p) && !(contactCount.get(p.attributes.TAG1!) ?? 0)) out.push({ check: 'Coil without contacts', item: p.attributes.TAG1!, detail: `${p.block} has no child contacts`, severity: 'warning', entityId: p.id, position: p.position });
  }
  // extra poles without a first pole
  for (const e of ents) {
    if (!isExtraPole(e)) continue;
    const t = e.attributes.TAG1 ?? '';
    if (!byTag.has(t)) out.push({ check: 'Pole without parent', item: t, detail: `pole ${e.attributes.POLE} has no first pole`, severity: 'error', entityId: e.id, position: e.position });
  }
  // wire numbers
  const nets = collectNets(ents);
  const labels = ents.filter(isWireNumber);
  const labelled = new Map<(typeof nets)[number], string[]>();
  for (const t of labels) {
    const n = netOfWireNumber(nets, t);
    if (!n) out.push({ check: 'Orphan wire number', item: t.text, detail: `no wire under the number at ${fmt(t.position)}`, severity: 'warning', entityId: t.id, position: t.position });
    else labelled.set(n, [...(labelled.get(n) ?? []), t.text]);
  }
  for (const n of nets) {
    if (!labelled.has(n)) out.push({ check: 'Unnumbered wire', item: `y = ${n.y.toFixed(3)}`, detail: 'run AEWIRENO', severity: 'warning', entityId: n.wires[0]!.id, position: { x: n.x0, y: n.y } });
  }
  const seenLabel = new Map<string, (typeof nets)[number]>();
  for (const t of labels) {
    if (t.layer !== WIRENO_LAYER) continue; // fixed copies are intentional duplicates
    const n = netOfWireNumber(nets, t);
    if (!n) continue;
    const prev = seenLabel.get(t.text);
    if (prev && prev !== n) out.push({ check: 'Duplicate wire number', item: t.text, detail: `also used on the wire at y = ${prev.y.toFixed(3)}`, severity: 'error', entityId: t.id, position: t.position });
    else seenLabel.set(t.text, n);
  }
  // wire geometry
  const comps = ents.filter((e): e is InsertEntity => e.type === 'insert' && e.block !== WIRE_DOT.name);
  const touchesComponent = (p: Point): boolean => {
    for (const c of comps) {
      const b = symbolSpan(c, lookup);
      if (p.x >= b.min.x - 0.02 && p.x <= b.max.x + 0.02 && p.y >= b.min.y - 0.02 && p.y <= b.max.y + 0.02) return true;
    }
    return false;
  };
  for (const w of ents) {
    if (!isWire(w)) continue;
    if (Math.abs(w.a.x - w.b.x) < 1e-6 && Math.abs(w.a.y - w.b.y) < 1e-6) {
      out.push({ check: 'Zero-length wire', item: w.layer, detail: `at ${fmt(w.a)}`, severity: 'error', entityId: w.id, position: w.a });
      continue;
    }
    if (!isHorizontal(w) && !isVertical(w)) out.push({ check: 'Non-orthogonal wire', item: w.layer, detail: `from ${fmt(w.a)} to ${fmt(w.b)}`, severity: 'warning', entityId: w.id, position: w.a });
    if (isVertical(w)) continue; // rails end in free space by design
    for (const p of [w.a, w.b]) {
      if (wireDegree(ents, p) >= 2 || touchesComponent(p)) continue;
      out.push({ check: 'Dangling wire', item: w.layer, detail: `open end at ${fmt(p)}`, severity: 'warning', entityId: w.id, position: p });
    }
  }
  // stale / missing junction dots
  for (const e of ents) {
    if (e.type === 'insert' && e.block === WIRE_DOT.name && wireDegree(ents, e.position) < 3) out.push({ check: 'Stale junction dot', item: 'WDDOT', detail: `dot without a tee at ${fmt(e.position)}`, severity: 'warning', entityId: e.id, position: e.position });
  }
  // components off wire
  for (const p of parents) {
    if (isTerminal(p) || /^(HGND|IEC_PE|HPLC|IEC_PLC)/.test(p.block)) continue;
    const b = symbolSpan(p, lookup);
    const levels = connectionLevels(p, lookup);
    const connected = levels.some((y) => ents.some((w): w is LineEntity => isWire(w) && isHorizontal(w) && Math.abs(w.a.y - y) < 0.05 && (Math.abs(Math.max(w.a.x, w.b.x) - b.min.x) < 0.02 || Math.abs(Math.min(w.a.x, w.b.x) - b.max.x) < 0.02)));
    if (!connected) out.push({ check: 'Component not on a wire', item: p.attributes.TAG1!, detail: `${p.block} at ${fmt(p.position)}`, severity: 'warning', entityId: p.id, position: p.position });
  }
  // data
  for (const p of parents) {
    if (/^(HGND|IEC_PE)/.test(p.block)) continue;
    const missing = [!p.attributes.MFG && 'MFG', !p.attributes.CAT && 'CAT'].filter(Boolean);
    if (missing.length) out.push({ check: 'Missing catalog data', item: p.attributes.TAG1!, detail: `${missing.join(', ')} empty (rung ${nearestReference(doc, p.position) ?? '?'})`, severity: 'warning', entityId: p.id, position: p.position });
    if (!p.attributes.DESC1 && !/PLC/.test(p.block)) out.push({ check: 'Missing description', item: p.attributes.TAG1!, detail: p.block, severity: 'warning', entityId: p.id, position: p.position });
  }
  for (const e of ents) {
    if (isTerminal(e) && !e.attributes.TERM01) out.push({ check: 'Terminal without number', item: e.block, detail: `at ${fmt(e.position)}`, severity: 'warning', entityId: e.id, position: e.position });
  }
  const order = { error: 0, warning: 1 };
  return out.sort((a, b) => order[a.severity] - order[b.severity] || a.check.localeCompare(b.check) || a.item.localeCompare(b.item, undefined, { numeric: true }));
}

/** Summary counts for the status line of the audit dialog. */
export function auditSummary(issues: AuditIssue[]): { errors: number; warnings: number } {
  return { errors: issues.filter((i) => i.severity === 'error').length, warnings: issues.filter((i) => i.severity === 'warning').length };
}

export type { Entity };
