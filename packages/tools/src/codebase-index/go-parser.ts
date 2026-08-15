/**
 * Go source symbol extraction using `go/parser`.
 *
 * Spawns a `go run -` child process that parses the file with go/ast and
 * emits JSON. Falls back to empty results on any error.
 *
 * Extracts: package, func, type, const, var
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { resolveWin32Command } from '../_win32-resolve.js';
import { parseParserOutput } from './parser-output.js';
import type { FileSymbols, Symbol as IndexSymbol, SymbolLang } from './schema.js';
import { withSpawnGate } from './spawn-gate.js';

// ─── Public API ─────────────────────────────────────────────────────────────

export async function parseSymbols(opts: {
  file: string;
  content: string;
  lang: SymbolLang;
}): Promise<FileSymbols> {
  const { file, content, lang } = opts;

  try {
    // Serialize go child processes process-wide (same gate as Python).
    const parsed = await withSpawnGate(() => syncGoParse(file, content, lang));
    if (parsed.symbols.length > 0) {
      return parsed;
    }
    // No symbols means the toolchain is missing or the file failed to parse.
    // Keep any refs the run did produce rather than discarding them with it.
    const fallback = fallbackParse(file, content, lang);
    return parsed.refs?.length ? { ...fallback, refs: parsed.refs } : fallback;
  } catch {
    /* v8 ignore next -- syncGoParse has its own catch; this outer guard is defensive. */
    return fallbackParse(file, content, lang);
  }
}

export { detectLang } from './languages.js';

// ─── Lightweight fallback parser ────────────────────────────────────────────

function fallbackParse(filePath: string, content: string, lang: SymbolLang): FileSymbols {
  if (!/^\s*package\s+[A-Za-z_]\w*/m.test(content) || hasUnbalancedDelimiters(content)) {
    return { file: filePath, lang, symbols: [], mtimeMs: Date.now() };
  }

  const symbols: IndexSymbol[] = [];
  const packageName = content.match(/^\s*package\s+([A-Za-z_]\w*)/m)?.[1] ?? '';
  const lines = content.split(/\r?\n/);
  for (const [idx, line] of lines.entries()) {
    const trimmed = line.trimStart();
    const col = line.length - trimmed.length + 1;
    const fn = /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/.exec(trimmed);
    if (fn?.[1]) {
      addFallbackSymbol(symbols, {
        filePath,
        lang,
        kind: trimmed.startsWith('func (') ? 'method' : 'function',
        name: fn[1],
        line: idx + 1,
        col,
        signature: trimmed,
        scope: packageName ? `${packageName}.${fn[1]}` : fn[1],
      });
      continue;
    }

    const typeDecl = /^type\s+([A-Za-z_]\w*)\b/.exec(trimmed);
    if (typeDecl?.[1]) {
      addFallbackSymbol(symbols, {
        filePath,
        lang,
        kind: 'type',
        name: typeDecl[1],
        line: idx + 1,
        col,
        signature: trimmed,
        scope: packageName,
      });
      continue;
    }

    const valueDecl = /^(const|var)\s+([A-Za-z_]\w*)\b/.exec(trimmed);
    if (valueDecl?.[1] && valueDecl[2]) {
      addFallbackSymbol(symbols, {
        filePath,
        lang,
        kind: valueDecl[1] as 'const' | 'var',
        name: valueDecl[2],
        line: idx + 1,
        col,
        signature: trimmed,
        scope: packageName,
      });
    }
  }

  return { file: filePath, lang, symbols, mtimeMs: Date.now() };
}

function addFallbackSymbol(
  symbols: IndexSymbol[],
  opts: {
    filePath: string;
    lang: SymbolLang;
    kind: IndexSymbol['kind'];
    name: string;
    line: number;
    col: number;
    signature: string;
    scope: string;
  },
): void {
  symbols.push({
    id: 0,
    lang: opts.lang,
    kind: opts.kind,
    name: opts.name,
    file: opts.filePath,
    line: opts.line,
    col: opts.col,
    signature: opts.signature,
    docComment: '',
    scope: opts.scope,
    text: `${opts.name} ${opts.signature}`.trim(),
  });
}

function hasUnbalancedDelimiters(content: string): boolean {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const closers = new Set(Object.values(pairs));
  const stack: string[] = [];
  for (const ch of content) {
    if (pairs[ch]) {
      stack.push(pairs[ch]);
    } else if (closers.has(ch) && stack.pop() !== ch) {
      return true;
    }
  }
  return stack.length > 0;
}

// ─── Inline Go parser script ────────────────────────────────────────────────

