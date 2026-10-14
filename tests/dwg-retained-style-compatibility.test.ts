import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { verifyDwgMetadataEquivalence as verify } from '../scripts/dwg-metadata-equivalence.mjs';

type Pair = [number, string | number];
const fixture = readFileSync(new URL('./fixtures/interchange/r2018-minsert.dxf',import.meta.url),'utf8');
function fixtureBody(type:string,id:string):Pair[] {
  const lines=fixture.trimEnd().split(/\r\n|\n/); let start=-1;
  for(let index=0;index<lines.length;index+=2) if(lines[index]?.trim()==='0' && lines[index+1]?.trim()===type && lines[index+2]?.trim()==='5' && lines[index+3]?.trim()===id) {start=index+4;break;}
  if(start<0) throw new Error('Missing actual retained style fixture');
  const output:Pair[]=[];
  for(let index=start;index<lines.length && lines[index]?.trim()!=='0';index+=2) output.push([Number(lines[index]),lines[index+1]!.trim()]);
  return output;
}
const leader=()=>fixtureBody('MLEADERSTYLE','16F'), mline=()=>fixtureBody('MLINESTYLE','15B');
const text=(pairs:Pair[])=>pairs.flat().join('\r\n')+'\r\n';
const record=(type:string,id:string,body:Pair[]):Pair[]=>[[0,type],[5,id],...body];
const change=(body:Pair[],code:number,value:string|number)=>body.map((pair):Pair=>pair[0]===code?[code,value]:pair);
const omit=(body:Pair[],code:number)=>body.filter(pair=>pair[0]!==code);
function nativeLeader(body=leader()):Pair[] {
  const values=new Map(body.map(pair=>[pair[0],pair]));
  const output:Pair[]=[];
  for(const pair of body) {
    if([341,343,271,272,273,298].includes(pair[0])) continue;
    if(pair[0]===44) output.push(values.get(341)??[341,'0']);
    if(pair[0]===94) output.push(values.get(343)??[343,'0']);
    output.push(pair);
  }
  output.push(values.get(271)!,values.get(273)!,values.get(272)!,values.get(298)!);
  return output;
}
type Options={ leader?:Pair[];mline?:Pair[];leaderType?:string; linetypes?:Pair[];styles?:Pair[];blocks?:Pair[];extraObjects?:Pair[];renumber?:boolean };
const ltype=(name:string,id='109',owner='5')=>record('LTYPE',id,[[330,owner],[100,'AcDbSymbolTableRecord'],[100,'AcDbLinetypeTableRecord'],[2,name],[70,0],[3,''],[72,65],[73,0],[40,0]]);
function drawing(options:Options={}):string {
  const result:Pair[]=[
    [0,'SECTION'],[2,'TABLES'],...record('TABLE','5',[[2,'LTYPE'],[330,'0']]),
    ...ltype('ByBlock','108'),...(options.linetypes??ltype('ByLayer')),[0,'ENDTAB'],
    ...record('TABLE','10',[[2,'STYLE'],[330,'0']]),
    ...record('STYLE','114',[[330,'10'],[100,'AcDbSymbolTableRecord'],[100,'AcDbTextStyleTableRecord'],[2,'Standard'],[70,0],[71,0],[42,.2]]),...(options.styles??[]),[0,'ENDTAB'],
    ...record('TABLE','1',[[2,'BLOCK_RECORD'],[330,'0']]),
    ...record('BLOCK_RECORD','120',[[330,'1'],[100,'AcDbSymbolTableRecord'],[100,'AcDbBlockTableRecord'],[2,'Arrow'],[70,0],[280,1],[281,0]]),
    ...record('BLOCK_RECORD','121',[[330,'1'],[100,'AcDbSymbolTableRecord'],[100,'AcDbBlockTableRecord'],[2,'Other'],[70,0],[280,1],[281,0]]),...(options.blocks??[]),[0,'ENDTAB'],[0,'ENDSEC'],
    [0,'SECTION'],[2,'OBJECTS'],
    ...record('DICTIONARY','C',[[330,'0'],[100,'AcDbDictionary'],[281,1],[3,'ACAD_MLEADERSTYLE'],[350,'16E'],[3,'ACAD_MLINESTYLE'],[350,'15A']]),
    ...record('DICTIONARY','16E',[[330,'C'],[100,'AcDbDictionary'],[281,1],[3,'Standard'],[350,'16F']]),
    ...record('DICTIONARY','15A',[[330,'C'],[100,'AcDbDictionary'],[281,1],[3,'Standard'],[350,'15B']]),
    ...record(options.leaderType??'MLEADERSTYLE','16F',options.leader??leader()),
    ...record('MLINESTYLE','15B',options.mline??mline()),...(options.extraObjects??[]),[0,'ENDSEC'],[0,'EOF'],
  ];
  if(!options.renumber) return text(result);
  const ids=new Map(['5','108','109','10','114','1','120','121','C','16E','16F','15A','15B'].map(id=>[id,(BigInt('0x'+id)+0x1000n).toString(16).toUpperCase()]));
  return text(result.map((pair):Pair=>[pair[0],(pair[0]===5 || pair[0]>=330&&pair[0]<=369 || pair[0]===1005)?ids.get(String(pair[1]))??pair[1]:pair[1]]));
}

