// PRIVATE CPU compiler regressions. Recorded Canvas commands/GL buffers are mock-only; native raster remains required.
import { afterEach,describe,expect,it,vi } from 'vitest';
import { Drawing,type DrawingState } from '../src/core/document';
import { STANDARD_DIMSTYLE,type DimensionEntity } from '../src/core/dimension';
import type { Entity, LineEntity } from '../src/core/entities';
import * as entities from '../src/core/entities';
import * as dimensions from '../src/core/dimension';
import { sealImmutableData } from '../src/core/immutable-data';
import { readDxf,writeDxf } from '../src/io/dxf';
import { colorDisplay,drawEntity,lineweightDisplay } from '../src/render/draw';
import type { DimensionStrokeOptions } from '../src/render/gpu-prototype/dimension-strokes';
import { lowerStrokeScene } from '../src/render/gpu-prototype/stroke-scene';
import * as geometry from '../src/render/gpu-prototype/geometry2d';
import type {Gpu2DView,PreparedZoom2D} from '../src/render/gpu-prototype/geometry2d';
import { Gpu2DRenderer } from '../src/render/gpu-prototype/renderer2d';
import {preflightDimensionPreparation} from '../src/render/gpu-prototype/dimension-budget';
import {certifyTriangleAreaEnvelope} from '../src/render/gpu-prototype/dimension-triangle-area';
const zero={x:0,y:0},view:Gpu2DView={width:800,height:600,dpr:1,scale:20,center:zero,twist:0,background:'#212830',lineweights:false},overlay={selection:new Set<string>()};
const layer={name:'0',color:7,visible:true,locked:false,lineWeight:0.25};
const options:DimensionStrokeOptions={anchor:zero,widthCss:1,alpha:1};
const dimension=(patch:Partial<DimensionEntity>={}):DimensionEntity=>({id:'D',type:'dimension',kind:'linear',layer:'0',color:3,p1:zero,p2:{x:8,y:1},linePoint:{x:4,y:4},rotation:0,style:{...STANDARD_DIMSTYLE,arrowSize:0.3,textHeight:0.25,textGap:0.05},...patch});
const drawing=(source:DimensionEntity):DrawingState=>scene([source]);
const scene=(items:readonly Entity[]):DrawingState=>sealImmutableData({entities:items,blocks:{},layers:[layer],currentLayer:'0'});
const line=(id:string,a:number,b:number):LineEntity=>({id,type:'line',layer:'0',color:7,a:{x:a,y:-0.5},b:{x:b,y:-0.5}});
const certified=(state:DrawingState,camera=view)=>geometry.prepareZoom2D(state,camera,overlay,undefined,undefined,undefined,{certifyStraightZoomIn:true});
function slot(p:PreparedZoom2D,i:number){const s=p.entities?.[i];if(!s)throw new Error('Missing owner');return s;}
function rendererFixture() {
  let vertices = new Float32Array(0), serial = 0;
  const handle = () => ({ serial: ++serial });
  const gl = {
    VERTEX_SHADER: 0x8b31, FRAGMENT_SHADER: 0x8b30, COMPILE_STATUS: 0x8b81, LINK_STATUS: 0x8b82,
    ARRAY_BUFFER: 0x8892, ARRAY_BUFFER_BINDING: 0x8894, STATIC_DRAW: 0x88e4, DYNAMIC_DRAW: 0x88e8,
    MAX_VIEWPORT_DIMS: 0xd3a, NO_ERROR: 0, OUT_OF_MEMORY: 0x505,
    FRAMEBUFFER: 0x8d40, FLOAT: 0x1406, TRIANGLES: 4, DEPTH_TEST: 0xb71, CULL_FACE: 0xb44,
    SCISSOR_TEST: 0xc11, RASTERIZER_DISCARD: 0x8c89, STENCIL_TEST: 0xb90, BLEND: 0xbe2,
    COLOR_BUFFER_BIT: 0x4000, STENCIL_BUFFER_BIT: 0x400, FUNC_ADD: 0x8006,
    SRC_ALPHA: 0x302, ONE_MINUS_SRC_ALPHA: 0x303, ONE: 1, EQUAL: 0x202, KEEP: 0x1e00, INCR: 0x1e02,
    isContextLost: vi.fn(() => false), createShader: vi.fn(handle), shaderSource: vi.fn(), compileShader: vi.fn(),
    getShaderParameter: vi.fn(() => true), getShaderInfoLog: vi.fn(() => 'invalid shader'),
    createProgram: vi.fn(handle), attachShader: vi.fn(), detachShader: vi.fn(), linkProgram: vi.fn(),
    getProgramParameter: vi.fn(() => true), getProgramInfoLog: vi.fn(() => 'invalid link'), deleteShader: vi.fn(), deleteProgram: vi.fn(),
    createBuffer: vi.fn(handle), bindBuffer: vi.fn(), deleteBuffer: vi.fn(),
    bufferData: vi.fn((_target: number, data: BufferSource, _usage: number) => { vertices = (data as Float32Array<ArrayBuffer>).slice(); }),
    bufferSubData: vi.fn((_target: number, byteOffset: number, data: Float32Array<ArrayBuffer>) => { vertices.set(data, byteOffset / Float32Array.BYTES_PER_ELEMENT); }),
    get vertices(): Float32Array<ArrayBuffer> { return vertices; },
    getParameter: vi.fn((parameter: number) => parameter === 0xd3a ? new Int32Array([16384, 16384]) : null),
    getError: vi.fn(() => 0), getContextAttributes: vi.fn(() => ({ stencil: true })),
    getUniformLocation: vi.fn((_program: unknown, name: string) => ({ name })),
    bindFramebuffer: vi.fn(), bindVertexArray: vi.fn(), useProgram: vi.fn(), enableVertexAttribArray: vi.fn(), vertexAttribPointer: vi.fn(), uniform2f: vi.fn(), uniform1f: vi.fn(),
    viewport: vi.fn(), enable: vi.fn(), disable: vi.fn(), colorMask: vi.fn(), depthMask: vi.fn(), stencilMask: vi.fn(), clearColor: vi.fn(), clearStencil: vi.fn(), clear: vi.fn(),
    blendEquation: vi.fn(), blendFuncSeparate: vi.fn(), stencilFunc: vi.fn(), stencilOp: vi.fn(), drawArrays: vi.fn(),
    get drawingBufferWidth(): number { return canvas.width; }, get drawingBufferHeight(): number { return canvas.height; },
  };
  const canvas = Object.assign(new EventTarget(), { getContext: vi.fn(() => gl as unknown as WebGL2RenderingContext), width: 1, height: 1 }) as unknown as HTMLCanvasElement;
  return { gl, renderer: new Gpu2DRenderer(canvas) };
}

