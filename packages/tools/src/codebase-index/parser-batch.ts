/**
 * Batch parsers for the external toolchain languages (Go, Python) — P3.8.
 *
 * The single-file parsers spawn one `go run` / `python` child process per
 * file. For a 400-file Go project that is 400 process spawns, each paying
 * toolchain startup; the spawn gate serializes them, so parse time scales
 * linearly with spawn cost. This module runs the SAME extraction logic over
 * a batch: one child process per chunk of files, sources in over stdin as a
 * JSON array, one JSON envelope out per file.
 *
 * Fallback contract: a file the batch could not parse (per-file error in the
 * envelope, or the chunk itself failing) is simply ABSENT from the returned
 * map — the caller re-parses those files through the single-file parser,
 * which owns the per-language fallback semantics (Go: regex extractor;
 * Python: generic regex only when the runtime is missing). Parity with the
 * per-file path is therefore by construction, not by reimplementation.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveWin32Command } from '../_win32-resolve.js';
import { parseParserBatchOutput } from './parser-output.js';
import type { FileSymbols, SymbolLang } from './schema.js';
import { withSpawnGate } from './spawn-gate.js';

/** Max files per child process. Bounded so one pathological file cannot
 *  poison an unbounded chunk and stdin stays a comfortable pipe size. */
export const MAX_BATCH_FILES = 100;
/** Max cumulative source bytes per child process. */
export const MAX_BATCH_BYTES = 8 * 1024 * 1024;

export interface BatchFile {
  file: string;
  content: string;
  lang: SymbolLang;
}

/** Split a file list into chunks bounded by both file count and total bytes.
 *  Generic so callers' extra per-file fields (e.g. source index) survive. */
