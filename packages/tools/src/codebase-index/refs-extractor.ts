/** Cross-reference extraction for languages not handled by ts-parser.ts. */

import { execFile } from 'node:child_process';
import { rmSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Ref, SymbolLang } from './schema.js';

const GO_REFS_SCRIPT = `package main

import (
  "encoding/json"
  "fmt"
  "go/ast"
  "go/parser"
  "go/token"
  "os"
  "strconv"
)

type Ref struct {
  ToName string \`json:"toName"\`
  CallType string \`json:"callType"\`
  Line int \`json:"line"\`
}

func main() {
  if len(os.Args) < 2 { fmt.Print("[]"); return }
  fset := token.NewFileSet()
  node, err := parser.ParseFile(fset, os.Args[1], nil, 0)
  if err != nil { fmt.Print("[]"); return }
  refs := []Ref{}
  ast.Inspect(node, func(n ast.Node) bool {
    switch expr := n.(type) {
    case *ast.CallExpr:
      line := fset.Position(expr.Pos()).Line
      if ident, ok := expr.Fun.(*ast.Ident); ok {
        refs = append(refs, Ref{ident.Name, "call", line})
      } else if sel, ok := expr.Fun.(*ast.SelectorExpr); ok {
        if ident, ok := sel.X.(*ast.Ident); ok {
          refs = append(refs, Ref{ident.Name + "." + sel.Sel.Name, "call", line})
        }
      }
    case *ast.ImportSpec:
      if expr.Path != nil {
        if importPath, err := strconv.Unquote(expr.Path.Value); err == nil {
          refs = append(refs, Ref{importPath, "import", fset.Position(expr.Pos()).Line})
        }
      }
    }
    return true
  })
  data, err := json.Marshal(refs)
  if err != nil { fmt.Print("[]"); return }
  fmt.Print(string(data))
}
`;

const PY_REFS_SCRIPT = `import ast, json, sys

def name_of(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        parent = name_of(node.value)
        return (parent + "." if parent else "") + node.attr
    if isinstance(node, ast.Subscript):
        return name_of(node.value)
    return ""

try:
    with open(sys.argv[1], "r", encoding="utf-8") as source_file:
        tree = ast.parse(source_file.read())
    refs = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            name = name_of(node.func)
            if name:
                refs.append({"toName": name, "callType": "call", "line": node.lineno})
        elif isinstance(node, ast.Import):
            for alias in node.names:
                refs.append({"toName": alias.name, "callType": "import", "line": node.lineno})
        elif isinstance(node, ast.ImportFrom):
            module = node.module or ""
            for alias in node.names:
                target = module + ("." if module and alias.name else "") + alias.name
                refs.append({"toName": target, "callType": "import", "line": node.lineno})
    print(json.dumps(refs))
except Exception:
    print("[]")
`;

export interface ExtractRefsOptions {
  file: string;
  /** Reserved — not yet consumed by extractRefs. Passed through in callers for future use. */
  content: string;
  lang: SymbolLang;
}

type RunnerRef = { toName: string; callType: Ref['callType']; line: number };

const runnerOptions = {
  timeout: 30_000,
  encoding: 'utf8' as const,
  windowsHide: true,
};

let goRunnerPromise: Promise<{ command: string; argsPrefix: string[] } | null> | undefined;
/**
 * Cached Python interpreter path. Probed once: `python3` preferred, `python`
 * fallback. `null` means neither was found — subsequent calls skip probing.
 */
let pythonCommandPromise: Promise<string | null> | undefined;
let pythonScriptPathPromise: Promise<string | null> | undefined;

function runFile(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, runnerOptions, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

/**
 * Temp directories created by this module, tracked for cleanup on process exit.
 * Every call to `makeTempDir` records the path so `cleanupTempDirs` can reap it.
 */
const tempDirs: string[] = [];

/** Best-effort synchronous cleanup of all tracked temp directories. */
function cleanupTempDirs(): void {
  const dirs = tempDirs.splice(0);
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup — swallow per-dir errors
    }
  }
}

