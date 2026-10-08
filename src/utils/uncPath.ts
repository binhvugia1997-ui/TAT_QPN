/**
 * One rule for the value that is easiest to get wrong in this project: the UNC path of the LAN
 * update folder.
 *
 * A path like `\\192.168.103.12\ReportExtractor_Update\TAT QPN\updates` has to survive four
 * different escaping regimes before it reaches the share — a TypeScript string literal, JSON on
 * disk, a `cmd.exe` command line, and the Windows path parser — and every one of them fails
 * silently. The observed symptoms are "the update source is unreachable" against a share that is
 * perfectly fine, or a publish that quietly wrote the manifest next to `TAT` because batch split
 * the argument at the space in `TAT QPN`. So the rule lives here, once, and is unit-tested.
 *
 * The rules that matter:
 * 1. Separate path segments with `\`. A `/` is accepted on input (Explorer's address bar shows
 *    one) and normalised away, because `String.prototype.split('/')` on a UNC path is a no-op and
 *    a mixed-separator path is the kind of thing a hand-pasted `.bat` edit produces.
 * 2. `\` is not an escape character in cmd.exe. `"..."` is what preserves spaces, and `toBatchArgument`
 *    is the only place that decision is made.
 * 3. A trailing separator is meaningless (`\\server\share\` === `\\server\share`), so it is dropped
 *    rather than becoming an empty final segment.
 * 4. The server and share are case-insensitive on Windows; the share *segment* must still match
 *    exactly, so case is preserved rather than folded — an app that rewrites what the operator
 *    typed is an app they stop trusting.
 */

/** `\\server\share` — the smallest meaningful UNC path. */
const UNC_PREFIX = '\\\\';

/** Windows caps a normal path at 260 characters; a longer one is rejected rather than half-used. */
export const MAX_UNC_PATH_LENGTH = 260;
const MAX_SERVER_LENGTH = 63;
const MAX_SHARE_LENGTH = 255;