const GO_PARSE_SCRIPT = `
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

// Ref is a cross-reference emitted alongside the symbols, so one \`go run\`
// yields both. Module is the import path for CallType "import", else empty.
type Ref struct {
	ToName   string \`json:"toName"\`
	CallType string \`json:"callType"\`
	Line     int    \`json:"line"\`
	Module   string \`json:"module"\`
}

type Result struct {
	Symbols []Sym \`json:"symbols"\`
	Refs    []Ref \`json:"refs"\`
}

func emptyResult() string {
	return "{\\"symbols\\":[],\\"refs\\":[]}"
}

func main() {
	src, err := io.ReadAll(os.Stdin)
	if err != nil {
		fmt.Print(emptyResult())
		return
	}
	fset := token.NewFileSet()
	node, err := parser.ParseFile(fset, "src.go", src, 0)
	if err != nil {
		fmt.Print(emptyResult())
		return
	}

	var syms []Sym

	// Package-level scope
	pkgScope := node.Name.Name

	// Collect all top-level declarations
	for _, decl := range node.Decls {
		switch d := decl.(type) {
		case *ast.FuncDecl:
			name := d.Name.Name
			kind := "function"
			scope := pkgScope
			if d.Recv != nil && len(d.Recv.List) > 0 {
				scope = pkgScope + "." + recvTypeName(d.Recv.List[0].Type) + "." + name
				kind = "method"
			} else {
				scope = pkgScope + "." + name
			}
			pos := fset.Position(d.Pos())
			sig := formatFuncSig(d)
			syms = append(syms, Sym{Name: name, Kind: kind, Line: pos.Line, Col: pos.Column, Signature: sig, Scope: scope})

		case *ast.GenDecl:
			for _, spec := range d.Specs {
				switch s := spec.(type) {
				case *ast.TypeSpec:
					name := s.Name.Name
					pos := fset.Position(s.Pos())
					sig := "type " + name
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
					syms = append(syms, Sym{Name: name, Kind: "type", Line: pos.Line, Col: pos.Column, Signature: sig, Scope: pkgScope})

				case *ast.ValueSpec:
					for _, n := range s.Names {
						name := n.Name
						pos := fset.Position(n.Pos())
						kind := "var"
						if d.Tok == token.CONST {
							kind = "const"
						}
						sig := kind + " " + name
						if s.Type != nil {
							sig += " " + formatType(s.Type)
						}
						syms = append(syms, Sym{Name: name, Kind: kind, Line: pos.Line, Col: pos.Column, Signature: sig, Scope: pkgScope})
					}
				}
			}
		}
	}

	refs := []Ref{}
	ast.Inspect(node, func(n ast.Node) bool {
		switch expr := n.(type) {
		case *ast.CallExpr:
			line := fset.Position(expr.Pos()).Line
			switch fun := expr.Fun.(type) {
			case *ast.Ident:
				refs = append(refs, Ref{ToName: fun.Name, CallType: "call", Line: line})
			case *ast.SelectorExpr:
				// Record the selected name (\`Join\` of \`filepath.Join\`): it is the
				// declared symbol name, so it resolves the same way the TypeScript
				// and Python extractors' call refs do.
				refs = append(refs, Ref{ToName: fun.Sel.Name, CallType: "call", Line: line})
			}
		case *ast.ImportSpec:
			if expr.Path != nil {
				if importPath, uerr := strconv.Unquote(expr.Path.Value); uerr == nil {
					line := fset.Position(expr.Pos()).Line
					// A Go import names a package, not a symbol; the package's
					// last path segment is the name it is referenced by.
					name := importPath
					if idx := strings.LastIndex(importPath, "/"); idx >= 0 {
						name = importPath[idx+1:]
					}
					refs = append(refs, Ref{ToName: name, CallType: "import", Line: line, Module: importPath})
				}
			}
		}
		return true
	})

	if syms == nil {
		syms = []Sym{}
	}
	data, err := json.Marshal(Result{Symbols: syms, Refs: refs})
	if err != nil {
		fmt.Print(emptyResult())
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
		// Generic instantiation with one type arg, e.g. Logger[int].
		return formatType(v.X) + "[" + formatType(v.Index) + "]"
	case *ast.IndexListExpr:
		// Generic instantiation with multiple type args, e.g. Map[K, V].
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

// Cache the temp script path so we don't rewrite the parser script on every
// file. The script is identical for every invocation — writing it once per
// process (like py-parser does) eliminates mkdtemp + writeFile + rm per file.
let _cachedGoScriptPath: string | null = null;

async function syncGoParse(
  filePath: string,
  content: string,
  lang: SymbolLang,
): Promise<FileSymbols> {
  // Feed the source over stdin — never pass the target .go file as a CLI arg.
  // `go run script.go target.go` makes the toolchain treat target.go as a
  // second package file ("named files must all be in one directory") and
  // refuses *_test.go outright. Reading from stdin sidesteps both, and lets
  // us parse the in-memory content without touching disk.
  try {
    // Local `let` so TypeScript's CFA narrows to `string` after the guard.
    // Module-scope `_cachedGoScriptPath` stays `string | null` because TS
    // can't prove no concurrent mutation between the check and the use.
    let scriptPath = _cachedGoScriptPath;
    if (!scriptPath) {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-go-parse-'));
      scriptPath = path.join(tmpDir, 'parse.go');
      await fs.writeFile(scriptPath, GO_PARSE_SCRIPT, 'utf8');
      _cachedGoScriptPath = scriptPath;
    }

    // argv-array form (no shell): avoids any quoting/metachar issues in the
    // temp script path. The target source is fed via stdin, not as an arg.
    // Resolve the Go binary via PATHEXT on Windows so ENOENT is impossible.
    const goBinary = resolveWin32Command('go');

    const goResult = await new Promise<{ code: number | null; stdout: string }>(
      (resolve, reject) => {
        let settled = false;

        const proc: ChildProcess = spawn(goBinary, ['run', scriptPath], {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });

        proc.on('error', (err) => {
          if (settled) return;
          settled = true;
          reject(err);
        });

        let stdout = '';
        proc.stdout?.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        // Drain stderr to avoid backpressure deadlocks from Go toolchain
        // diagnostics (e.g. "found packages …").
        proc.stderr?.resume();

        // Write source via stdin so `go run` receives it without touching disk
        proc.stdin?.write(content);
        proc.stdin?.end();

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
      },
    );

    const { code, stdout } = goResult;

    if (code !== 0 || !stdout.trim()) {
      return { file: filePath, lang, symbols: [], mtimeMs: Date.now() };
    }

    const { symbols: rawSymbols, refs } = parseParserOutput(stdout, lang);
    const symbols: IndexSymbol[] = rawSymbols.map((s) => ({
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
    return { file: filePath, lang, symbols: [], mtimeMs: Date.now() };
  }
}
