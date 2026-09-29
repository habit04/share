/**
 * Field expressions in TEXT / MTEXT (AutoCAD FIELD): %<\AcVar Date \f "M/d/yyyy">%,
 * %<\AcVar Filename \f "%fn2">%, %<\AcSm Sheet.Number>% ...
 *
 * evaluateFields() replaces every expression by its value for a given context.
 * Values that cannot be evaluated show as "####" and empty properties as "----",
 * like AutoCAD. The entity keeps the original expression (FieldLink) so a DXF
 * save writes the field code back.
 */

export interface FieldContext {
  /** Full path of the drawing file (Filename field). */
  filePath?: string | null;
  /** "Now" for Date (defaults to the current time). */
  now?: Date;
  createDate?: Date;
  saveDate?: Date;
  plotDate?: Date;
  /** Drawing properties (DWGPROPS). */
  title?: string;
  subject?: string;
  author?: string;
  keywords?: string;
  comments?: string;
  lastSavedBy?: string;
  login?: string;
  /** Sheet set values for \AcSm, keyed like "Sheet.Number" / "SheetSet.Name". */
  sheetSet?: Readonly<Record<string, string>>;
}

export const FIELD_UNAVAILABLE = '####';
export const FIELD_EMPTY = '----';

/** The \AcVar names this module evaluates (FIELD command list). */
export const ACVAR_FIELDS = ['Date', 'CreateDate', 'SaveDate', 'PlotDate', 'Filename', 'Title', 'Subject', 'Author', 'Keywords', 'Comments', 'LastSavedBy', 'Login'] as const;

const FIELD_RE = /%<\\(Ac[A-Za-z]+)(?:\.[\d.]+)?\s+((?:(?!%<|>%)[\s\S])*?)>%/g;

/** True when the text holds at least one field expression. */
export function hasFields(text: string): boolean {
  return /%<\\Ac[A-Za-z]+/.test(text);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Format a date with .NET-style tokens (M/d/yyyy, dddd, MMMM, h:mm tt, HH:mm:ss ...). */
export function formatFieldDate(d: Date, fmt: string): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const tokens = /(yyyy|yy|MMMM|MMM|MM|M|dddd|ddd|dd|d|HH|H|hh|h|mm|m|ss|s|tt|"[^"]*"|'[^']*')/g;
  return fmt.replace(tokens, (t) => {
    switch (t) {
      case 'yyyy':
        return String(d.getFullYear());
      case 'yy':
        return pad(d.getFullYear() % 100);
      case 'MMMM':
        return MONTHS[d.getMonth()]!;
      case 'MMM':
        return MONTHS[d.getMonth()]!.slice(0, 3);
      case 'MM':
        return pad(d.getMonth() + 1);
      case 'M':
        return String(d.getMonth() + 1);
      case 'dddd':
        return DAYS[d.getDay()]!;
      case 'ddd':
        return DAYS[d.getDay()]!.slice(0, 3);
      case 'dd':
        return pad(d.getDate());
      case 'd':
        return String(d.getDate());
      case 'HH':
        return pad(d.getHours());
      case 'H':
        return String(d.getHours());
      case 'hh':
        return pad(d.getHours() % 12 || 12);
      case 'h':
        return String(d.getHours() % 12 || 12);
      case 'mm':
        return pad(d.getMinutes());
      case 'm':
        return String(d.getMinutes());
      case 'ss':
        return pad(d.getSeconds());
      case 's':
        return String(d.getSeconds());
      case 'tt':
        return d.getHours() < 12 ? 'AM' : 'PM';
      default:
        return t.slice(1, -1);
    }
  });
}