describe('retained modern MLEADERSTYLE null slots and independent attachment scalars',()=>{
  it('checks exact real fixture body counts against the independently documented C representation',()=>{
    expect(leader()).toHaveLength(49);expect(nativeLeader()).toHaveLength(51);expect(mline()).toHaveLength(18);
    expect(()=>verify(drawing(),drawing({leader:nativeLeader(),mline:change(mline(),6,'ByLayer')}))).not.toThrow();
    expect(verify(drawing(),drawing({leader:nativeLeader(),mline:change(mline(),6,'ByLayer')}))).toMatchObject({objects:5});
  });
  it('keeps top and bottom distinct while allowing proven scalar ordering and target renumbering',()=>{
    const body=change(leader(),272,10);
    expect(()=>verify(drawing({leader:body}),drawing({leader:nativeLeader(body),renumber:true}))).not.toThrow();
    expect(()=>verify(drawing({leader:body}),drawing({leader:change(nativeLeader(body),273,10)}))).toThrow(/changed/);
  });
  it('preserves explicit nonnull block pointers through identity remapping',()=>{
    const body=leader();body.splice(body.findIndex(pair=>pair[0]===44),0,[341,'120']);body.splice(body.findIndex(pair=>pair[0]===94),0,[343,'121']);
    expect(()=>verify(drawing({leader:body}),drawing({leader:nativeLeader(body),renumber:true}))).not.toThrow();
    for(const [code,value] of [[341,'121'],[341,'0'],[343,'120'],[343,'0']] as Pair[]) expect(()=>verify(drawing({leader:body}),drawing({leader:change(nativeLeader(body),code,value)}))).toThrow(/reference changed/);
  });
  it.each([341,343])('refuses null→nonnull group%s and a wrong class on either side',code=>{
    expect(()=>verify(drawing(),drawing({leader:change(nativeLeader(),code,'120')}))).toThrow(/reference changed/);
    const bad=change(nativeLeader(),code,'114');
    expect(()=>verify(drawing({leader:bad}),drawing({leader:bad}))).toThrow(/wrong-class/);
  });
  it.each([341,343,272,273,179])('refuses identical ambiguous duplicated group%s',code=>{
    const body=[...nativeLeader(),[code,code===179?2:code>=340?'0':9] as Pair];
    expect(()=>verify(drawing({leader:body}),drawing({leader:body}))).toThrow(/duplicated/);
  });
  it.each([341,343,272])('refuses known group%s interleaved after unknown same-subclass data',code=>{
    const suffix:Pair[]=[[470,'unknown prefix'],[code,code>=340?'0':9]];
    const source=[...leader(),...suffix],target=[...nativeLeader(),...suffix];
    expect(()=>verify(drawing({leader:source}),drawing({leader:source}))).toThrow(/ambiguous interleaved/);
    expect(()=>verify(drawing({leader:target}),drawing({leader:target}))).toThrow(/ambiguous interleaved/);
    expect(()=>verify(drawing({leader:source}),drawing({leader:target}))).toThrow(/ambiguous interleaved/);
  });
  it.each(['nothex','-1','10000000000000000'])('refuses malformed optional pointer %s',value=>{
    const body=change(nativeLeader(),341,value);
    expect(()=>verify(drawing({leader:body}),drawing({leader:body}))).toThrow(/hexadecimal handle/);
  });
  it('rejects incomplete/version/framing changes without waiving 340/342 or flags',()=>{
    for(const body of [omit(nativeLeader(),272),[[100,'AcDbMLeaderStyle'] as Pair,...nativeLeader()]]) expect(()=>verify(drawing({leader:body}),drawing({leader:body}))).toThrow(/framing/);
    for(const [code,value] of [[179,1],[340,'109'],[342,'120'],[298,1],[296,1],[300,'changed text']] as Pair[]) expect(()=>verify(drawing(),drawing({leader:change(nativeLeader(),code,value)}))).toThrow(/changed|wrong-class/);
  });
  it('keeps legacy/partial records exactly raw and refuses incomplete claimed version2',()=>{
    const partial:Pair[]=[[330,'16E'],[100,'AcDbMLeaderStyle'],[46,4],[293,1],[294,1],[340,'108']];
    expect(()=>verify(drawing({leader:partial}),drawing({leader:partial}))).not.toThrow();
    expect(()=>verify(drawing({leader:partial}),drawing({leader:[...partial,[341,0]]}))).toThrow(/count changed/);
    expect(()=>verify(drawing({leader:partial}),drawing({leader:omit(partial,46)}))).toThrow(/count changed/);
    const claimed=[...partial,[179,2] as Pair];expect(()=>verify(drawing({leader:claimed}),drawing({leader:claimed}))).toThrow(/incomplete/);
    const legacy=change(leader(),179,1);expect(()=>verify(drawing({leader:legacy}),drawing({leader:legacy}))).not.toThrow();
    expect(()=>verify(drawing({leader:legacy}),drawing({leader:nativeLeader(legacy)}))).toThrow(/count changed/);
    const legacySuffix=[...legacy,[470,'raw legacy'] as Pair,[341,0] as Pair];expect(()=>verify(drawing({leader:legacySuffix}),drawing({leader:legacySuffix}))).not.toThrow();
    const xdata=[...partial,[1001,'APP'] as Pair,[179,2] as Pair];expect(()=>verify(drawing({leader:xdata}),drawing({leader:xdata}))).not.toThrow();
    const opaque:Pair[]=[[1001,'APP'],[100,'AcDbMLeaderStyle'],[179,2],[341,0],[1000,'opaque']];
    expect(()=>verify(drawing({leader:[...leader(),...opaque]}),drawing({leader:[...nativeLeader(),...opaque]}))).not.toThrow();
  });
  it('retains common reactors/owner, extension links, XDATA and unknown suffix exactly',()=>{
    const suffix:Pair[]=[[470,'opaque first'],[471,'opaque second'],[1001,'APP'],[1000,'BYLAYER'],[1005,'109']];
    const source=[...leader(),...suffix],target=[...nativeLeader(),...suffix];
    expect(()=>verify(drawing({leader:source}),drawing({leader:target,renumber:true}))).not.toThrow();
    for(const body of [change(target,330,'15A'),change(target,470,'changed'),change(target,1000,'ByLayer'),change(target,1005,'108'),[...target.slice(0,-suffix.length),...suffix.slice().reverse()]]) expect(()=>verify(drawing({leader:source}),drawing({leader:body}))).toThrow();
    const extension:Pair[]=[[102,'{ACAD_XDICTIONARY'],[360,'130'],[102,'}']];
    const extra=record('DICTIONARY','130',[[330,'16F'],[100,'AcDbDictionary'],[281,1]]);
    const withExtension=(body:Pair[])=>[...body.slice(0,4),...extension,...body.slice(4)];
    expect(()=>verify(drawing({leader:withExtension(leader()),extraObjects:extra}),drawing({leader:withExtension(nativeLeader()),extraObjects:extra}))).not.toThrow();
    expect(()=>verify(drawing({leader:withExtension(leader()),extraObjects:extra}),drawing({leader:nativeLeader(),extraObjects:extra}))).toThrow(/count changed/);
  });
  it('keeps null additions opaque in other OBJECTS classes',()=>{
    expect(()=>verify(drawing({leaderType:'CUSTOM_STYLE'}),drawing({leaderType:'CUSTOM_STYLE',leader:nativeLeader()}))).toThrow(/count changed/);
  });
});

