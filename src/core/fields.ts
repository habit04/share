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

/**
 * The field expressions of `text`, innermost first: `%<\Kind(.version) args>%` whose args hold
 * no other `%<` (a nested expression is found on its own). One pass with forward-only searches,
 * so the time is linear in the text: the regular expression this replaces took quadratic time on
 * a long run of spaces without a closing `>%` (security review E-6).
 */
export function replaceFields(text: string, fn: (kind: string, args: string) => string): string {
  const isWord = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
  const isDigitOrDot = (c: number) => (c >= 48 && c <= 57) || c === 46;
  const isSpace = (ch: string) => ch.trim() === '' && ch !== '';
  let out = '';
  let copied = 0;
  // The next ">%" and "%<" at or after the scan position (positions only grow, so each search
  // continues where the previous one stopped).
  let close = -2;
  let open = -2;
  let i = text.indexOf('%<\\');
  while (i >= 0) {
    let p = i + 3;
    const kindStart = p;
    while (p < text.length && isWord(text.charCodeAt(p))) p += 1;
    const kind = text.slice(kindStart, p);
    if (kind && text[p] === '.' && p + 1 < text.length && isDigitOrDot(text.charCodeAt(p + 1))) {
      p += 1;
      while (p < text.length && isDigitOrDot(text.charCodeAt(p))) p += 1;
    }
    let matched = false;
    if (kind && p < text.length && isSpace(text[p]!)) {
      while (p < text.length && isSpace(text[p]!)) p += 1;
      if (close !== -1 && close < p) close = text.indexOf('>%', p);
      if (close === -1) break; // no closing ">%" anywhere after here: nothing more matches
      if (open !== -1 && open < p) open = text.indexOf('%<', p);
      if (open === -1 || open >= close) {
        out += text.slice(copied, i) + fn(kind, text.slice(p, close));
        copied = close + 2;
        matched = true;
      }
    }
    i = text.indexOf('%<\\', matched ? copied : i + 1);
  }
  return copied === 0 ? text : out + text.slice(copied);
}

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

/**
 * Split "Name \f "format"" into the variable name and its format string: the arguments end in a
 * quoted format (no quote inside) that `\f` introduces. Scanned from the end, in linear time (a
 * regular expression here took quadratic time on long runs of spaces, security review E-6).
 */
export function splitArgs(args: string): { name: string; format: string | null } {
  const t = args.trim();
  const none = { name: t, format: null };
  if (t.length < 2 || !t.endsWith('"')) return none;
  const q = t.lastIndexOf('"', t.length - 2);
  if (q < 0) return none;
  const head = t.slice(0, q).trimEnd();
  if (!head.endsWith('\\f')) return none;
  const name = head.slice(0, -2);
  // The name is on one line (the expression's "." did not cross line breaks).
  if (/[\n\r\u2028\u2029]/.test(name.trimEnd())) return none;
  return { name: name.trim(), format: t.slice(q + 1, -1) };
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
    const next = replaceFields(out, (kind, args) => evaluateOne(kind, args, ctx));
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