type CanvasPaint = { kind: 'stroke' | 'fill'; colorCss: string; alpha: number; widthCss: number; commands: readonly unknown[] };

/** Record the source Canvas painter's actual paint order, inherited width, colors and alpha. */
function canvasPaints(entity: DimensionEntity, state: DrawingState, config: DimensionStrokeOptions = options): CanvasPaint[] {
  const output: CanvasPaint[] = [];
  const scale = 20;
  let commands: unknown[] = [];
  const stack: Array<{ globalAlpha: number; lineWidth: number; strokeStyle: string; fillStyle: string }> = [];
  const context = {
    globalAlpha: 1, lineWidth: 1, strokeStyle: '', fillStyle: '', lineCap: 'butt', lineJoin: 'miter',
    save() { stack.push({ globalAlpha: this.globalAlpha, lineWidth: this.lineWidth, strokeStyle: this.strokeStyle, fillStyle: this.fillStyle }); },
    restore() { Object.assign(this, stack.pop()!); },
    setLineDash() {},
    beginPath() { commands = []; },
    moveTo(x: number, y: number) { commands.push(['M', x / scale, -y / scale]); },
    lineTo(x: number, y: number) { commands.push(['L', x / scale, -y / scale]); },
    closePath() { commands.push(['Z']); },
    arc(x: number, y: number, radius: number, start: number, end: number, reverse = false) { commands.push(['A', x / scale, -y / scale, radius / scale, start, end, reverse]); },
    stroke() { output.push({ kind: 'stroke', colorCss: this.strokeStyle, alpha: this.globalAlpha, widthCss: this.lineWidth, commands }); },
    fill() { output.push({ kind: 'fill', colorCss: this.fillStyle, alpha: this.globalAlpha, widthCss: this.lineWidth, commands }); },
  };
  drawEntity(context as unknown as CanvasRenderingContext2D, entity, {
    scale, toScreen: (point) => ({ x: (point.x - config.anchor.x) * scale, y: -(point.y - config.anchor.y) * scale }),
  }, state.layers, () => undefined, {
    lineWidthOverride: config.widthCss, alpha: config.alpha,
    ...(config.strokeOverride !== undefined ? { strokeOverride: config.strokeOverride } : {}),
  });
  return output;
}


