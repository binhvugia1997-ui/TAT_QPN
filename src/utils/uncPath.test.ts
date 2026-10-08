import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_TAT_QPN_PROJECT_DIR,
  DEFAULT_TAT_QPN_UPDATE_TARGET,
  MAX_UNC_PATH_LENGTH,
  isValidUncPath,
  looksLikeNetworkPath,
  normalizeUpdateSource,
  parseUncPath,
  toBatchArgument,
  toJsStringLiteral,
} from './uncPath';

/**
 * UNC paths are the one value in this app that must survive four different escaping regimes —
 * a JS/TS string literal, JSON on disk, a batch argument, and the filesystem itself. Every
 * failure mode here is silent: the path simply stops resolving, and the operator sees "update
 * source unreachable" for a share that is perfectly fine.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relative: string) => readFileSync(path.join(repoRoot, relative), 'utf8');

const UNC = String.fromCharCode(92);
/**
 * The real project target, spelled with characters rather than escape sequences. In a file whose
 * whole subject is backslashes, an escape-doubled literal is unreadable — this file got one wrong
 * by a single backslash twice before this replaced them.
 */
const TARGET = UNC + UNC + '192.168.103.12' + UNC + 'ReportExtractor_Update' + UNC + 'TAT QPN' + UNC + 'updates';

describe('parsing a UNC update folder', () => {
  it('accepts the project default and reports its parts', () => {
    const result = parseUncPath(TARGET);

    expect(result.ok).toBe(true);
    expect(result.parts).toEqual({
      server: '192.168.103.12',
      share: 'ReportExtractor_Update',
      folders: 'TAT QPN\\updates',
    });
  });

  it('keeps a share name containing a space, which is the common real-world case', () => {
    expect(isValidUncPath('\\\\FILE-SERVER\\TAT QPN Share\\updates')).toBe(true);
    // The space must not be treated as an argument boundary anywhere downstream.
    expect(toBatchArgument('\\\\FILE-SERVER\\TAT QPN Share\\updates')).toBe('"\\\\FILE-SERVER\\TAT QPN Share\\updates"');
  });

  it('normalises separators and collapses runs, without inventing a path', () => {
    expect(parseUncPath('//192.168.103.12/ReportExtractor_Update/TAT QPN/updates').normalized).toBe(TARGET);
    expect(parseUncPath('\\\\\\\\192.168.103.12\\\\\\\\ReportExtractor_Update\\\\updates').normalized).toBe(
      '\\\\192.168.103.12\\ReportExtractor_Update\\updates',
    );
    expect(parseUncPath('   ' + TARGET + '   ').ok).toBe(true);
    // One trailing separator is how an operator pastes a folder; it is not a new segment.
    expect(parseUncPath(TARGET + '\\').normalized).toBe(TARGET);
  });

  it('preserves the case the operator wrote, so a stored path round-trips unchanged', () => {
    const result = parseUncPath('\\\\BUILD-PC\\TNP_Update\\Test');

    // Windows resolves these names case-insensitively, so folding the case would only make the
    // stored value disagree with what the operator sees in Explorer — and rewrite a setting on
    // every save, which is what `normalizeSettings` does when it reads a file back.
    expect(result.normalized).toBe('\\\\BUILD-PC\\TNP_Update\\Test');
    expect(result.parts?.server).toBe('BUILD-PC');
    expect(result.parts?.share).toBe('TNP_Update');
  });

  it('accepts a bare \\server\\share with no folders', () => {
    const result = parseUncPath('\\\\NAS\\updates');

    expect(result.ok).toBe(true);
    expect(result.normalized).toBe('\\\\NAS\\updates');
    expect(result.parts?.folders).toBe('');
  });

  it('rejects anything that is not a network path', () => {
    const rejected = [
      '',
      '   ',
      'C:\\TAT QPN\\updates',
      'D:/TAT TNP/TAT_QPN-main',
      '\\\\BUILD-PC',
      '\\\\.\\PhysicalDrive0',
      '\\\\?\\UNC\\server\\share',
      '\\relative\\path',
      'relative/path',
      '/',
      '\\',
      null,
      undefined,
      42,
      {},
      [],
      true,
    ];

    for (const value of rejected) {
      expect(isValidUncPath(value), JSON.stringify(value)).toBe(false);
    }
  });

  it('rejects an invalid IPv4 literal rather than passing it to the network stack', () => {
    expect(isValidUncPath('\\\\192.168.999.12\\share')).toBe(false);
    expect(isValidUncPath('\\\\1.2.3\\share')).toBe(false);
    expect(isValidUncPath('\\\\01.2.3.4\\share')).toBe(false);
    expect(isValidUncPath('\\\\192.168.103.12\\share')).toBe(true);
  });

  it('rejects characters Windows forbids, which would otherwise fail at write time', () => {
    for (const value of [
      '\\\\PC\\sh:are',
      '\\\\PC\\share\\bad*name',
      '\\\\PC\\share\\bad?name',
      '\\\\PC\\share\\bad"name',
      '\\\\PC\\share\\bad<name',
      '\\\\PC\\share\\bad|name',
    ]) {
      expect(isValidUncPath(value), value).toBe(false);
    }
  });

  it('rejects traversal segments, so a configured source cannot climb out of the share', () => {
    expect(isValidUncPath('\\\\PC\\share\\..\\other')).toBe(false);
    expect(isValidUncPath('\\\\PC\\share\\.\\updates')).toBe(false);
  });

  it('rejects control characters and an over-long path', () => {
    expect(isValidUncPath('\\\\PC\\share\\up\ndates')).toBe(false);
    expect(isValidUncPath(`\\\\PC\\share\\${'a'.repeat(MAX_UNC_PATH_LENGTH)}`)).toBe(false);
  });

  it('explains why a value was refused', () => {
    expect(parseUncPath('C:\\TAT QPN\\updates').reason).toMatch(/two backslashes/u);
    expect(parseUncPath('\\\\PC').reason).toMatch(/server and a share/u);
    expect(parseUncPath('\\\\PC\\sh:are').reason).toMatch(/share name/u);
    expect(parseUncPath('\\\\?\\UNC\\a\\b').reason).toMatch(/namespace/u);
    expect(parseUncPath(123).reason).toMatch(/text path/u);
  });
});

