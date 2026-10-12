/** Normal DWG saving is a Windows capability separate from the export-copy dialog. */
import type { FileBridge } from './editor';

type DwgSaveBridge = FileBridge & Required<Pick<FileBridge, 'dwgExportStatus' | 'saveDwg'>>;

export function hasDwgSave(bridge: FileBridge | null): bridge is DwgSaveBridge {
  return bridge?.platform === 'win32' && typeof bridge.dwgExportStatus === 'function' && typeof bridge.saveDwg === 'function';
}