afterEach(()=>{vi.restoreAllMocks();colorDisplay.paper=false;lineweightDisplay.enabled=false;lineweightDisplay.pxPerMm=undefined;});
describe('private certified DIM compiler',()=>{
 it.each(['linear','aligned','radius','diameter','angular'] as const)('emits certified %s fills with zero extrusion and original owner',kind=>{
  const d=dimension({kind,...(kind==='angular'?{center:zero,p1:{x:5,y:0},p2:{x:0,y:5},linePoint:{x:9,y:9}}:{})}),state=drawing(d),before=JSON.stringify(state),lowered=lowerStrokeScene(state,view,overlay);
  if(!lowered.ok)throw lowered.cause;const prepared=certified(state);expect(prepared.vertices.length).toBeGreaterThan(0);
  const fills=lowered.operations.filter(p=>p.kind==='fillTriangle');expect(fills.length).toBeGreaterThan(0);expect(slot(prepared,0).editableLine).toBe(false);
  for(const fill of fills){const batch=prepared.batches.find(b=>b.id===fill.paintId)!;expect(batch.count).toBe(3);for(let i=0;i<3;i++){const start=(batch.first+i)*geometry.GPU_ZOOM_VERTEX_STRIDE;expect([...prepared.vertices.slice(start+2,start+4)]).toEqual([0,0]);}expect(fill.originalWorldPoints).toEqual((fill.dimensionSource.originalWorldParts[fill.partIndex] as entities.PolylineEntity).points);}
  expect(lowered.operations.every(p=>p.ownerId==='D')).toBe(true);expect(JSON.stringify(state)).toBe(before);
 });
  it('rejects equal-looking fill vertices without the original source point identities', () => {
    const lowered = lowerStrokeScene(drawing(dimension()), view, overlay);
    if (!lowered.ok) throw lowered.cause;
    const fill = lowered.operations.find(operation => operation.kind === 'fillTriangle');
    if (!fill || fill.kind !== 'fillTriangle') throw new Error('Missing certified fill');
    const extent = { x: 1_000, y: 1_000 };
    expect(geometry.compiledStraightVertexLowerBound([fill], view, extent)).toBe(3);
    const changedLocal = { ...fill, points: fill.points.map(point => ({ ...point })) as [typeof zero, typeof zero, typeof zero] };
    const changedWorld = { ...fill, originalWorldPoints: fill.originalWorldPoints.map(point => ({ ...point })) as [typeof zero, typeof zero, typeof zero] };
    expect(() => geometry.compiledStraightVertexLowerBound([changedLocal], view, extent)).toThrow('fill certificate mismatch');
    expect(() => geometry.compiledStraightVertexLowerBound([changedWorld], view, extent)).toThrow('fill certificate mismatch');
  });

 it('preserves actual canonical Canvas parent trueColor for same-ACI roles',()=>{
  const d=dimension({trueColor:0x123456,style:{...STANDARD_DIMSTYLE,arrowSize:0.3,textHeight:0.25,textGap:0.05,dimLineColor:3,extLineColor:1,textColor:3}}),state=drawing(d),paint=canvasPaints(d,state),lowered=lowerStrokeScene(state,view,overlay);
  if(!lowered.ok)throw lowered.cause;expect(lowered.operations.map(p=>({kind:p.kind==='fillTriangle'?'fill':'stroke',colorCss:'#'+p.color.map(v=>Math.round(v*255).toString(16).padStart(2,'0')).join(''),alpha:p.alpha,widthCss:p.widthCss}))).toEqual(paint.map(({kind,colorCss,alpha,widthCss})=>({kind,colorCss,alpha,widthCss})));
  expect(paint.some(p=>p.colorCss==='#123456')).toBe(true);expect(paint.some(p=>p.colorCss==='#ff0000')).toBe(true);
 });

  it.each([
    ['unknown key', { style: { ...STANDARD_DIMSTYLE, unexpected: 1 } }, 'unknown style key'],
    ['oversized key', { style: { ...STANDARD_DIMSTYLE, ['X'.repeat(65)]: 1 } }, 'style key budget'],
    ['oversized string', { style: { ...STANDARD_DIMSTYLE, name: 'X'.repeat(16_385) } }, 'style string budget'],
    ['nested known value', { style: { ...STANDARD_DIMSTYLE, scale: { nested: 1 } } }, 'style numeric value'],
    ['unknown override', { styleOverrides: { UNKNOWN: 1 } }, 'unknown style override'],
    ['nested override', { styleOverrides: { DIMASZ: { nested: 1 } } }, 'style override value'],
  ] as const)('refuses %s before canonical resolver/layout', (_name, patch, reason) => {
    const source = dimension(patch as unknown as Partial<DimensionEntity>);
    const state = drawing(source);
    const resolver = vi.spyOn(dimensions, 'resolveDimStyle');
    const parts = vi.spyOn(entities, 'dimensionParts');
    expect(lowerStrokeScene(state, view, overlay)).toMatchObject({
      ok: false, reason: expect.stringContaining(reason),
    });
    expect(resolver).not.toHaveBeenCalled();
    expect(parts).not.toHaveBeenCalled();
    expect(state.entities[0]).toBe(source);
  });

  it('inspects known nonenumerable direct arrow values without invoking getters', () => {
    const resolver = vi.spyOn(dimensions, 'resolveDimStyle');
    const parts = vi.spyOn(entities, 'dimensionParts');
    const getter = vi.fn(() => 'closed-filled');
    const accessorStyle = { ...STANDARD_DIMSTYLE };
    Object.defineProperty(accessorStyle, 'arrow2', { enumerable: false, get: getter });
    expect(() => preflightDimensionPreparation(
      dimension({ style: accessorStyle }), 10_000, 10_000, 10_000,
    )).toThrow('style accessor');
    expect(getter).not.toHaveBeenCalled();

    const nestedStyle = { ...STANDARD_DIMSTYLE };
    Object.defineProperty(nestedStyle, 'arrow2', { enumerable: false, value: { nested: 1 } });
    expect(() => preflightDimensionPreparation(
      dimension({ style: nestedStyle }), 10_000, 10_000, 10_000,
    )).toThrow('style string value');
    expect(resolver).not.toHaveBeenCalled();
    expect(parts).not.toHaveBeenCalled();
  });

  it('charges fixed and enumerable style inspection against remaining work before layout', () => {
    const source = dimension();
    const bounded = preflightDimensionPreparation(source, 10_000, 10_000, 10_000);
    expect(bounded.inspectedStyleKeys).toBeGreaterThan(49);
    expect(bounded.inspectedStyleCharacters).toBeGreaterThan(STANDARD_DIMSTYLE.name.length);
    const state = drawing(source);
    const resolver = vi.spyOn(dimensions, 'resolveDimStyle');
    const parts = vi.spyOn(entities, 'dimensionParts');
    expect(lowerStrokeScene(state, view, overlay, { maxWork: bounded.work - 1 }).ok).toBe(false);
    expect(resolver).not.toHaveBeenCalled();
    expect(parts).not.toHaveBeenCalled();
  });

 it('rejects amplified templates before canonical layout allocation',()=>{
  const d=dimension({text:'<>'.repeat(100),style:{...STANDARD_DIMSTYLE,post:'<>'.repeat(100)}}),state=drawing(d),spy=vi.spyOn(entities,'dimensionParts');
  expect(lowerStrokeScene(state,view,overlay)).toMatchObject({ok:false,reason:expect.stringContaining('amplification')});expect(spy).not.toHaveBeenCalled();
 });
 it('preflights point/work/paint limits before canonical layout',()=>{
  const d=dimension(),state=drawing(d),spy=vi.spyOn(entities,'dimensionParts');for(const limits of [{maxPoints:388},{maxWork:1},{maxEntities:15}])expect(lowerStrokeScene(state,view,overlay,limits).ok).toBe(false);expect(spy).not.toHaveBeenCalled();
  expect(preflightDimensionPreparation(d,10000,10000,10000).partBound).toBe(16);
 });
 it.each([0.17,0.37,0.63])('retains old twist %s as whole Canvas and zero GL',twist=>{
  const {renderer,gl}=rendererFixture();try{expect(renderer.render(drawing(dimension()),{...view,twist},overlay).rendered).toBe(false);expect(gl.bufferData).not.toHaveBeenCalled();expect(gl.drawArrays).not.toHaveBeenCalled();}finally{renderer.dispose();}
 });
 it('keeps unproved filled retention/selection on Canvas',()=>{
  const far=dimension({p1:{x:1000,y:0},p2:{x:1008,y:1},linePoint:{x:1004,y:4}}),{renderer,gl}=rendererFixture();try{expect(renderer.render(drawing(far),view,overlay).rendered).toBe(false);expect(gl.bufferData).not.toHaveBeenCalled();expect(gl.drawArrays).not.toHaveBeenCalled();expect(lowerStrokeScene(drawing(dimension()),view,{selection:new Set(['D']),solidSelection:true})).toMatchObject({ok:false,reason:expect.stringContaining('highlight')});}finally{renderer.dispose();}
 });
 it('retains DIM owner bounds and neighboring 168-byte LINE edit/undo/redo',()=>{
  const doc=new Drawing(scene([line('L',-10,-8),dimension(),line('R',9,11)])),before=doc.snapshot,prep=vi.spyOn(geometry,'prepareZoom2D'),{renderer,gl}=rendererFixture();
  try{expect(renderer.render(before,view,overlay)).toMatchObject({rendered:true,uploadKind:'full'});const prepared=prep.mock.results[0]!.value as PreparedZoom2D,bounds=structuredClone(slot(prepared,1).sourceBounds),batches=structuredClone(prepared.batches),original=gl.vertices.slice();
   const target=doc.entities[0] as LineEntity;doc.replaceEntities([{...target,a:{...target.a,y:target.a.y+0.1},b:{...target.b,y:target.b.y+0.1}}]);const after=doc.snapshot;
   for(const action of ['edit','undo','redo'] as const){if(action==='undo')expect(doc.undo()).toBe(true);if(action==='redo')expect(doc.redo()).toBe(true);expect(renderer.render(doc.snapshot,view,overlay)).toMatchObject({rendered:true,uploadKind:'subrange',bytes:168,uploadCalls:1,editMemoHit:action!=='edit'});expect(slot(prepared,1).sourceBounds).toEqual(bounds);expect(prepared.batches).toEqual(batches);const fresh=certified(doc.snapshot);expect(gl.vertices).toEqual(fresh.vertices);expect(prepared.sourceBounds).toEqual(fresh.sourceBounds);if(action==='undo')expect(gl.vertices).toEqual(original);}
   expect(doc.snapshot).toBe(after);expect(gl.bufferData).toHaveBeenCalledOnce();expect(gl.bufferSubData).toHaveBeenCalledTimes(3);
  }finally{renderer.dispose();}
 });
 it('forces full geometry on a real DIM style edit and preserves undo',()=>{
  const doc=new Drawing(scene([line('L',-10,-8),dimension()])),{renderer}=rendererFixture();try{expect(renderer.render(doc.snapshot,view,overlay).rendered).toBe(true);const d=doc.entities[1] as DimensionEntity;doc.replaceEntities([{...d,style:{...d.style,dimLineColor:1}}]);expect(renderer.render(doc.snapshot,view,overlay)).toMatchObject({rendered:true,uploadKind:'full',cacheReason:'document'});expect(doc.undo()).toBe(true);expect(renderer.render(doc.snapshot,view,overlay).uploadKind).toBe('full');}finally{renderer.dispose();}
 });
 it('reopens an authored edited DXF without dropping native dimension data',()=>{
  const d=dimension({text:'EDITED <>'}),state=drawing(d),parsed=readDxf(writeDxf(state)),fresh=sealImmutableData(parsed);expect(fresh.entities.map(e=>e.type)).toEqual(['dimension']);expect(certified(fresh).vertices.length).toBeGreaterThan(0);const source=fresh.entities[0] as DimensionEntity;expect(source.text).toBe(d.text);expect(source.p1).toEqual(d.p1);expect(source.p2).toEqual(d.p2);
 });
 it('uses strict final area sign/margin independently of the native assertion',()=>{
  const p:[{x:number;y:number},{x:number;y:number},{x:number;y:number}]=[{x:0,y:0},{x:1,y:0},{x:0,y:1}];expect(certifyTriangleAreaEnvelope(p,0.001,0.8).minimumAreaMarginCssSquared).toBeGreaterThan(0);expect(()=>certifyTriangleAreaEnvelope([{x:0,y:0},{x:1,y:0},{x:2,y:0}],0,1)).toThrow();
 });
});
