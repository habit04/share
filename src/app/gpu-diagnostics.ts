import { redactLocalPaths } from './diagnostics';

export interface GpuDiagnostics {
  state: 'ready' | 'pending' | 'unavailable';
  adapters: Array<{ name: string; vendorId: string; deviceId: string; active: boolean | null; driverVendor: string; driverVersion: string }>;
  hardwareAcceleration: boolean | null;
  driver?: { vendor: string; version: string };
  features: Record<string, string>;
  fallback: string;
  reasons: string[];
  versions: { jcad: string; electron: string; chromium: string; windows: string };
}

export interface GpuDiagnosticsBridge {
  gpuDiagnostics?(): Promise<GpuDiagnostics>;
}

export function emptyGpuDiagnostics(state: GpuDiagnostics['state'] = 'pending', jcad = ''): GpuDiagnostics {
  return { state, adapters: [], hardwareAcceleration: null, features: {}, fallback: '', reasons: [], versions: { jcad, electron: '', chromium: '', windows: '' } };
}

/** Only the summary schema is formatted; raw GPU info and unexpected properties are never copied. */
export function gpuDiagnosticsLines(d: GpuDiagnostics): string[] {
  const value = (s: unknown): string => typeof s === 'string' && s.trim() ? redactLocalPaths(s).replace(/[\r\n\t]+/g, ' ').slice(0, 240) : 'Unknown';
  const flag = (b: unknown): string => b === true ? 'Yes' : b === false ? 'No' : 'Unknown';
  const features = ['2d_canvas', 'gpu_compositing', 'rasterization', 'opengl', 'webgl', 'webgl2', 'webgpu', 'video_decode', 'video_encode', 'vulkan'];
  return [
    'GPU diagnostics',
    `Status: ${d.state === 'ready' ? 'Ready' : d.state === 'pending' ? 'Pending (retry available)' : 'Unavailable'}`,
    'JCad renderer: Canvas 2D',
    'Chromium capabilities below do not establish which GPU JCad uses.',
    `Chromium hardware acceleration enabled: ${flag(d.hardwareAcceleration)}`,
    ...(d.driver ? [`Chromium driver: ${value(d.driver.vendor)} ${value(d.driver.version)}`] : []),
    ...(d.adapters.length ? d.adapters.slice(0, 8).map((a, i) => `Adapter ${i + 1}: ${value(a.name)}; vendor/device: ${value(a.vendorId)}/${value(a.deviceId)}; active (Chromium): ${flag(a.active)}; driver: ${value(a.driverVendor)} ${value(a.driverVersion)}`) : ['Adapters: Unknown']),
    `Chromium features: ${features.filter((k) => Object.hasOwn(d.features, k)).map((k) => `${k}=${value(d.features[k])}`).join('; ') || 'Unknown'}`,
    `Canvas rendering (Chromium): ${value(d.features['2d_canvas'])}`,
    `Compositing (Chromium): ${value(d.features['gpu_compositing'])}`,
    `Fallback: ${value(d.fallback)}`,
    `Reasons: ${d.reasons.slice(0, 8).map(value).join('; ') || 'Unknown'}`,
    `Versions: JCad ${value(d.versions.jcad)}; Electron ${value(d.versions.electron)}; Chromium ${value(d.versions.chromium)}; Windows ${value(d.versions.windows)}`,
  ];
}

/** Collect only when a dialog asks; a stalled IPC cannot block the dialog or startup. */
// The collector has a 5s deadline and at most one 5s follow-up. Allow its bounded
// partial result through before applying the renderer's last-resort deadline.
export async function collectGpuDiagnostics(bridge?: GpuDiagnosticsBridge, jcad = '', timeoutMs = 12000): Promise<GpuDiagnostics> {
  if (!bridge?.gpuDiagnostics) return emptyGpuDiagnostics('unavailable', jcad);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => bridge.gpuDiagnostics!()),
      new Promise<GpuDiagnostics>((resolve) => { timer = setTimeout(() => resolve(emptyGpuDiagnostics('pending', jcad)), timeoutMs); }),
    ]);
    // Validate before consumers format data from an older or incompatible bridge.
    const plainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
    if (!result || !['ready', 'pending', 'unavailable'].includes(result.state) || !Array.isArray(result.adapters) || !plainObject(result.features) || !Array.isArray(result.reasons) || !plainObject(result.versions) || (result.driver !== undefined && !plainObject(result.driver)) || result.adapters.some((a) => !plainObject(a))) return emptyGpuDiagnostics('unavailable', jcad);
    return result;
  } catch {
    return emptyGpuDiagnostics('unavailable', jcad);
  } finally {
    clearTimeout(timer);
  }
}