export function chunkBatchFiles<T extends BatchFile>(files: readonly T[]): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let bytes = 0;
  for (const file of files) {
    const size = Buffer.byteLength(file.content, 'utf8');
    if (
      current.length > 0 &&
      (current.length >= MAX_BATCH_FILES || bytes + size > MAX_BATCH_BYTES)
    ) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(file);
    bytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** Timeout for one chunk: base plus per-file allowance, capped. */
function batchTimeoutMs(fileCount: number): number {
  return Math.min(120_000, 15_000 + fileCount * 1_500);
}

// ─── Go batch script ─────────────────────────────────────────────────────────

// Same extraction logic as go-parser.ts's single-file script, wrapped in a
// per-file loop over a JSON array of {file, content}.
const GO_BATCH_SCRIPT = `
package main

import (
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io"
	"os"
	"strconv"
	"strings"
)

type Sym struct {
	Name      string \`json:"name"\`
	Kind      string \`json:"kind"\`
	Line      int    \`json:"line"\`
	Col       int    \`json:"col"\`
	Signature string \`json:"signature"\`
	Scope     string \`json:"scope"\`
}

type Ref struct {
	ToName   string \`json:"toName"\`
	CallType string \`json:"callType"\`
	Line     int    \`json:"line"\`
	Module   string \`json:"module"\`
}

type FileResult struct {
	File    string \`json:"file"\`
	Error   string \`json:"error,omitempty"\`
	Symbols []Sym  \`json:"symbols"\`
	Refs    []Ref  \`json:"refs"\`
}

type BatchResult struct {
	Version int          \`json:"version"\`
	Results []FileResult \`json:"results"\`
}

type inputFile struct {
	File    string \`json:"file"\`
	Content string \`json:"content"\`
}

func parseOne(name string, src []byte) FileResult {
	res := FileResult{File: name, Symbols: []Sym{}, Refs: []Ref{}}
	fset := token.NewFileSet()
	node, err := parser.ParseFile(fset, "src.go", src, 0)
	if err != nil {
		res.Error = err.Error()
		return res
	}
	pkgScope := node.Name.Name
	for _, decl := range node.Decls {
		switch d := decl.(type) {
		case *ast.FuncDecl:
			symName := d.Name.Name
			kind := "function"
			scope := pkgScope
			if d.Recv != nil && len(d.Recv.List) > 0 {
				scope = pkgScope + "." + recvTypeName(d.Recv.List[0].Type) + "." + symName
				kind = "method"
			} else {
				scope = pkgScope + "." + symName
			}
			pos := fset.Position(d.Pos())
			res.Symbols = append(res.Symbols, Sym{Name: symName, Kind: kind, Line: pos.Line, Col: pos.Column, Signature: formatFuncSig(d), Scope: scope})
		case *ast.GenDecl:
			for _, spec := range d.Specs {
				switch s := spec.(type) {
				case *ast.TypeSpec:
					typeName := s.Name.Name
					pos := fset.Position(s.Pos())
					sig := "type " + typeName
					if s.TypeParams != nil {
						sig += formatTypeParams(s.TypeParams)
					}
					if st, ok := s.Type.(*ast.StructType); ok {
						sig += " = struct { " + formatFields(st.Fields.List) + " }"
					} else if it, ok := s.Type.(*ast.InterfaceType); ok {
						sig += " = interface { " + formatMethods(it.Methods.List) + " }"
					} else {
						sig += " = " + formatType(s.Type)
					}
					res.Symbols = append(res.Symbols, Sym{Name: typeName, Kind: "type", Line: pos.Line, Col: pos.Column, Signature: sig, Scope: pkgScope})
				case *ast.ValueSpec:
					for _, n := range s.Names {
						valueName := n.Name
						pos := fset.Position(n.Pos())
						kind := "var"
						if d.Tok == token.CONST {
							kind = "const"
						}
						sig := kind + " " + valueName
						if s.Type != nil {
							sig += " " + formatType(s.Type)
						}
						res.Symbols = append(res.Symbols, Sym{Name: valueName, Kind: kind, Line: pos.Line, Col: pos.Column, Signature: sig, Scope: pkgScope})
					}
				}
			}
		}
	}
	ast.Inspect(node, func(n ast.Node) bool {
		switch expr := n.(type) {
		case *ast.CallExpr:
			line := fset.Position(expr.Pos()).Line
			switch fun := expr.Fun.(type) {
			case *ast.Ident:
				res.Refs = append(res.Refs, Ref{ToName: fun.Name, CallType: "call", Line: line})
			case *ast.SelectorExpr:
				res.Refs = append(res.Refs, Ref{ToName: fun.Sel.Name, CallType: "call", Line: line})
			}
		case *ast.ImportSpec:
			if expr.Path != nil {
				if importPath, uerr := strconv.Unquote(expr.Path.Value); uerr == nil {
					line := fset.Position(expr.Pos()).Line
					name := importPath
					if idx := strings.LastIndex(importPath, "/"); idx >= 0 {
						name = importPath[idx+1:]
					}
					res.Refs = append(res.Refs, Ref{ToName: name, CallType: "import", Line: line, Module: importPath})
				}
			}
		}
		return true
	})
	return res
}

func main() {
	raw, err := io.ReadAll(os.Stdin)
	if err != nil {
		out, _ := json.Marshal(BatchResult{Version: 1, Results: []FileResult{}})
		fmt.Print(string(out))
		return
	}
	var inputs []inputFile
	if err := json.Unmarshal(raw, &inputs); err != nil {
		out, _ := json.Marshal(BatchResult{Version: 1, Results: []FileResult{}})
		fmt.Print(string(out))
		return
	}
	results := make([]FileResult, 0, len(inputs))
	for _, in := range inputs {
		results = append(results, parseOne(in.File, []byte(in.Content)))
	}
	data, err := json.Marshal(BatchResult{Version: 1, Results: results})
	if err != nil {
		fmt.Print("{\\"version\\":1,\\"results\\":[]}")
		return
	}
	fmt.Print(string(data))
}

func recvTypeName(t ast.Expr) string {
	switch v := t.(type) {
	case *ast.Ident:
		return v.Name
	case *ast.StarExpr:
		return recvTypeName(v.X)
	default:
		return "?"
	}
}

func formatFuncSig(d *ast.FuncDecl) string {
	scope := ""
	if d.Recv != nil && len(d.Recv.List) > 0 {
		scope = "(" + formatFieldList(d.Recv.List) + ") "
	}
	scope += formatFuncType(d.Type)
	return "func " + scope
}

func formatFuncType(f *ast.FuncType) string {
	params := formatFieldList(f.Params.List)
	results := ""
	if f.Results != nil {
		results = " -> " + formatFieldList(f.Results.List)
	}
	return params + results
}

func formatFieldList(fields []*ast.Field) string {
	if len(fields) == 0 {
		return "()"
	}
	names := make([]string, 0, len(fields))
	for _, f := range fields {
		name := ""
		if len(f.Names) > 0 {
			name = f.Names[0].Name
		}
		t := formatType(f.Type)
		if name != "" {
			names = append(names, name+" "+t)
		} else {
			names = append(names, t)
		}
	}
	return "(" + strings.Join(names, ", ") + ")"
}

func formatFields(fields []*ast.Field) string {
	lines := make([]string, 0)
	for _, f := range fields {
		name := ""
		if len(f.Names) > 0 {
			name = f.Names[0].Name
		}
		t := formatType(f.Type)
		if name != "" {
			lines = append(lines, name+" "+t)
		} else {
			lines = append(lines, t)
		}
	}
	return strings.Join(lines, "; ")
}

func formatMethods(fields []*ast.Field) string {
	return formatFields(fields)
}

func formatTypeParams(tp *ast.FieldList) string {
	if tp == nil || len(tp.List) == 0 {
		return ""
	}
	params := make([]string, len(tp.List))
	for i, p := range tp.List {
		if len(p.Names) > 0 {
			params[i] = p.Names[0].Name
		} else {
			params[i] = "T"
		}
	}
	return "[" + strings.Join(params, ", ") + "]"
}

func formatType(t ast.Expr) string {
	if t == nil {
		return "?"
	}
	switch v := t.(type) {
	case *ast.Ident:
		return v.Name
	case *ast.SelectorExpr:
		return formatType(v.X) + "." + v.Sel.Name
	case *ast.StarExpr:
		return "*" + formatType(v.X)
	case *ast.ArrayType:
		if v.Len == nil {
			return "[]" + formatType(v.Elt)
		}
		return "[...]" + formatType(v.Elt)
	case *ast.MapType:
		return "map[" + formatType(v.Key) + "]" + formatType(v.Value)
	case *ast.InterfaceType:
		return "interface{}"
	case *ast.StructType:
		return "struct{}"
	case *ast.FuncType:
		return formatFuncType(v)
	case *ast.ChanType:
		return "chan " + formatType(v.Value)
	case *ast.BasicLit:
		return v.Value
	case *ast.IndexExpr:
		return formatType(v.X) + "[" + formatType(v.Index) + "]"
	case *ast.IndexListExpr:
		args := make([]string, len(v.Indices))
		for i, idx := range v.Indices {
			args[i] = formatType(idx)
		}
		return formatType(v.X) + "[" + strings.Join(args, ", ") + "]"
	default:
		return "?"
	}
}
`;

// ─── Python batch script ─────────────────────────────────────────────────────

// Same extraction logic as py-parser.ts's single-file script, wrapped in a
// per-file loop. The visitor appends into per-file lists passed in.
const PY_BATCH_SCRIPT = `import ast, json, sys

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

def leaf_name(node):
    if isinstance(node, ast.Attribute):
        return node.attr
    if isinstance(node, ast.Name):
        return node.id
    return get_name(node).split(".")[-1]

def is_private(name):
    return name.startswith("__") and not name.endswith("__")

def parse_one(name, source, module_name):
    result = {"file": name, "symbols": [], "refs": []}
    try:
        tree = ast.parse(source, filename=name)
    except Exception as e:
        result["error"] = str(e)
        return result
    syms = []
    refs = []
    scope_stack = [module_name]

    def sym(d):
        return {
            "name": d["name"], "kind": d["kind"], "line": d["line"], "col": d["col"],
            "signature": d["signature"], "scope": d["scope"],
        }

    class Visitor(ast.NodeVisitor):
        def visit_ClassDef(self, node):
            bases = [get_name(b) for b in node.bases]
            sig = "class " + node.name
            if bases:
                sig += "(" + ", ".join(bases) + ")"
            sig += ": ..."
            syms.append(sym({
                "name": node.name, "kind": "class", "line": node.lineno,
                "col": node.col_offset, "signature": sig,
                "scope": ".".join(scope_stack) + "." + node.name,
            }))
            scope_stack.append(node.name)
            self.generic_visit(node)
            scope_stack.pop()

        def visit_FunctionDef(self, node):
            args = ", ".join(a.arg for a in node.args.args)
            returns = get_name(node.returns) if node.returns is not None else ""
            is_async = isinstance(node, ast.AsyncFunctionDef)
            kind = "function"
            prefix = "def "
            for dec in node.decorator_list:
                d = get_name(dec)
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
            syms.append(sym({
                "name": node.name, "kind": kind, "line": node.lineno,
                "col": node.col_offset, "signature": sig,
                "scope": ".".join(scope_stack) + "." + node.name,
            }))

        def visit_AsyncFunctionDef(self, node):
            self.visit_FunctionDef(node)

        def visit_Assign(self, node):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    tname = target.id
                    if is_private(tname):
                        continue
                    kind = "const" if tname.isupper() else "var"
                    col = target.col_offset if hasattr(target, "col_offset") else 0
                    syms.append(sym({
                        "name": tname, "kind": kind, "line": node.lineno, "col": col,
                        "signature": f"{tname} = ...", "scope": ".".join(scope_stack),
                    }))

        def visit_AnnAssign(self, node):
            if isinstance(node.target, ast.Name):
                tname = node.target.id
                if is_private(tname):
                    return
                kind = "const" if tname.isupper() else "var"
                col = node.target.col_offset if hasattr(node.target, "col_offset") else 0
                sig = f"{tname}: {get_name(node.annotation)}"
                if node.value:
                    sig += " = ..."
                syms.append(sym({
                    "name": tname, "kind": kind, "line": node.lineno, "col": col,
                    "signature": sig, "scope": ".".join(scope_stack),
                }))

        def visit_Import(self, node):
            # Parity with the single-file parser: imports are symbols too.
            for alias in node.names:
                name = alias.asname or alias.name
                syms.append(sym({
                    "name": name, "kind": "import", "line": node.lineno,
                    "col": node.col_offset, "signature": f"import {alias.name}",
                    "scope": ".".join(scope_stack),
                }))

        def visit_ImportFrom(self, node):
            module = node.module or ""
            for alias in node.names:
                name = alias.asname or alias.name
                syms.append(sym({
                    "name": name, "kind": "import", "line": node.lineno,
                    "col": node.col_offset, "signature": f"from {module} import {alias.name}",
                    "scope": ".".join(scope_stack),
                }))

    Visitor().visit(tree)

    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            cname = leaf_name(node.func)
            if cname:
                refs.append({"toName": cname, "callType": "call", "line": node.lineno})
        elif isinstance(node, ast.Import):
            for alias in node.names:
                refs.append({
                    "toName": alias.name.split(".")[-1], "callType": "import",
                    "line": node.lineno, "module": alias.name,
                })
        elif isinstance(node, ast.ImportFrom):
            module = ("." * (node.level or 0)) + (node.module or "")
            for alias in node.names:
                refs.append({
                    "toName": alias.name, "callType": "import",
                    "line": node.lineno, "module": module,
                })
        elif isinstance(node, ast.ClassDef):
            for base in node.bases:
                bname = leaf_name(base)
                if bname:
                    refs.append({"toName": bname, "callType": "inherit", "line": node.lineno})

    result["symbols"] = syms
    result["refs"] = refs
    return result

def main():
    try:
        inputs = json.loads(sys.stdin.read())
    except Exception:
        print(json.dumps({"version": 1, "results": []}))
        return
    results = []
    for entry in inputs:
        name = entry.get("file", "")
        module_name = name.rsplit("/", 1)[-1].rsplit("\\\\", 1)[-1][:-3]
        results.append(parse_one(name, entry.get("content", ""), module_name))
    print(json.dumps({"version": 1, "results": results}))

main()
`;

// ─── Child process plumbing ──────────────────────────────────────────────────

let _goBatchScriptPath: string | null = null;
let _pyBatchScriptPath: string | null = null;

/**
 * Test-only: the cached batch-script paths. The security regression test
 * observes WHERE the scripts were written without needing a toolchain —
 * a missing binary still leaves the (already-created) path cached.
 */
export function __batchScriptPathsForTest(): { go: string | null; py: string | null } {
  return { go: _goBatchScriptPath, py: _pyBatchScriptPath };
}

/**
 * Write the toolchain batch script to a PRIVATE, UNPREDICTABLE directory.
 *
 * Security (Chimera High): the previous fixed path — `os.tmpdir()/ws-go-parse`
 * via `mkdir(recursive)` + `writeFile` — was predictable. A local attacker
 * could pre-create the directory and symlink `batch.go`/`batch.py` to a
 * victim-writable file; our `writeFile` would follow the link and overwrite
 * the target, and `go run`/`python` would execute whatever the attacker left
 * at the path. `fs.mkdtemp` creates the directory with a random,
 * attacker-unpredictable suffix (0700 on POSIX), so neither pre-creation nor
 * symlink planting is possible. The directory is per-process (the module
 * caches one path), so concurrent wstack processes never share it.
 */
async function ensureScriptPath(
  cached: string | null,
  prefix: string,
  fileName: string,
  script: string,
): Promise<{ path: string; wrote: boolean }> {
  if (cached) return { path: cached, wrote: false };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const scriptPath = path.join(dir, fileName);
  // 'x' (O_EXCL): fail if the file somehow already exists — never follow a
  // pre-existing symlink, even inside our own private directory.
  await fs.writeFile(scriptPath, script, { encoding: 'utf8', flag: 'wx' });
  // Hygiene (Chimera medium): each process creates its own random dir; without
  // an exit hook those accumulate in tmp across invocations. Best-effort — a
  // SIGKILL leaves the dir behind, which the OS temp sweep eventually reaps.
  process.once('exit', () => {
    try {
      fsSync.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  });
  return { path: scriptPath, wrote: true };
}

function runToolchainChild(
  binary: string,
  args: string[],
  stdinPayload: string,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string } | null> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let proc: ChildProcess;
    try {
      proc = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch {
      resolve(null);
      return;
    }
    const finish = (value: { code: number | null; stdout: string } | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      finish(null);
    }, timeoutMs);
    timer.unref?.();
    proc.on('error', () => finish(null));
    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr?.resume();
    proc.stdin?.on('error', () => {
      /* EPIPE racing close — finish resolves via close */
    });
    proc.stdin?.write(stdinPayload);
    proc.stdin?.end();
    proc.on('close', (code) => finish({ code, stdout }));
  });
}