/** Legal in a Windows file, folder or share name; explicitly excludes `:` and path separators. */
const SAFE_NAME_PATTERN = /^[^\\/:*?"<>|\u0000-\u001f]+$/u;

/**
 * A NetBIOS host name or a dotted IPv4 literal. Dots are legal in the body — an address is made
 * of them — while a label may not start or end with `-` or `.`; that is what the two anchors do.
 */
const SERVER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/u;

/** Four dotted octets, each 0-255, with no leading zeros (`01.2.3.4` is not what people mean). */
const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u;

const TRAILING_SEPARATORS = /[\\/]+$/u;
const SEPARATOR_RUNS = /[\\/]{2,}/gu;
/** A single `/` is also a separator, so it must be folded before runs are collapsed. */
const SLASH_SEPARATORS = new RegExp('/', 'gu');

/**
 * `\\?\...` and `\\.\...` are Win32 namespace escapes, not network locations. A character class is
 * used rather than an inline alternation so the `?` and `.` stay literal by construction.
 */
const NAMESPACE_PREFIX_PATTERN = new RegExp('^[\\\\/]{2}[?\\.][\\\\/]', 'u');

export interface UncPathParts {
  /** Server name or IPv4 literal, exactly as written, without the leading `\\`. */
  server: string;
  /** Share name, without separators. */
  share: string;
  /** Everything below the share, `\`-joined, without a leading separator. Empty when absent. */
  folders: string;
}

export interface UncParseResult {
  ok: boolean;
  /** The value to store: normalised separators, no trailing separator, original case. */
  normalized: string;
  parts: UncPathParts | null;
  /** Populated only when `ok` is false, and always phrased for an operator. */
  reason: string | null;
}

/**
 * Parses and validates a UNC path, accepting `\` or `/` as separators and collapsing runs.
 *
 * It rejects anything that is not a plain `\\server\share\...` path — drive letters,
 * single-leading-backslash paths, and the `\\?\` / `\\.\` namespace escapes — and it never
 * invents a path: an invalid input returns `ok: false` with a reason, never a "best guess".
 */
export function parseUncPath(input: unknown): UncParseResult {
  const fail = (normalized: string, reason: string): UncParseResult => ({
    ok: false,
    normalized,
    parts: null,
    reason,
  });

  if (typeof input !== 'string') return fail('', 'The update folder must be a text path.');

  const trimmed = input.trim();
  if (!trimmed) return fail('', 'The update folder is empty.');
  if (/[\u0000-\u001f]/u.test(trimmed)) {
    return fail(trimmed, 'The update folder contains a control character.');
  }
  if (trimmed.length > MAX_UNC_PATH_LENGTH) {
    return fail(trimmed, `The update folder is longer than ${MAX_UNC_PATH_LENGTH} characters.`);
  }

  const looksUnc = trimmed.startsWith(UNC_PREFIX) || trimmed.startsWith('//');
  if (!looksUnc) {
    return fail(trimmed, 'A network update folder must start with two backslashes, for example \\\\SERVER\\Share\\Folder.');
  }
  if (NAMESPACE_PREFIX_PATTERN.test(trimmed)) {
    return fail(trimmed, 'This kind of Windows namespace path cannot be used as an update folder.');
  }

  // Slice off the leading pair first, so `\\server` never becomes an empty first segment, then
  // fold every separator run onto a single backslash.
  const body = trimmed.slice(2).replace(SLASH_SEPARATORS, '\\').replace(SEPARATOR_RUNS, '\\').replace(TRAILING_SEPARATORS, '');
  const segments = body.split('\\').filter((segment) => segment.length > 0);
  const [server, share, ...rest] = segments;

  if (!server || !share) {
    return fail(trimmed, 'A network update folder needs both a server and a share name, for example \\\\SERVER\\Share\\Folder.');
  }
  if (server.length > MAX_SERVER_LENGTH || !SERVER_PATTERN.test(server)) {
    return fail(trimmed, `"${server}" is not a valid server name or IP address.`);
  }
  // A dotted server is treated as an IPv4 literal and must then be a *complete* one: `1.2.3` is
  // not an address, and Windows would resolve it through the suffix search list — reaching an
  // entirely different machine rather than failing. A typo must fail loudly, never silently.
  if (server.includes('.')) {
    const octets = server.split('.');
    const validIpv4 = octets.length === 4 && IPV4_PATTERN.test(server) && octets.every((octet) => octet === String(Number(octet)) && Number(octet) <= 255);
    if (!validIpv4) return fail(trimmed, `"${server}" is not a valid server name or IPv4 address.`);
  }
  if (share.length > MAX_SHARE_LENGTH || !SAFE_NAME_PATTERN.test(share)) {
    return fail(trimmed, `"${share}" is not a valid share name.`);
  }
  if (rest.some((segment) => !SAFE_NAME_PATTERN.test(segment))) {
    return fail(trimmed, 'A folder in the update path contains a character Windows does not allow (: * ? " < > |).');
  }
  if (rest.some((segment) => segment === '.' || segment === '..')) {
    return fail(trimmed, 'The update folder must not contain . or .. segments.');
  }

  const folders = rest.join('\\');
  return {
    ok: true,
    normalized: `${UNC_PREFIX}${server}\\${share}${folders ? `\\${folders}` : ''}`,
    parts: { server, share, folders },
    reason: null,
  };
}

/**
 * True when the value looks like it was *meant* to be a network path, i.e. it starts like one.
 *
 * Used to decide whether a typo can be answered locally instead of by a round trip: an unreachable
 * server is discovered by SMB timeout, which takes seconds, while `//SERVER/...` that is simply
 * malformed is known instantly. A plain local folder is not "meant to be" a network path — it is a
 * legitimate value here (tests and dry runs use one) and must still be handed to the real check.
 */
export function looksLikeNetworkPath(input: unknown): boolean {
  if (typeof input !== 'string') return false;
  const trimmed = input.trim();
  return trimmed.startsWith(UNC_PREFIX) || trimmed.startsWith('//');
}

/** True when the value is a usable UNC update folder. */
export function isValidUncPath(input: unknown): boolean {
  return parseUncPath(input).ok;
}

/**
 * Normalises for storage: collapses separator runs, converts `/` to `\`, drops one trailing
 * separator, and leaves the case exactly as written. An invalid UNC path is returned trimmed but
 * otherwise untouched, because a local folder is also a legitimate value and the function must not
 * turn a typo into an empty string.
 */
export function normalizeUpdateSource(input: unknown): string {
  const result = parseUncPath(input);
  if (result.ok) return result.normalized;
  return typeof input === 'string' ? input.trim().replace(TRAILING_SEPARATORS, '') : '';
}

/**
 * Escapes a path for the *body* of a single-quoted string literal in a generated file; the
 * caller supplies the quotes. Backslash is the one character that must be doubled: writing
 * `\\SERVER\Share` out verbatim would produce `\SERVER` (a `\S` escape) or a syntax error.
 */
export function toJsStringLiteral(value: string): string {
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError('A control character cannot be embedded in a generated source literal.');
  }
  return value.replace(/\\/gu, '\\\\').replace(/'/gu, "\\'");
}

/**
 * Quotes a value for `cmd.exe`, so a spaced share path arrives as one argument.
 *
 * Batch has no backslash escape, which is why this does not double anything: the leading `\\` of a
 * UNC path and the separators inside it are passed through untouched, and the quoting alone is what
 * preserves the space. `"` is doubled because inside a quoted argument cmd.exe reads `""` as a
 * literal quote. Metacharacters are caret-escaped as a belt-and-braces measure against a value
 * that breaks out of the quotes.
 *
 * A path containing a literal `"` is rejected instead of being mangled.
 */
export function toBatchArgument(value: string): string {
  if (value.includes('"')) {
    throw new TypeError('A double quote in an update path cannot be passed safely to a batch script.');
  }
  if (/[\r\n]/u.test(value)) {
    throw new TypeError('A line break in an update path would split the generated script.');
  }
  const escaped = value.replace(/[&|<>^]/gu, (character) => `^${character}`);
  return `"${escaped}"`;
}

/** Where the project lives on the Owner's PC, as documented in the publish README. */
export const DEFAULT_TAT_QPN_PROJECT_DIR = 'D:\\TAT TNP\\TAT_QPN-main';

/**
 * The default publish target for test builds. `TAT QPN` contains a space, which is exactly why
 * `toBatchArgument` exists: unquoted, batch publishes this to `...ReportExtractor_Update\TAT`.
 */
export const DEFAULT_TAT_QPN_UPDATE_TARGET = '\\\\192.168.103.12\\ReportExtractor_Update\\TAT QPN\\updates';
