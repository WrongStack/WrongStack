/**
 * Python source symbol extraction using the `ast` module.
 *
 * Spawns a `python -c` child process that parses the file with Python's `ast`
 * module and emits JSON. Falls back to empty results on any error.
 *
 * Extracts: class, function, async function, const, var, import, import_from
 */

import { type ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveWin32Command } from '../_win32-resolve.js';
import { parseGeneric } from './generic-parser.js';
import { parseParserOutput } from './parser-output.js';
import type { FileSymbols, Symbol as IndexSymbol, SymbolLang } from './schema.js';
import { withSpawnGate } from './spawn-gate.js';

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Prefer Python's `ast` when a runtime is available. When Python is missing
 * or the spawn fails, fall back to the generic regex extractor so `.py` files
 * still enter the index instead of being silently empty.
 *
 * Syntax errors from a working Python still return zero symbols (ast cannot
 * recover) — that is intentional correctness, not a gap in coverage.
 */
export async function parseSymbols(opts: {
  file: string;
  content: string;
  lang: SymbolLang;
}): Promise<FileSymbols> {
  const { file, content, lang } = opts;

  try {
    // Serialize python child processes process-wide (CPU/spawn cimriliği).
    const native = await withSpawnGate(() => syncPyParse(file, content, lang));
    if (native !== null) return native;
  } catch {
    /* fall through to generic */
  }
  return parseGeneric({ file, content, lang: lang === 'py' ? 'py' : lang });
}

export { detectLang } from './languages.js';

// ─── Inline Python parser script ────────────────────────────────────────────