describe('normalising a stored update source', () => {
  it('is idempotent on a valid path', () => {
    const once = normalizeUpdateSource(TARGET);

    // Byte-for-byte: the value stored is the value entered, once it is already well formed.
    expect(once).toBe(TARGET);
    expect(normalizeUpdateSource(once)).toBe(once);
  });

  it('keeps a local folder usable, because tests and development use one', () => {
    expect(normalizeUpdateSource('/tmp/update-share')).toBe('/tmp/update-share');
    expect(normalizeUpdateSource('C:\\TAT QPN\\updates')).toBe('C:\\TAT QPN\\updates');
    // A local folder is tidy-only: a trailing separator is still dropped.
    expect(normalizeUpdateSource('/tmp/update-share/')).toBe('/tmp/update-share');
  });

  it('never invents a path from empty or non-text input', () => {
    for (const value of ['', '   ', null, undefined, 7, {}]) {
      expect(normalizeUpdateSource(value)).toBe('');
    }
  });
});

describe('telling a network path from a local folder', () => {
  it('recognises both spellings of the network prefix', () => {
    expect(looksLikeNetworkPath('\\\\PC\\share')).toBe(true);
    expect(looksLikeNetworkPath('//PC/share')).toBe(true);
    expect(looksLikeNetworkPath('   \\\\PC\\share   ')).toBe(true);
  });

  it('leaves a local folder to the real check, because it is a legitimate value', () => {
    for (const value of ['/tmp/updates', 'C:\\TAT QPN\\updates', 'D:/build/updates', 'updates', '']) {
      expect(looksLikeNetworkPath(value), value).toBe(false);
    }
  });

  it('is the guard that keeps a typo from costing an SMB timeout', () => {
    // A malformed path that starts like a network path is known to be wrong instantly; a local
    // folder is not, so it must still reach the filesystem. The pair of rules is the whole logic.
    const mistyped = '//192.168.103.12/ReportExtractor_Update/TAT QPN:updates';
    expect(looksLikeNetworkPath(mistyped)).toBe(true);
    expect(isValidUncPath(mistyped)).toBe(false);

    const local = '/tmp/tnp-updates/';
    expect(looksLikeNetworkPath(local)).toBe(false);
    expect(isValidUncPath(local)).toBe(false);
    expect(normalizeUpdateSource(local)).toBe('/tmp/tnp-updates');
  });

  it('never throws on the shapes a text input can produce', () => {
    for (const value of [null, undefined, 7, {}, [], true]) {
      expect(looksLikeNetworkPath(value)).toBe(false);
    }
  });
});