describe('MLINESTYLE ordered elements select actual retained LTYPE identities',()=>{
  it('keeps uncounted raw records opaque and does not use XDATA71 as a typed declaration',()=>{
    const body=omit(mline(),71);expect(()=>verify(drawing({mline:body}),drawing({mline:body}))).not.toThrow();
    expect(()=>verify(drawing({mline:body}),drawing({mline:change(body,6,'ByLayer')}))).toThrow(/group6.*changed/);
    const xdata=[...body,[1001,'APP'] as Pair,[71,2] as Pair];expect(()=>verify(drawing({mline:xdata}),drawing({mline:xdata}))).not.toThrow();
  });
  it('resolves case variants and renumbered custom target records without rewriting style-name2',()=>{
    const a=change(mline(),6,'DaSh'),b=change(mline(),6,'DASH');
    expect(()=>verify(drawing({mline:a,linetypes:ltype('Dash')}),drawing({mline:b,linetypes:ltype('dAsH'),renumber:true}))).not.toThrow();
    expect(()=>verify(drawing(),drawing({mline:change(mline(),2,'Standard')}))).toThrow(/group2.*changed/);
  });
  it('never defaults an unresolved reference or compares names without target identity',()=>{
    for(const options of [{mline:change(mline(),6,'MISSING')},{linetypes:[]},{linetypes:ltype('ByLayer','109','10')},{linetypes:record('STYLE','109',[[330,'5'],[100,'AcDbSymbolTableRecord'],[2,'ByLayer'],[70,0]])}]) {
      const body=drawing(options);expect(()=>verify(body,body)).toThrow(/LTYPE|ambiguous/);
    }
    expect(()=>verify(drawing(),drawing({mline:change(mline(),6,'ByBlock')}))).toThrow(/LTYPE reference changed/);
    expect(()=>verify(drawing(),drawing({linetypes:[...ltype('ByLayer'),...ltype('BYLAYER','110')]}))).toThrow(/ambiguous/);
  });
  it('permits exact Unicode names but refuses unproven Unicode folding and whitespace changes',()=>{
    const body=change(mline(),6,'ΔASH');
    expect(()=>verify(drawing({mline:body,linetypes:ltype('ΔASH')}),drawing({mline:body,linetypes:ltype('ΔASH'),renumber:true}))).not.toThrow();
    expect(()=>verify(drawing({mline:change(mline(),6,'Δash'),linetypes:ltype('ΔASH')}),drawing({mline:change(mline(),6,'Δash'),linetypes:ltype('ΔASH')}))).toThrow(/LTYPE target/);
    expect(()=>verify(drawing(),drawing({mline:change(mline(),6,' ByLayer')}))).toThrow(/LTYPE target/);
  });
  it.each([-1,256,'1.5','NaN',1,3])('refuses malformed or incorrect declared element count%s even if identical',count=>{
    const body=drawing({mline:change(mline(),71,count)});expect(()=>verify(body,body)).toThrow(/integer storage|element count|excess/);
  });
  it('refuses extra/missing/reordered elements and scalar/property mutations',()=>{
    const before=mline(),elementStart=before.findIndex(pair=>pair[0]===49);
    const reordered=[...before.slice(0,elementStart),...before.slice(elementStart+3),...before.slice(elementStart,elementStart+3)];
    for(const body of [omit(before,6),[...before,[49,1] as Pair,[62,256] as Pair,[6,'ByLayer'] as Pair],change(before,49,1),change(before,62,0),reordered]) expect(()=>verify(drawing(),drawing({mline:body}))).toThrow(/framing|count|changed/);
    const duplicate=[...before,[71,2] as Pair];expect(()=>verify(drawing({mline:duplicate}),drawing({mline:duplicate}))).toThrow(/excess/);
  });
  it('keeps suffix/XDATA linetype-looking text opaque and common links exact',()=>{
    const suffix:Pair[]=[[470,'opaque'],[6,'BYLAYER'],[1001,'APP'],[1000,'BYLAYER'],[6,'BYLAYER']];
    const a=[...mline(),...suffix],b=[...change(mline(),6,'ByLayer'),...suffix];
    expect(()=>verify(drawing({mline:a}),drawing({mline:b}))).not.toThrow();
    for(const body of [change(b,470,'other'),change(b,6,'ByLayer'),change(b,1000,'ByLayer'),change(b,330,'16E')]) expect(()=>verify(drawing({mline:a}),drawing({mline:body}))).toThrow();
  });
});