if (process.listenerCount('exit', cleanupTempDirs) === 0) {
  process.on('exit', cleanupTempDirs);
}

/** Create a unique, non-predictable temporary directory owned by this process. */
async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function initializeGoRunner(): Promise<{ command: string; argsPrefix: string[] } | null> {
  goRunnerPromise ??= (async () => {
    try {
      const directory = await makeTempDir('ws-go-refs-');
      const scriptPath = path.join(directory, 'refs.go');
      const executablePath = path.join(directory, 'refs.exe');
      await writeFile(scriptPath, GO_REFS_SCRIPT, 'utf8');
      try {
      await runFile('go', ['build', '-o', executablePath, scriptPath]);
      return { command: executablePath, argsPrefix: [] };
    } catch {
      // Remember the failed compilation so subsequent files go straight to
      // `go run` instead of paying the same failed build cost each time.
      return { command: 'go', argsPrefix: ['run', scriptPath] };
    }
    } catch {
      return null;
    }
  })();
  return goRunnerPromise;
}

/**
 * Resolve the Python interpreter. Tries `python3` first (common on Arch,
 * macOS, Docker), then `python`.  Caches the result so per-file calls
 * don't re-probe.
 */
function resolvePythonCommand(): Promise<string | null> {
  pythonCommandPromise ??= (async () => {
    for (const candidate of ['python3', 'python']) {
      try {
        await new Promise<void>((resolve, reject) => {
          execFile(candidate, ['--version'], { timeout: 5_000, windowsHide: true }, (err) => {
            err ? reject(err) : resolve();
          });
        });
        return candidate;
      } catch {
        continue;
      }
    }
    return null;
  })();
  return pythonCommandPromise;
}

function initializePythonRunner(): Promise<string | null> {
  pythonScriptPathPromise ??= (async () => {
    try {
      const directory = await makeTempDir('ws-py-refs-');
      const scriptPath = path.join(directory, 'refs.py');
      await writeFile(scriptPath, PY_REFS_SCRIPT, 'utf8');
      return scriptPath;
    } catch {
      return null;
    }
  })();
  return pythonScriptPathPromise;
}

function parseRunnerOutput(stdout: string): Ref[] {
  if (!stdout.trim()) return [];
  try {
    const parsed = JSON.parse(stdout.trim()) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((value): Ref[] => {
      const candidate = value as Partial<RunnerRef>;
      if (
        typeof candidate.toName !== 'string' ||
        typeof candidate.line !== 'number' ||
        (candidate.callType !== 'call' && candidate.callType !== 'import')
      ) {
        return [];
      }
      // After the ===/!== checks above, candidate.callType is narrowed to
      // 'call' | 'import', matching Ref['callType'] — no runtime cast needed.
      return [
        {
          fromId: 0,
          toName: candidate.toName,
          callType: candidate.callType,
          line: candidate.line,
        },
      ];
    });
  } catch {
    return [];
  }
}

async function extractGoRefs(filePath: string): Promise<Ref[]> {
  const runner = await initializeGoRunner();
  if (!runner) return [];
  try {
    return parseRunnerOutput(await runFile(runner.command, [...runner.argsPrefix, filePath]));
  } catch {
    return [];
  }
}

async function extractPythonRefs(filePath: string): Promise<Ref[]> {
  const command = await resolvePythonCommand();
  if (!command) return [];
  const scriptPath = await initializePythonRunner();
  if (!scriptPath) return [];
  try {
    return parseRunnerOutput(await runFile(command, [scriptPath, filePath]));
  } catch {
    return [];
  }
}

/** Return refs with `fromId: 0`; the indexer replaces it with the owning symbol id. */
export async function extractRefs(opts: ExtractRefsOptions): Promise<Ref[]> {
  switch (opts.lang) {
    case 'go':
      return extractGoRefs(opts.file);
    case 'py':
      return extractPythonRefs(opts.file);
    default:
      // TS/JS refs are collected during ts-parser's single AST walk.
      return [];
  }
}