describe('escaping a path for each place it appears', () => {
  it('compiles back to exactly the original path in a JS string literal', () => {
    const literal = toJsStringLiteral(TARGET);

    // Every separator is doubled and nothing else changes — stated as the rule, because an
    // escape-doubled literal is unreadable enough to hide a wrong expectation (it hid two here).
    const separators = TARGET.split(UNC).length - 1;
    expect(literal.length).toBe(TARGET.length + separators);
    expect(literal).toBe(TARGET.split(UNC).join(UNC + UNC));
    // Quoting the body and evaluating it must reproduce the path byte for byte — the whole point.
    // eslint-disable-next-line no-eval
    expect(eval(`'${literal}'`)).toBe(TARGET);
  });

  it('round-trips through JSON unchanged, because the setting is persisted as JSON', () => {
    // There is no bespoke JSON escaping step for a path — `JSON.stringify` is the whole job, and
    // the assertion that matters is that the app never needs to know it is a path at all.
    for (const value of [TARGET, 'C:\\a\\b', 'plain', 'with "quote"']) {
      const stored = JSON.stringify({ updateSource: value });
      expect(JSON.parse(stored).updateSource).toBe(value);
    }
  });

  it('quotes a batch argument so a space cannot split it', () => {
    const batched = toBatchArgument(TARGET);

    expect(batched.startsWith('"')).toBe(true);
    expect(batched.endsWith('"')).toBe(true);
    // The spaces stay inside the quotes, so `%~1` strips the quotes and keeps one whole path:
    // unquoted, this same value is *two* arguments and the publish lands in `...\TAT`.
    expect(batched.slice(1, -1).split(' ')).toHaveLength(2);
    // Quoting is not escaping: the backslashes must survive untouched, doubled only in source.
    expect(batched).toContain('\\\\192.168.103.12\\ReportExtractor_Update');
  });

  it('neutralises batch metacharacters inside the quotes', () => {
    expect(toBatchArgument('\\\\PC\\share\\a&b')).toBe('"\\\\PC\\share\\a^&b"');
    // A `"` is illegal in a Windows path *and* cannot be represented reliably once `%~1` strips
    // the outer quotes, so it is refused rather than doubled into something ambiguous.
    expect(() => toBatchArgument('\\\\PC\\share\\a"b')).toThrow(TypeError);
    expect(() => toBatchArgument('\\\\PC\\share\na')).toThrow(TypeError);
  });

  it('refuses to embed a control character in generated source', () => {
    expect(() => toJsStringLiteral('a\nb')).toThrow(TypeError);
    expect(() => toJsStringLiteral('a\tb')).toThrow(TypeError);
  });
});

describe('the declared defaults', () => {
  it('are valid Windows paths of the expected shape', () => {
    expect(DEFAULT_TAT_QPN_UPDATE_TARGET).toBe('\\\\192.168.103.12\\ReportExtractor_Update\\TAT QPN\\updates');
    expect(isValidUncPath(DEFAULT_TAT_QPN_UPDATE_TARGET)).toBe(true);
    expect(DEFAULT_TAT_QPN_PROJECT_DIR).toBe('D:\\TAT TNP\\TAT_QPN-main');
    // The project folder is a *drive* path, so it is deliberately not a valid update source.
    expect(isValidUncPath(DEFAULT_TAT_QPN_PROJECT_DIR)).toBe(false);
  });

  it('agree with the publish script, which is the file the operator actually runs', () => {
    const script = read('BUILD_AND_PUBLISH_TNP_TEST.bat');

    // The default target in the batch file must be *this* default. Drift here is invisible: the
    // script keeps succeeding, it just publishes to a folder no client is configured to read.
    expect(script).toContain(`set "TNP_UPDATE_TARGET=${DEFAULT_TAT_QPN_UPDATE_TARGET}"`);
    // A batch argument is split at every space unless it is quoted, and the shared folder name
    // contains one — this is the single highest-consequence line in the file.
    expect(script).toContain(`--target "%TNP_UPDATE_TARGET%"`);
    // A target truncated at an unquoted space ends at the spaced folder name, and the script says
    // so instead of publishing there.
    expect(script).toContain('if "%TNP_UPDATE_TARGET:~-3%"=="TAT"');
    // The pre-flight runs before the publish, and the publish is the last thing that happens.
    expect(script).toContain('--check-only');
    expect(script.indexOf('update folder pre-flight')).toBeLessThan(script.indexOf('--source '));
    expect(script.indexOf('--source ')).toBeLessThan(script.indexOf('PUBLISHED SUCCESSFULLY'));
    // The project root is passed explicitly, so the build bump writes the package.json that the
    // next build compiles rather than the runtime's own metadata file.
    expect(script).toContain(`--project "%REPO_ROOT%"`);
  });

  it('never leave a raw single-backslash UNC in a generated JSON default', () => {
    // desktop-settings is written with JSON.stringify, so this asserts the *stored* form.
    const stored = JSON.stringify({
      updateSource: DEFAULT_TAT_QPN_UPDATE_TARGET,
    });
    expect(JSON.parse(stored).updateSource).toBe(DEFAULT_TAT_QPN_UPDATE_TARGET);
    expect(stored).toContain('\\\\\\\\192.168.103.12');
  });
});