// ─── Public batch APIs ───────────────────────────────────────────────────────

/**
 * Parse a chunk of Go files with ONE `go run` invocation.
 * Returns per-file results; files absent from the map failed and the caller
 * falls back to the single-file parser.
 */
export async function runGoBatch(
  files: readonly BatchFile[],
  goBinary?: string,
): Promise<Map<string, FileSymbols>> {
  const out = new Map<string, FileSymbols>();
  if (files.length === 0) return out;

  const { path: scriptPath } = await ensureScriptPath(
    _goBatchScriptPath,
    'ws-go-parse',
    'batch.go',
    GO_BATCH_SCRIPT,
  );
  _goBatchScriptPath = scriptPath;

  const payload = JSON.stringify(files.map((f) => ({ file: f.file, content: f.content })));
  const result = await withSpawnGate(() =>
    runToolchainChild(
      goBinary ?? resolveWin32Command('go'),
      ['run', scriptPath],
      payload,
      batchTimeoutMs(files.length),
    ),
  );
  if (result?.code !== 0 || !result.stdout.trim()) return out;

  for (const entry of parseParserBatchOutput(result.stdout, 'go')) {
    if (entry.error !== undefined) continue;
    out.set(entry.file, {
      file: entry.file,
      lang: 'go',
      symbols: entry.symbols.map((s) => ({
        id: 0,
        lang: 'go' as const,
        kind: s.kind as FileSymbols['symbols'][number]['kind'],
        name: s.name,
        file: entry.file,
        line: s.line,
        col: s.col,
        signature: s.signature ?? '',
        docComment: '',
        scope: s.scope ?? '',
        text: `${s.name} ${s.signature ?? ''}`.trim(),
      })),
      refs: entry.refs,
      mtimeMs: Date.now(),
    });
  }
  return out;
}

