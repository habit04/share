import { describe, expect, it } from 'vitest';
import type { LineEntity } from '../src/core/entities';
import { Writer, writeEntityCommon } from '../src/io/dxf/write-core';

/**
 * The composed writeEntityCommon extension-dictionary emission (P18 rebase
 * onto the P22 PR-fix head, lead ruling): two mechanisms can name an
 * entity's extension dictionary — the explicit `extensionDictionary`
 * parameter (P22 F-2, the native AC1015 table roundtrip chain) and the
 * Writer's mleaderContextChains map (P18 S3-D, Amendment 2 (v)). The
 * parameter is consulted first, the map second; the entity kinds are
 * disjoint (ACAD_TABLE vs MULTILEADER), so both set for one entity is a
 * programming error and must throw. Each single-mechanism case emits the
 * exact pair sequence its lane emitted before the composition.
 */
const line = (id: string): LineEntity => ({
  id, cadIdentity: `src:${id}`, type: 'line', layer: '0', color: 'ByLayer',
  a: { x: 1, y: 2 }, b: { x: 4, y: 2 },
});

const CHAIN = { extension: '2B', manager: '2C', scales: '2D', objects: ['2E'] };

describe('writeEntityCommon extension-dictionary composition', () => {
  it('throws when BOTH the explicit parameter and the mleader context chain name one entity', () => {
    const entity = line('both'), writer = new Writer();
    writer.mleaderContextChains.set(entity, CHAIN);
    expect(() => writeEntityCommon(writer, entity, '1F', 'LINE', 'AcDbLine', '1F', '2A'))
      .toThrow("only one mechanism may name an entity's extension dictionary");
  });

  it('parameter only (the P22 table mechanism) emits the 102 block with the parameter handle', () => {
    const entity = line('param'), writer = new Writer();
    writeEntityCommon(writer, entity, '1F', 'LINE', 'AcDbLine', '1F', '2A');
    expect(writer.toString()).toBe(
      '0\r\nLINE\r\n5\r\n101\r\n' +
      '102\r\n{ACAD_XDICTIONARY\r\n360\r\n2A\r\n102\r\n}\r\n' +
      '330\r\n1F\r\n100\r\nAcDbEntity\r\n8\r\n0\r\n100\r\nAcDbLine\r\n',
    );
  });

  it('map only (the P18 mleader mechanism) emits the 102 block with the chain extension handle', () => {
    const entity = line('map'), writer = new Writer();
    writer.mleaderContextChains.set(entity, CHAIN);
    writeEntityCommon(writer, entity, '1F', 'LINE', 'AcDbLine');
    expect(writer.toString()).toBe(
      '0\r\nLINE\r\n5\r\n101\r\n' +
      '102\r\n{ACAD_XDICTIONARY\r\n360\r\n2B\r\n102\r\n}\r\n' +
      '330\r\n1F\r\n100\r\nAcDbEntity\r\n8\r\n0\r\n100\r\nAcDbLine\r\n',
    );
  });

  it('neither mechanism emits no extension-dictionary block', () => {
    const entity = line('none'), writer = new Writer();
    writeEntityCommon(writer, entity, '1F', 'LINE', 'AcDbLine');
    expect(writer.toString()).toBe(
      '0\r\nLINE\r\n5\r\n101\r\n' +
      '330\r\n1F\r\n100\r\nAcDbEntity\r\n8\r\n0\r\n100\r\nAcDbLine\r\n',
    );
  });
});