describe('the batch scripts that run the gates', () => {
  const scripts = ['BUILD_AND_PUBLISH_TNP_TEST.bat', 'UPDATE_AND_BUILD_TNP.bat'];

  it('arrive on Windows with CRLF, while git keeps LF blobs', () => {
    // cmd.exe reads a batch file line by line and its label scanner is unreliable on LF-only
    // files, which is fatal for scripts that stop every run through `call :fail`, `goto :eof` and
    // parenthesised blocks. `eol=crlf` fixes the checkout without rewriting the repository: the
    // normalised blob stays LF, so diffs, tests and every non-Windows tool see no change.
    expect(read('.gitattributes')).toMatch(/^\*\.bat text eol=crlf$/mu);

    for (const name of scripts) {
      const text = readFileSync(path.join(repoRoot, name)).toString('utf8');
      const lf = (text.match(/\n/gu) ?? []).length;
      const crlf = (text.match(/\r\n/gu) ?? []).length;

      expect(crlf, name).toBeGreaterThan(0);
      // A mixed file is the worst case: cmd parses some lines correctly and not others.
      expect(lf - crlf, `${name} lone LF count`).toBe(0);
    }
  });

  it('end the run at every failure, which a `call` cannot do on its own', () => {
    // `call :fail` prints the reason and *returns*. Only an `exit /b 1` written in the script's own
    // body ends it, so a check added without one would log FAILED, run the next gate, build, and
    // publish anyway — and `version.json` going last is what makes a published build trusted.
    for (const name of scripts) {
      const lines = read(name).split(/\r?\n/u);
      const failSites = lines
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => /^\s*call :fail\b/.test(line));

      expect(failSites.length, name).toBeGreaterThan(4);
      for (const { line, index } of failSites) {
        expect(lines[index + 1], `${name} line ${index + 1}: ${line.trim()}`).toMatch(/exit \/b 1/u);
      }
    }
  });

  it('propagate a failed gate out of :step, and never pass a quoted command into it', () => {
    for (const name of scripts) {
      const text = read(name);
      const lines = text.split(/\r?\n/u);
      const gateLines = lines.filter((line) => /^call :step\b/.test(line));

      expect(gateLines.length, name).toBeGreaterThan(0);
      for (const line of gateLines) {
        // Without this the routine's exit code dies inside :step and the next gate runs anyway.
        expect(line, `${name}: ${line}`).toMatch(/\|\| exit \/b 1$/u);
        // A :step argument is one quoted string and cmd ends it at the next quote, so a command
        // that needs quoting must be written out at the call site; more than two quoted values on
        // one of these lines means the command line was already cut in half.
        expect((line.match(/"/gu) ?? []).length, `${name}: ${line}`).toBe(4);
      }

      // There is no backslash escape in batch, so an escaped quote on a command line is not an
      // escaped quote: cmd hands `\"x\"` to the child as a path that literally contains quotes.
      // (A `\"` elsewhere is legitimate — `if "%VAR:~-1%"=="\"` compares against one backslash,
      // because cmd's own quoting has no escape and the backslash is the value.)
      for (const line of lines.filter((entry) => /^\s*call (node|:step)\b/.test(entry))) {
        expect(line, `${name}: ${line}`).not.toContain('\\"');
      }
    }
  });

  it('write the pre-flight out with ordinary quoting so its arguments survive', () => {
    const lines = read('BUILD_AND_PUBLISH_TNP_TEST.bat').split(/\r?\n/u);
    const preflight = lines.filter((line) => line.includes('--check-only'));

    // One command, and it carries the target, the channel and the project root it is checking.
    expect(preflight).toHaveLength(1);
    expect(preflight[0]).toContain('--target "%TNP_UPDATE_TARGET%"');
    expect(preflight[0]).toContain('--project "%REPO_ROOT%"');
    // target, project and the script path: three quoted values, six quote characters, no more.
    expect((preflight[0].match(/"/gu) ?? []).length).toBe(6);
    // A failed pre-flight must stop the run before the publish line, not merely be logged. Three
    // lines is the widest failure block the script uses: the check, the report, the stop.
    const index = lines.findIndex((line) => line.includes('--check-only'));
    const guard = lines.slice(index + 1, index + 4).join('\n');
    expect(guard).toMatch(/call :fail/u);
    expect(guard).toMatch(/exit \/b 1/u);
    expect(guard, 'the stop has to be in the script body, not inside the routine').not.toMatch(/call :step/u);
  });

  it('refuse a spaced path of any name, not only the default folder', () => {
    const text = read('BUILD_AND_PUBLISH_TNP_TEST.bat');

    // The suffix check below catches the documented symptom for the default target. This is the
    // general rule: a second argument can only exist because cmd.exe split the path at a space.
    expect(text).toContain('if "%~2" neq "" set "TNP_SPLIT_ARGUMENT=1"');
    expect(text).toContain('if defined TNP_SPLIT_ARGUMENT (');
    expect(text).toContain('if "%TNP_UPDATE_TARGET:~-3%"=="TAT"');
  });
});
