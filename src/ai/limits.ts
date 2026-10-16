/**
 * Every bound for the AI assistant, in one place (docs/AI-ASSISTANT.md).
 * The host-side validator in electron/ai-host.cjs mirrors these values;
 * keep the two in step — tests on both sides pin the numbers.
 */

/** Maximum selected objects carried in one snapshot. */
export const AI_MAX_OBJECTS = 200;
/** Maximum characters of any single text/attribute string in a snapshot. */
export const AI_MAX_TEXT_CHARS = 500;
/** Maximum insert attributes per object. */
export const AI_MAX_ATTRIBUTES = 32;
/** Maximum table cell texts per table object. */
export const AI_MAX_TABLE_CELLS = 64;
/** Maximum sample vertices listed for polyline-like geometry. */
export const AI_MAX_SAMPLE_POINTS = 16;
/** Maximum serialized snapshot size, UTF-8 bytes. */
export const AI_MAX_SNAPSHOT_BYTES = 64 * 1024;
/** Maximum omitted-object entries listed (the omitted count stays exact). */
export const AI_MAX_OMITTED_LISTED = 100;
/** Maximum question length the panel/controller will accept. */
export const AI_MAX_QUESTION_CHARS = 2000;
/** Maximum answer text a provider may return; longer is an error, not a truncation. */
export const AI_MAX_ANSWER_CHARS = 8000;
/** Maximum references a provider answer may carry before validation. */
export const AI_MAX_REFERENCES = 200;
/** Default per-request timeout for a provider call. */
export const AI_DEFAULT_TIMEOUT_MS = 30_000;