const PY_PARSE_SCRIPT = `import ast, json, sys, os

def get_name(node):
    if isinstance(node, ast.Name):
        return node.id
    elif isinstance(node, ast.Attribute):
        return get_name(node.value) + "." + node.attr
    elif isinstance(node, ast.Subscript):
        return get_name(node.value)
    elif isinstance(node, ast.Call):
        return get_name(node.func)
    elif isinstance(node, ast.Constant):
        return str(node.value)
    return ""

def get_decorators(node):
    decs = []
    for dec in node.decorator_list:
        decs.append(get_name(dec))
    return decs

def get_bases(node):
    bases = []
    for base in node.bases:
        bases.append(get_name(base))
    return bases

def get_args(args):
    parts = []
    for arg in args.args:
        parts.append(arg.arg)
    return ", ".join(parts)

def get_returns(node):
    if node.returns is None:
        return ""
    return get_name(node.returns)

class Sym:
    def __init__(self, name, kind, line, col, signature, scope):
        self.name = name
        self.kind = kind
        self.line = line
        self.col = col
        self.signature = signature
        self.scope = scope
    def to_dict(self):
        return {
            "name": self.name,
            "kind": self.kind,
            "line": self.line,
            "col": self.col,
            "signature": self.signature,
            "scope": self.scope,
        }

def is_private(name):
    return name.startswith("__") and not name.endswith("__")

def leaf_name(node):
    # Declared name of the callee: \`join\` of \`os.path.join\`. Matches how the
    # TypeScript and Go extractors record call refs, so resolution behaves the
    # same across languages.
    if isinstance(node, ast.Attribute):
        return node.attr
    if isinstance(node, ast.Name):
        return node.id
    return get_name(node).split(".")[-1]

syms = []
refs = []
errors = []

try:
    source = sys.stdin.read()
    tree = ast.parse(source, filename=sys.argv[1])
except Exception as e:
    errors.append(str(e))
    print(json.dumps({"symbols": [], "refs": []}))
    sys.exit(0)

# Module-level scope
module_scope = os.path.basename(sys.argv[1])[:-3]  # strip .py

class ModuleVisitor(ast.NodeVisitor):
    def __init__(self):
        self.scope_stack = [module_scope]

    def visit_ClassDef(self, node):
        bases = get_bases(node)
        decs = get_decorators(node)
        sig = "class " + node.name
        if bases:
            sig += "(" + ", ".join(bases) + ")"
        sig += ": ..."
        syms.append(Sym(
            name=node.name,
            kind="class",
            line=node.lineno,
            col=node.col_offset,
            signature=sig,
            scope=".".join(self.scope_stack) + "." + node.name,
        ))
        self.scope_stack.append(node.name)
        self.generic_visit(node)
        self.scope_stack.pop()

    def visit_FunctionDef(self, node):
        decs = get_decorators(node)
        args = get_args(node.args)
        returns = get_returns(node)
        is_async = isinstance(node, ast.AsyncFunctionDef)

        kind = "function"
        prefix = "def "
        if decs:
            for d in decs:
                if d.endswith(".staticmethod"):
                    kind = "staticmethod"
                elif d.endswith(".classmethod"):
                    kind = "classmethod"
                elif d == "property":
                    kind = "property"

        if is_async:
            kind = "async_" + kind

        sig = f"{prefix}{node.name}({args})"
        if returns:
            sig += f" -> {returns}"
        scope = ".".join(self.scope_stack) + "." + node.name

        syms.append(Sym(
            name=node.name,
            kind=kind,
            line=node.lineno,
            col=node.col_offset,
            signature=sig,
            scope=scope,
        ))
        # Don't descend into function bodies to avoid local symbols
        # self.generic_visit(node)

    def visit_AsyncFunctionDef(self, node):
        # Treat as function
        self.visit_FunctionDef(node)

    def visit_Assign(self, node):
        for target in node.targets:
            if isinstance(target, ast.Name):
                name = target.id
                if is_private(name):
                    continue
                # Infer constness from UPPER_CASE naming
                kind = "const" if name.isupper() else "var"
                col = target.col_offset if hasattr(target, 'col_offset') else 0
                syms.append(Sym(
                    name=name,
                    kind=kind,
                    line=node.lineno,
                    col=col,
                    signature=f"{name} = ...",
                    scope=".".join(self.scope_stack),
                ))

    def visit_AnnAssign(self, node):
        if isinstance(node.target, ast.Name):
            name = node.target.id
            if is_private(name):
                return
            kind = "const" if name.isupper() else "var"
            col = node.target.col_offset if hasattr(node.target, 'col_offset') else 0
            sig = f"{name}: {get_name(node.annotation)}"
            if node.value:
                sig += " = ..."
            syms.append(Sym(
                name=name,
                kind=kind,
                line=node.lineno,
                col=col,
                signature=sig,
                scope=".".join(self.scope_stack),
            ))

    def visit_Import(self, node):
        for alias in node.names:
            name = alias.asname or alias.name
            syms.append(Sym(
                name=name,
                kind="import",
                line=node.lineno,
                col=node.col_offset,
                signature=f"import {alias.name}",
                scope=".".join(self.scope_stack),
            ))

    def visit_ImportFrom(self, node):
        module = node.module or ""
        for alias in node.names:
            name = alias.asname or alias.name
            syms.append(Sym(
                name=name,
                kind="import",
                line=node.lineno,
                col=node.col_offset,
                signature=f"from {module} import {alias.name}",
                scope=".".join(self.scope_stack),
            ))

visitor = ModuleVisitor()
visitor.visit(tree)

# Refs need a separate full walk: ModuleVisitor deliberately does not descend
# into function bodies (it would index locals as symbols), but that is exactly
# where the calls are.
for node in ast.walk(tree):
    if isinstance(node, ast.Call):
        name = leaf_name(node.func)
        if name:
            refs.append({"toName": name, "callType": "call", "line": node.lineno})
    elif isinstance(node, ast.Import):
        for alias in node.names:
            refs.append({
                "toName": alias.name.split(".")[-1],
                "callType": "import",
                "line": node.lineno,
                "module": alias.name,
            })
    elif isinstance(node, ast.ImportFrom):
        # PEP 328: node.level is the number of leading dots. Preserving them is
        # what lets the resolver walk up from the importing file's package —
        # dropping them made \`from .foo import X\` indistinguishable from an
        # absolute \`foo\`.
        module = ("." * (node.level or 0)) + (node.module or "")
        for alias in node.names:
            refs.append({
                "toName": alias.name,
                "callType": "import",
                "line": node.lineno,
                "module": module,
            })
    elif isinstance(node, ast.ClassDef):
        for base in node.bases:
            name = leaf_name(base)
            if name:
                refs.append({"toName": name, "callType": "inherit", "line": node.lineno})

print(json.dumps({"symbols": [s.to_dict() for s in syms], "refs": refs}))
`;

// ─── Synchronous Python parse via child process ─────────────────────────────

/**
 * Cross-platform Python binary resolver.
 *
 * Windows: walks PATHEXT via `resolveWin32Command` (handles .exe/.cmd/.bat).
 *          A match means a real file on disk — return it immediately.
 * macOS / Linux: `resolveWin32Command` is a pass-through. We asynchronously
 *          verify each candidate with `--version`, cached for the process lifetime.
 *
 * Candidates in priority order:
 *   Windows:  python3 → python → py (Python launcher)
 *   Unix:     python3 → python
 */
