/** Check browser file metadata before allocating its contents. */
export const MAX_DRAWING_FILE_BYTES = 128 * 1024 * 1024;
export const MAX_PROJECT_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_PLUGIN_FILE_BYTES = 2 * 1024 * 1024;
export function ensureFileLimit(file: Pick<File, 'name' | 'size'>, maximum: number): void {
  if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > maximum) {
    throw new Error(`"${file.name}" exceeds the ${Math.round(maximum / (1024 * 1024))} MiB file limit.`);
  }
}