/** Text case option %tc1 upper, %tc2 lower, %tc3 first capital, %tc4 title case. */
function applyCase(s: string, fmt: string): string {
  const m = /%tc(\d)/.exec(fmt);
  switch (m?.[1]) {
    case '1':
      return s.toUpperCase();
    case '2':
      return s.toLowerCase();
    case '3':
      return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
    case '4':
      return s.replace(/\S+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
    default:
      return s;
  }
}

/**
 * Filename field: %fn is bit-coded, 1 = folder, 2 = name, 4 = extension
 * (%fn2 name only, %fn6 name.ext, %fn7 full path). Default is name.ext.
 */
export function formatFilename(filePath: string, fmt: string): string {
  const m = /%fn(\d)/.exec(fmt);
  const bits = m ? parseInt(m[1]!, 10) : 6;
  const cut = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  const folder = cut >= 0 ? filePath.slice(0, cut + 1) : '';
  const file = filePath.slice(cut + 1);
  const dot = file.lastIndexOf('.');
  const name = dot > 0 ? file.slice(0, dot) : file;
  const ext = dot > 0 ? file.slice(dot) : '';
  let out = '';
  if (bits & 1) out += folder;
  if (bits & 2) out += name;
  if (bits & 4) out += ext;
  return applyCase(out || file, fmt);
}

/** Split "Name \f "format"" into the variable name and its format string. */
function splitArgs(args: string): { name: string; format: string | null } {
  const m = /^(.*?)\s*\\f\s*"([^"]*)"\s*$/.exec(args.trim());
  if (m) return { name: m[1]!.trim(), format: m[2]! };
  return { name: args.trim(), format: null };
}

function evaluateOne(kind: string, args: string, ctx: FieldContext): string {
  const { name, format } = splitArgs(args);
  if (kind === 'AcSm') return ctx.sheetSet?.[name] ?? FIELD_UNAVAILABLE;
  if (kind !== 'AcVar') return FIELD_UNAVAILABLE;
  const key = name.toLowerCase();
  const date = (d: Date | undefined) => (d ? applyCase(formatFieldDate(d, format ?? 'M/d/yyyy'), format ?? '') : FIELD_EMPTY);
  const prop = (v: string | undefined) => (v && v.length ? applyCase(v, format ?? '') : FIELD_EMPTY);
  switch (key) {
    case 'date':
      return date(ctx.now ?? new Date());
    case 'createdate':
      return date(ctx.createDate);
    case 'savedate':
      return date(ctx.saveDate);
    case 'plotdate':
      return date(ctx.plotDate);
    case 'filename':
      return ctx.filePath ? formatFilename(ctx.filePath, format ?? '') : FIELD_UNAVAILABLE;
    case 'title':
      return prop(ctx.title);
    case 'subject':
      return prop(ctx.subject);
    case 'author':
      return prop(ctx.author);
    case 'keywords':
      return prop(ctx.keywords);
    case 'comments':
      return prop(ctx.comments);
    case 'lastsavedby':
      return prop(ctx.lastSavedBy);
    case 'login':
      return prop(ctx.login);
    case 'ctab':
      return 'Model';
    default:
      return FIELD_UNAVAILABLE;
  }
}

/** Replace every field expression in `text` by its value. */
export function evaluateFields(text: string, ctx: FieldContext = {}): string {
  let out = text;
  // Innermost first, so nested expressions (%<\AcExpr (%<...>%)>%) collapse from the inside.
  for (let guard = 0; guard < 8; guard += 1) {
    FIELD_RE.lastIndex = 0;
    const next = out.replace(FIELD_RE, (_m, kind: string, args: string) => evaluateOne(kind, args, ctx));
    if (next === out) break;
    out = next;
  }
  return out;
}

/** Build a field expression for an \AcVar name (FIELD command). */
export function acVarField(name: string, format?: string): string {
  return format ? `%<\\AcVar ${name} \\f "${format}">%` : `%<\\AcVar ${name}>%`;
}

/** Julian day number (DXF $TDCREATE / $TDUPDATE) to a Date. */
export function julianToDate(jd: number): Date | undefined {
  if (!Number.isFinite(jd) || jd <= 0) return undefined;
  return new Date((jd - 2440587.5) * 86400000);
}