/**
 * Parse a chunk of Python files with ONE interpreter invocation.
 * Same contract as {@link runGoBatch}; `pythonBinary` is the cached resolver
 * from py-parser.ts so both paths agree on which interpreter runs.
 */
export async function runPyBatch(
  files: readonly BatchFile[],
  pythonBinary: string,
): Promise<Map<string, FileSymbols>> {
  const out = new Map<string, FileSymbols>();
  if (files.length === 0) return out;

  const { path: scriptPath } = await ensureScriptPath(
    _pyBatchScriptPath,
    'ws-py-parse',
    'batch.py',
    PY_BATCH_SCRIPT,
  );
  _pyBatchScriptPath = scriptPath;

  const payload = JSON.stringify(files.map((f) => ({ file: f.file, content: f.content })));
  const result = await withSpawnGate(() =>
    runToolchainChild(pythonBinary, [scriptPath], payload, batchTimeoutMs(files.length)),
  );
  if (result?.code !== 0 || !result.stdout.trim()) return out;

  for (const entry of parseParserBatchOutput(result.stdout, 'py')) {
    if (entry.error !== undefined) continue;
    out.set(entry.file, {
      file: entry.file,
      lang: 'py',
      symbols: entry.symbols.map((s) => ({
        id: 0,
        lang: 'py' as const,
        kind: s.kind as FileSymbols['symbols'][number]['kind'],
        name: s.name,
        file: entry.file,
        line: s.line,
        col: s.col,
        signature: s.signature ?? '',
        docComment: '',
        scope: s.scope ?? '',
        text: `${s.name} ${s.signature ?? ''}`.trim(),
      })),
      refs: entry.refs,
      mtimeMs: Date.now(),
    });
  }
  return out;
}