async function resolvePython(): Promise<string | null> {
  const candidates =
    process.platform === 'win32' ? ['python3', 'python', 'py'] : ['python3', 'python'];
  for (const name of candidates) {
    const resolved = resolveWin32Command(name);
    // On Windows: verify even if resolveWin32Command found a
    // file — the WindowsApps redirector stub (python3.exe) passes the
    // accessSync check but exits with code 9009 (app not found).
    if (!(await commandIsAvailable(resolved))) continue;
    return resolved;
  }
  return null;
}

function commandIsAvailable(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const proc = spawn(command, ['--version'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const finish = (available: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(available);
    };
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      finish(false);
    }, 5_000);
    timer.unref?.();
    proc.once('error', () => finish(false));
    proc.once('close', (code) => finish(code === 0));
  });
}

/**
 * Spawn the Python parser child process with proper error handling.
 *
 * Returns a promise that resolves to { code, stdout } or rejects with an
 * Error (ENOENT, timeout, spawn error) that the caller converts to empty
 * results. The 'error' event listener is critical: without it, a spawn
 * ENOENT on Windows crashes as an unhandled exception because
 * ChildProcess emits 'error' asynchronously and the Promise.race only
 * listens on 'close'.
 */
function spawnPyParser(
  pyBinary: string,
  scriptPath: string,
  filePath: string,
  content: string,
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const proc: ChildProcess = spawn(pyBinary, [scriptPath, filePath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    // Mandatory: catch ENOENT / permission-denied / spawn failures.
    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });

    // Write source content via stdin so the child doesn't reopen the file.
    proc.stdin?.write(content);
    proc.stdin?.end();

    let stdout = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    // Discard stderr to avoid backpressure deadlocks when Python emits
    // warnings (e.g. deprecation notices).
    proc.stderr?.resume();

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill('SIGKILL');
      reject(new Error('timeout'));
    }, 15_000);
    timer.unref?.();

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout });
    });
  });
}

// Cache the temp script path + resolved Python binary so we don't rewrite
// or re-resolve on every file.
let _cachedScriptPath: string | null = null;
let cachedPyBinary: Promise<string | null> | undefined;

/**
 * The resolved Python binary (or null when no runtime is available).
 * Shared with the P3.8 batch parser so both paths run the same interpreter.
 */
export function resolvePythonBinary(): Promise<string | null> {
  cachedPyBinary ??= resolvePython();
  return cachedPyBinary;
}

/**
 * Run the real Python AST parser.
 * - `null` → Python unavailable / spawn failed → caller should use generic fallback
 * - `FileSymbols` → Python ran (even if the file was invalid → empty symbols)
 */
async function syncPyParse(
  filePath: string,
  content: string,
  lang: SymbolLang,
): Promise<FileSymbols | null> {
  try {
    // Write the parser script once per process — not per file.
    // Passing the whole 200-line program via `python -c "..."` breaks
    // under cmd.exe on Windows (embedded newlines truncate the command).
    // A real file sidesteps all quoting and can be reused across calls.
    if (!_cachedScriptPath) {
      const tmpDir = path.join(os.tmpdir(), 'ws-py-parse');
      await fs.mkdir(tmpDir, { recursive: true });
      _cachedScriptPath = path.join(tmpDir, 'parse.py');
      await fs.writeFile(_cachedScriptPath, PY_PARSE_SCRIPT, 'utf8');
    }

    // Resolve Python binary once (expensive: walks PATH on Windows).
    cachedPyBinary ??= resolvePython();
    const pyBinary = await cachedPyBinary;
    if (!pyBinary) return null;

    // argv-array form: no shell, so a hostile filename cannot inject commands.
    // Content is piped via stdin — avoids a second file read in the child.
    const { code, stdout } = await spawnPyParser(pyBinary, _cachedScriptPath, filePath, content);

    if (code !== 0 || !stdout.trim()) {
      // Python ran but AST parse failed (syntax error) — empty, not fallback.
      return { file: filePath, lang, symbols: [], mtimeMs: Date.now() };
    }

    const { symbols: raw, refs } = parseParserOutput(stdout, lang);
    const symbols: IndexSymbol[] = raw.map((s) => ({
      id: 0,
      lang,
      kind: s.kind as IndexSymbol['kind'],
      name: s.name,
      file: filePath,
      line: s.line,
      col: s.col,
      signature: s.signature ?? '',
      docComment: '',
      scope: s.scope ?? '',
      text: `${s.name} ${s.signature ?? ''}`.trim(),
    }));
    return { file: filePath, lang, symbols, refs, mtimeMs: Date.now() };
  } catch {
    // Spawn/IO failure → generic fallback.
    return null;
  }
}
