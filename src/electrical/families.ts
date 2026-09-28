/**
 * Component classification shared by tagging, cross-referencing, reports and
 * the panel tools: which blocks are coils (parents), contacts (children),
 * extra poles of a multi-pole device, terminals, and which are not
 * components at all (wire dots, arrows, settings block, footprints).
 */
import type { Entity, InsertEntity } from '../core/entities';

/** Coils / parent devices whose contacts are children: relays, timers, contactors (JIC and IEC). */
export const COIL_RE = /^(HCR1|HTD[1-4]|HKM1|HSOL1|HSV[12]|HSR1|HLR1|HAR1|HCN1|HPM1|IEC_K_COIL|IEC_K_LATCH|IEC_K_CNT|IEC_K_SAFETY|IEC_KA_COIL|IEC_KM_COIL|IEC_KT_ON|IEC_KT_OFF|IEC_KT_STAR|IEC_KT_CYC|IEC_Y_)/;
/** Child contacts: they share the parent's tag and never appear in the BOM on their own. */
export const CHILD_RE = /^(HCR1_N[OC]|HTD[12]_N[OC]|HKM1_N[OC]|HSR1_N[OC]|HLR1_N[OC]|HAR1_N[OC]|HCN1_N[OC]|HPM1_N[OC]|IEC_K_N[OC]|IEC_K_SAFETY_N[OC]|IEC_KA_N[OC]|IEC_KM_N[OC]|IEC_KM_MAIN3|IEC_KT_(ON|OFF)_N[OC]|IEC_KT_STAR_(Y_NC|D_NO))$/;
/** Blocks that are drawing furniture rather than components. */
export const NON_COMPONENT_RE = /^(WDDOT|WD_SRC_ARROW|WD_DST_ARROW|WD_M|WD_TITLEBLOCK|WD_BALLOON|WD_NAMEPLATE|WD_GAP|WD_FP_)/;

export const isCoilBlock = (block: string): boolean => COIL_RE.test(block) && !/_N[OC]$/.test(block);
export const isChildBlock = (block: string): boolean => CHILD_RE.test(block);
export const isFootprintBlock = (block: string): boolean => block.startsWith('WD_FP_');

/**
 * Branded insert types: the predicates below narrow to a subtype so that
 * the false branch of `if (isChild(e))` keeps `e` as an InsertEntity
 * instead of collapsing it to `never`.
 */
export type CoilInsert = InsertEntity & { readonly __kind: 'coil' };
export type ChildInsert = InsertEntity & { readonly __kind: 'child' };
export type PoleInsert = InsertEntity & { readonly __kind: 'pole' };
export type TerminalInsert = InsertEntity & { readonly __kind: 'terminal' };
export type FootprintInsert = InsertEntity & { readonly __kind: 'footprint' };

export const isCoil = (e: Entity): e is CoilInsert => e.type === 'insert' && isCoilBlock(e.block);
export const isChild = (e: Entity): e is ChildInsert => e.type === 'insert' && isChildBlock(e.block);
/** Second and further poles of a 3-phase device inserted with AECOMPONENT3 (POLE = 2, 3). */
export const isExtraPole = (e: Entity): e is PoleInsert => e.type === 'insert' && parseInt(e.attributes.POLE ?? '1', 10) > 1;
export const isTerminal = (e: Entity): e is TerminalInsert => e.type === 'insert' && e.attributes.TERM01 !== undefined && !NON_COMPONENT_RE.test(e.block);
export const isFootprint = (e: Entity): e is FootprintInsert => e.type === 'insert' && isFootprintBlock(e.block);

/** Any schematic component insert (has a tag or terminal number, not furniture). */
export const isComponent = (e: Entity): e is InsertEntity =>
  e.type === 'insert' && !NON_COMPONENT_RE.test(e.block) && (e.attributes.TAG1 !== undefined || e.attributes.TERM01 !== undefined);

/** A tagged parent device: counted once in BOMs and audits (not a child contact or extra pole). */
export const isParentComponent = (e: Entity): e is InsertEntity => isComponent(e) && e.attributes.TAG1 !== undefined && !isChild(e) && !isExtraPole(e);

/** NO <-> NC variant of a contact-style block, or null when the block has no variant. */
export function toggleVariant(block: string, exists: (name: string) => boolean): string | null {
  const explicit: Record<string, string> = {
    HPB11_NO: 'HPB12_NC',
    HPB12_NC: 'HPB11_NO',
    HLS11_NO: 'HLS12_NC',
    HLS12_NC: 'HLS11_NO',
    HFT11_NO: 'HFT12_NC',
    HFT12_NC: 'HFT11_NO',
    HTS11_NO: 'HTS12_NC',
    HTS12_NC: 'HTS11_NO',
    HPS11_NO: 'HPS12_NC',
    HPS12_NC: 'HPS11_NO',
    HFS11_NO: 'HFS12_NC',
    HFS12_NC: 'HFS11_NO',
    HFL11_NO: 'HFL12_NC',
    HFL12_NC: 'HFL11_NO',
    HPX11_NO: 'HPX12_NC',
    HPX12_NC: 'HPX11_NO',
    // Extended JIC control library: numbered pilot-device pairs.
    HPB14_NO: 'HPB15_NC',
    HPB15_NC: 'HPB14_NO',
    HPB16_NO: 'HPB17_NC',
    HPB17_NC: 'HPB16_NO',
    HPB21_NC: 'HPB22_NO',
    HPB22_NO: 'HPB21_NC',
    HKS11_NO: 'HKS12_NC',
    HKS12_NC: 'HKS11_NO',
    HJS11_NO: 'HJS12_NC',
    HJS12_NC: 'HJS11_NO',
    HPE11_NO: 'HPE12_NC',
    HPE12_NC: 'HPE11_NO',
    HPE13_NO: 'HPE14_NC',
    HPE14_NC: 'HPE13_NO',
    HPX13_NO: 'HPX14_NC',
    HPX14_NC: 'HPX13_NO',
    HUS11_NO: 'HUS12_NC',
    HUS12_NC: 'HUS11_NO',
    HSPS11_NO: 'HSPS12_NC',
    HSPS12_NC: 'HSPS11_NO',
    HVS11_NO: 'HVS12_NC',
    HVS12_NC: 'HVS11_NO',
    HLV11_NO: 'HLV12_NC',
    HLV12_NC: 'HLV11_NO',
    HZS11_NO: 'HZS12_NC',
    HZS12_NC: 'HZS11_NO',
    HGS11_NC: 'HGS12_NO',
    HGS12_NO: 'HGS11_NC',
  };
  const candidate = explicit[block] ?? (block.endsWith('_NO') ? block.replace(/_NO$/, '_NC') : block.endsWith('_NC') ? block.replace(/_NC$/, '_NO') : null);
  return candidate && exists(candidate) ? candidate : null;
}
