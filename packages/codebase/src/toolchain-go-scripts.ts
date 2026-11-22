// ─── Go ──────────────────────────────────────────────────────────────────────

const GO_CORE = `
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
	Doc       string \`json:"doc"\`
}

// Ref is a cross-reference emitted alongside the symbols, so one run yields
// both. Module is the import path for CallType "import", else empty.
type Ref struct {
	ToName   string \`json:"toName"\`
	CallType string \`json:"callType"\`
	Line     int    \`json:"line"\`
	Module   string \`json:"module"\`
}

func extract(src []byte) ([]Sym, []Ref, error) {
	fset := token.NewFileSet()
	node, err := parser.ParseFile(fset, "src.go", src, parser.ParseComments)
	if err != nil {
		return nil, nil, err
	}
	pkg := node.Name.Name
	// token columns are 1-based; the index schema's are 0-based.
	at := func(p token.Pos) (int, int) {
		pos := fset.Position(p)
		return pos.Line, pos.Column - 1
	}

	syms := []Sym{}
	for _, decl := range node.Decls {
		switch d := decl.(type) {
		case *ast.FuncDecl:
			line, col := at(d.Pos())
			kind := "function"
			scope := pkg + "." + d.Name.Name
			if d.Recv != nil && len(d.Recv.List) > 0 {
				kind = "method"
				scope = pkg + "." + recvTypeName(d.Recv.List[0].Type) + "." + d.Name.Name
			}
			syms = append(syms, Sym{Name: d.Name.Name, Kind: kind, Line: line, Col: col, Signature: formatFuncSig(d), Scope: scope, Doc: firstDocLine(d.Doc)})

		case *ast.GenDecl:
			// An ungrouped declaration carries its comment on the GenDecl; a
			// grouped one's doc describes the group, not each member.
			var declDoc *ast.CommentGroup
			if !d.Lparen.IsValid() {
				declDoc = d.Doc
			}
			for _, spec := range d.Specs {
				switch s := spec.(type) {
				case *ast.TypeSpec:
					line, col := at(s.Pos())
					sig := "type " + s.Name.Name + formatTypeParams(s.TypeParams)
					if s.Assign.IsValid() {
						sig += " ="
					}
					sig += " " + formatType(s.Type)
					syms = append(syms, Sym{Name: s.Name.Name, Kind: "type", Line: line, Col: col, Signature: sig, Scope: pkg, Doc: firstDocLine(s.Doc, declDoc)})
				case *ast.ValueSpec:
					kind := "var"
					if d.Tok == token.CONST {
						kind = "const"
					}
					for _, n := range s.Names {
						line, col := at(n.Pos())
						sig := kind + " " + n.Name
						if s.Type != nil {
							sig += " " + formatType(s.Type)
						}
						syms = append(syms, Sym{Name: n.Name, Kind: kind, Line: line, Col: col, Signature: sig, Scope: pkg, Doc: firstDocLine(s.Doc, declDoc)})
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
				// The selected name (\`Join\` of \`filepath.Join\`) is the declared
				// symbol name, so it resolves like the TS and Python call refs.
				refs = append(refs, Ref{ToName: fun.Sel.Name, CallType: "call", Line: line})
			}
		case *ast.ImportSpec:
			if expr.Path != nil {
				if importPath, uerr := strconv.Unquote(expr.Path.Value); uerr == nil {
					line := fset.Position(expr.Pos()).Line
					// A Go import names a package; its last path segment is the
					// name it is referenced by.
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
	return syms, refs, nil
}

func firstDocLine(groups ...*ast.CommentGroup) string {
	for _, g := range groups {
		if g == nil {
			continue
		}
		for _, line := range strings.Split(g.Text(), "\\n") {
			if t := strings.TrimSpace(line); t != "" {
				if r := []rune(t); len(r) > 200 {
					t = string(r[:200])
				}
				return t
			}
		}
	}
	return ""
}

// recvTypeName unwraps pointers, parens and generic instantiation:
// \`(l *List[T])\` is a method of List, not of "?".
func recvTypeName(t ast.Expr) string {
	switch v := t.(type) {
	case *ast.Ident:
		return v.Name
	case *ast.StarExpr:
		return recvTypeName(v.X)
	case *ast.ParenExpr:
		return recvTypeName(v.X)
	case *ast.IndexExpr:
		return recvTypeName(v.X)
	case *ast.IndexListExpr:
		return recvTypeName(v.X)
	default:
		return "?"
	}
}

func formatFuncSig(d *ast.FuncDecl) string {
	sig := "func "
	if d.Recv != nil && len(d.Recv.List) > 0 {
		sig += formatFieldList(d.Recv.List) + " "
	}
	return sig + d.Name.Name + formatTypeParams(d.Type.TypeParams) + formatFuncType(d.Type)
}

func fieldsOf(fl *ast.FieldList) []*ast.Field {
	if fl == nil {
		return nil
	}
	return fl.List
}

func formatFuncType(f *ast.FuncType) string {
	out := formatFieldList(fieldsOf(f.Params))
	results := fieldsOf(f.Results)
	if len(results) == 1 && len(results[0].Names) == 0 {
		out += " " + formatType(results[0].Type)
	} else if len(results) > 0 {
		out += " " + formatFieldList(results)
	}
	return out
}

// formatField keeps every name of a shared-type field: \`a, b int\`.
func formatField(f *ast.Field) string {
	t := formatType(f.Type)
	if len(f.Names) == 0 {
		return t
	}
	names := make([]string, len(f.Names))
	for i, n := range f.Names {
		names[i] = n.Name
	}
	return strings.Join(names, ", ") + " " + t
}

func formatFieldList(fields []*ast.Field) string {
	parts := make([]string, len(fields))
	for i, f := range fields {
		parts[i] = formatField(f)
	}
	return "(" + strings.Join(parts, ", ") + ")"
}

// formatFields renders struct fields and interface members.
func formatFields(fields []*ast.Field) string {
	parts := make([]string, len(fields))
	for i, f := range fields {
		if ft, ok := f.Type.(*ast.FuncType); ok && len(f.Names) == 1 {
			parts[i] = f.Names[0].Name + formatFuncType(ft)
		} else {
			parts[i] = formatField(f)
		}
	}
	return strings.Join(parts, "; ")
}

func formatTypeParams(tp *ast.FieldList) string {
	if tp == nil || len(tp.List) == 0 {
		return ""
	}
	parts := make([]string, len(tp.List))
	for i, p := range tp.List {
		parts[i] = formatField(p)
	}
	return "[" + strings.Join(parts, ", ") + "]"
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
	case *ast.ParenExpr:
		return "(" + formatType(v.X) + ")"
	case *ast.Ellipsis:
		if v.Elt == nil {
			return "..."
		}
		return "..." + formatType(v.Elt)
	case *ast.ArrayType:
		if v.Len == nil {
			return "[]" + formatType(v.Elt)
		}
		return "[" + formatType(v.Len) + "]" + formatType(v.Elt)
	case *ast.MapType:
		return "map[" + formatType(v.Key) + "]" + formatType(v.Value)
	case *ast.ChanType:
		switch v.Dir {
		case ast.SEND:
			return "chan<- " + formatType(v.Value)
		case ast.RECV:
			return "<-chan " + formatType(v.Value)
		default:
			return "chan " + formatType(v.Value)
		}
	case *ast.InterfaceType:
		if len(fieldsOf(v.Methods)) == 0 {
			return "interface{}"
		}
		return "interface{ " + formatFields(v.Methods.List) + " }"
	case *ast.StructType:
		if len(fieldsOf(v.Fields)) == 0 {
			return "struct{}"
		}
		return "struct{ " + formatFields(v.Fields.List) + " }"
	case *ast.FuncType:
		return "func" + formatFuncType(v)
	case *ast.UnaryExpr:
		return v.Op.String() + formatType(v.X)
	case *ast.BinaryExpr:
		return formatType(v.X) + " " + v.Op.String() + " " + formatType(v.Y)
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

/** One Go source on stdin → `{"symbols": [...], "refs": [...]}`. */
export const GO_PARSE_SCRIPT = `${GO_CORE}
type Result struct {
	Symbols []Sym \`json:"symbols"\`
	Refs    []Ref \`json:"refs"\`
}

func main() {
	empty := \`{"symbols":[],"refs":[]}\`
	src, err := io.ReadAll(os.Stdin)
	if err != nil {
		fmt.Print(empty)
		return
	}
	syms, refs, err := extract(src)
	if err != nil {
		fmt.Print(empty)
		return
	}
	data, err := json.Marshal(Result{Symbols: syms, Refs: refs})
	if err != nil {
		fmt.Print(empty)
		return
	}
	fmt.Print(string(data))
}
`;

/** A JSON array of `{file, content}` on stdin → one envelope with per-file results. */
export const GO_BATCH_SCRIPT = `${GO_CORE}
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

func main() {
	var inputs []inputFile
	raw, err := io.ReadAll(os.Stdin)
	if err == nil {
		err = json.Unmarshal(raw, &inputs)
	}
	results := make([]FileResult, 0, len(inputs))
	if err == nil {
		for _, in := range inputs {
			res := FileResult{File: in.File, Symbols: []Sym{}, Refs: []Ref{}}
			if syms, refs, perr := extract([]byte(in.Content)); perr != nil {
				res.Error = perr.Error()
			} else {
				res.Symbols, res.Refs = syms, refs
			}
			results = append(results, res)
		}
	}
	data, merr := json.Marshal(BatchResult{Version: 1, Results: results})
	if merr != nil {
		fmt.Print(\`{"version":1,"results":[]}\`)
		return
	}
	fmt.Print(string(data))
}
`;
