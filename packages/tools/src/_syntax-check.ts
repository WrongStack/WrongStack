/**
 * Post-edit syntax validation for `edit` and `write`.
 *
 * After a mutation lands on disk, the new content is parsed (TS/JS via the
 * TypeScript compiler's parser, JSON via JSON.parse with a JSONC fallback)
 * and any parse errors are surfaced in the tool output. The edit is NOT
 * rolled back — reverting would desynchronize the model's picture of the
 * file — but the errors come back in the same turn so the model fixes the
 * breakage before the user ever opens a broken file.
 *
 * The check is purely syntactic (no type checking, no project program), so
 * it costs single-digit milliseconds per file. Semantic type errors remain
 * the `type-gate` plugin's job.
 */
import * as path from 'node:path';

const TS_LIKE = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
/** Skip pathologically large files — the model never writes these in one go. */
const MAX_CHECK_CHARS = 1_500_000;
/** Cap reported errors so a mangled file doesn't flood the context. */
const MAX_ERRORS = 5;

type Ts = typeof import('@typescript/typescript6');

let tsLoad: Promise<Ts | null> | null = null;
/** Lazy-load the TypeScript compiler (already a dependency via the codebase
 *  indexer) so tools that never touch TS files don't pay its import cost. */
function loadTypescript(): Promise<Ts | null> {
  tsLoad ??= import('@typescript/typescript6').then(
    (m) => ((m as unknown as { default?: Ts }).default ?? m) as Ts,
    () => null,
  );
  return tsLoad;
}

export interface SyntaxCheckResult {
  /** Parse errors in the new content (capped at {@link MAX_ERRORS}). */
  errors: string[];
  /** True when the pre-edit content already failed to parse — the edit did
   *  not introduce the breakage (though it didn't fix it either). */
  preExisting: boolean;
}

/**
 * Check `content` for syntax errors based on the file extension.
 * Returns `undefined` when the file type is not checkable (or the checker
 * is unavailable) and a result with an empty `errors` array when clean.
 * Pass `previousContent` to distinguish newly-introduced errors from
 * pre-existing ones.
 */
export async function checkSyntax(
  filePath: string,
  content: string,
  previousContent?: string,
): Promise<SyntaxCheckResult | undefined> {
  if (typeof filePath !== 'string' || typeof content !== 'string') return undefined;
  const errors = await parseErrors(filePath, content);
  if (errors === undefined) return undefined;
  if (errors.length === 0) return { errors, preExisting: false };
  let preExisting = false;
  if (typeof previousContent === 'string') {
    const prevErrors = await parseErrors(filePath, previousContent);
    preExisting = prevErrors !== undefined && prevErrors.length > 0;
  }
  return { errors, preExisting };
}

/** Files that are conventionally JSONC (comments + trailing commas allowed). */
function isJsoncFile(filePath: string): boolean {
  const base = path.basename(filePath).toLowerCase();
  if (base.endsWith('.jsonc')) return true;
  if (/^(tsconfig|jsconfig)([.-].*)?\.json$/.test(base)) return true;
  const dir = path.basename(path.dirname(filePath)).toLowerCase();
  return dir === '.vscode';
}

async function parseErrors(filePath: string, content: string): Promise<string[] | undefined> {
  if (content.length > MAX_CHECK_CHARS) return undefined;
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.json' || ext === '.jsonc') {
    try {
      JSON.parse(content);
      return [];
    } catch (err) {
      // Known-JSONC files (tsconfig.json, VS Code settings, *.jsonc) accept
      // comments and trailing commas — re-parse with the TS config parser
      // before declaring them broken. Plain .json stays strict: a trailing
      // comma there IS an error the model should fix.
      if (isJsoncFile(filePath)) {
        const ts = await loadTypescript();
        if (ts) {
          const jsonc = ts.parseConfigFileTextToJson(filePath, content);
          if (!jsonc.error) return [];
          return [formatDiag(ts, jsonc.error, content)];
        }
      }
      return [`JSON parse error: ${(err as Error).message}`];
    }
  }

  if (!TS_LIKE.has(ext)) return undefined;
  const ts = await loadTypescript();
  if (!ts) return undefined;

  const scriptKind =
    ext === '.tsx'
      ? ts.ScriptKind.TSX
      : ext === '.ts' || ext === '.mts' || ext === '.cts'
        ? ts.ScriptKind.TS
        : // Plain JS may legitimately contain JSX; the JSX grammar is a
          // superset for untyped code, so parsing .js/.jsx as JSX avoids
          // false positives on React files.
          ts.ScriptKind.JSX;

  const sourceFile = ts.createSourceFile(
    path.basename(filePath),
    content,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    scriptKind,
  );
  // parseDiagnostics is not in the public .d.ts but has been the stable
  // home of the parser's syntactic diagnostics for a decade (the public
  // alternative, program.getSyntacticDiagnostics, needs a full Program).
  const diags =
    (
      sourceFile as unknown as {
        parseDiagnostics?: import('@typescript/typescript6').Diagnostic[];
      }
    ).parseDiagnostics ?? [];
  return diags.slice(0, MAX_ERRORS).map((d) => formatDiag(ts, d, content, sourceFile));
}

function formatDiag(
  ts: Ts,
  diag: import('@typescript/typescript6').Diagnostic,
  content: string,
  sourceFile?: import('@typescript/typescript6').SourceFile,
): string {
  const message = ts.flattenDiagnosticMessageText(diag.messageText, ' ');
  if (diag.start === undefined) return message;
  let line: number;
  if (sourceFile) {
    line = sourceFile.getLineAndCharacterOfPosition(diag.start).line + 1;
  } else {
    line = 1;
    for (let i = 0; i < diag.start && i < content.length; i++) {
      if (content.charCodeAt(i) === 0x0a) line++;
    }
  }
  return `line ${line}: ${message}`;
}
