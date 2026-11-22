/**
 * Universal Tree-Sitter AST visitor.
 *
 * Walks a parsed syntax tree, applying the per-language {@link NodeQueries}
 * table, and produces an indexed symbol list. Ref emission (calls, type
 * references, imports, heritage) is intentionally out of scope here — it
 * ships on Day 4 alongside the C-family tests, where per-language fixtures
 * can verify each `callType` mapping.
 *
 * The visitor is O(n) over named children: each node is visited at most
 * once, and the scope stack is push/pop in O(1). The cost on a 50k-file
 * monorepo is dominated by `Parser.parse(content)` itself, which tree-sitter
 * implements as a single-pass GLR parse in WASM.
 *
 * Two design rules that shaped this module:
 *
 *   1. **Recursive scope tracking, not parent-chain walks.** `ts-parser.ts`
 *      pushed scope parts onto an array and trimmed on return; we mirror
 *      that. The cost is O(depth) push/pop instead of O(depth × symbols)
 *      parent walks — for a 200-symbol file at depth 5, that's 1000 fewer
 *      `parent` lookups.
 *
 *   2. **Identifier extraction has two shapes.** Most languages give you a
 *      `name` field on the declaration node; a handful (C declarators,
 *      Elixir calls) don't. The visitor tries `queries.nameExtractor` first,
 *      then falls back to `queries.nameField[type] ?? 'name'`, then gives
 *      up — emitting no symbol for that node rather than fabricating one.
 */

import type { Node, Tree } from 'web-tree-sitter';
import type { Symbol as IndexSymbol, Ref, SymbolKind, SymbolLang } from '../schema.js';
import type { NodeQueries, RefEmission, RefRule } from './queries.js';
import {
  lineColAt,
  newlineOffsets,
  TREE_SITTER_MAX_FILE_CHARS,
  TREE_SITTER_MAX_SYMBOLS,
} from './util.js';

/** Result of walking one parsed file. */
interface VisitResult {
  symbols: IndexSymbol[];
  refs: Ref[];
}

/**
 * Walk a parsed tree and emit symbols.
 *
 *   `tree`     — the parsed syntax tree.
 *   `content`  — original source text. Used to derive `signature` (the
 *                declaration node's slice of the source) and `docComment`.
 *   `file`     — absolute path, threaded into every emitted symbol.
 *   `lang`     — the language the tree was parsed under.
 *   `queries`  — per-language node-mapping table.
 */
export function visitTree(
  tree: Tree,
  content: string,
  file: string,
  lang: SymbolLang,
  queries: NodeQueries,
): VisitResult {
  // Cap content like the regex extractors do. The visitor never reads past
  // `boundedContent.length`, so a multi-MB file gets a partial parse tree
  // without crashing.
  const boundedContent =
    content.length > TREE_SITTER_MAX_FILE_CHARS
      ? content.slice(0, TREE_SITTER_MAX_FILE_CHARS)
      : content;
  const nlOffsets = newlineOffsets(boundedContent);
  const symbols: IndexSymbol[] = [];
  const refs: Ref[] = [];
  // Ref identity: same target, kind, line and module collapses to one row —
  // mirrors parser-output.ts's dedupe for the Go/Python child processes.
  const seenRefs = new Set<string>();
  // Mutable scope stack — `push` / `splice` is O(1). Each recursion that
  // pushes a scope tracks its slice length so siblings see the same parent
  // scope without a copy.
  const scopeStack: string[] = [];

  /** P3.9 ref emitter — inner so it closes over refs/seenRefs/nlOffsets. */
  function emitRefsForNode(node: Node, rule: RefRule): void {
    const emissions = rule.nameExtractor?.(node) ?? defaultRefTarget(node, rule);
    if (!emissions) return;
    const { line } = lineColAt(nlOffsets, node.startIndex);
    for (const emission of emissions) {
      if (!emission.toName) continue;
      const callType = emission.callType ?? rule.callType;
      // Dedupe key includes the SOURCE NODE position: within one node,
      // identical emissions collapse (a heritage list naming Bar twice), but
      // two different statements on the SAME line never collapse here —
      // owner-based dedupe in assignRefsToSymbols (writer-helpers) is the
      // authoritative one once fromId is known, and pre-dropping a ref could
      // lose a different owner's edge (e.g. two one-line class declarations
      // both extending Bar).
      const key = `${emission.toName}:${callType}:${line}:${emission.module ?? ''}:${node.startIndex}`;
      if (seenRefs.has(key)) continue;
      seenRefs.add(key);
      refs.push({
        fromId: 0, // assignRefsToSymbols attaches owners after insertion
        toName: emission.toName.slice(0, 200),
        callType,
        line,
        lang,
        module: emission.module,
      });
    }
  }

  /** Field-based default: leaf segment of the rule's field text. */
  function defaultRefTarget(node: Node, rule: RefRule): ReadonlyArray<RefEmission> | null {
    if (!rule.field) return null;
    const field = node.childForFieldName(rule.field);
    if (!field) return null;
    // `a.b.c()` → `c`; `foo(...)` → `foo`. Also PHP namespace separators
    // (`App\Util\greet` → `greet`) and C++-style `::` scopes. Matches the
    // leaf-name convention the Go/Python/Ruby extractors already use.
    const leaf = field.text
      .split(/[.:\\]/)
      .filter(Boolean)
      .pop()
      ?.split(/[<(]/)[0];
    if (!leaf) return null;
    return [{ toName: leaf.trim() }];
  }

  function visit(node: Node, depth: number): void {
    if (symbols.length >= TREE_SITTER_MAX_SYMBOLS) return;
    // The tree covers the WHOLE file but offsets are only known inside the
    // bounded window: a node past it resolved to the window's last line, so
    // every declaration beyond 512 KiB was indexed at one wrong line.
    if (node.startIndex >= boundedContent.length) return;
    if (node.isMissing || node.isError) {
      // Skip syntax-error and MISSING nodes — they represent parser recovery,
      // not real source. Equivalent to `generic-parser` returning empty for
      // a file that fails a regex.
    } else {
      const staticKind = queries.declKinds[node.type];
      const kind =
        staticKind && queries.resolveKind ? queries.resolveKind(node, staticKind) : staticKind;
      if (kind) {
        const names = queries.declaredNames?.(node);
        for (const name of names ?? [undefined]) {
          if (symbols.length >= TREE_SITTER_MAX_SYMBOLS) break;
          const emitted = emitSymbol(
            node,
            kind,
            file,
            lang,
            scopeStack,
            boundedContent,
            nlOffsets,
            queries,
            name,
          );
          if (emitted) symbols.push(emitted);
        }
      }
      // P3.9: refs fire on every node with a matching rule, INCLUDING nodes
      // that also emitted a symbol (a `call` node can be an Elixir def) —
      // the two lists are independent by design.
      const refRule = queries.refRules?.[node.type];
      if (refRule) emitRefsForNode(node, refRule);
    }

    // Push scope for nodes that should not be re-emitted by descendants.
    // `queries.scopeNodes` defaults to `function_definition` and friends;
    // a `class_declaration` inside a `class_declaration` is a nested class —
    // both belong in the index, with the outer as the scope.
    const pushesScope = queries.isScopeNode
      ? queries.isScopeNode(node)
      : (queries.scopeNodes?.has(node.type) ?? false);
    const pushIdx = pushesScope ? pushScope(scopeStack, node, queries) : -1;

    if (queries.skipNamedChildren) {
      if (pushIdx !== -1) scopeStack.pop();
      return;
    }

    for (const child of node.namedChildren) {
      visit(child, depth + 1);
      if (symbols.length >= TREE_SITTER_MAX_SYMBOLS) {
        if (pushIdx !== -1) scopeStack.pop();
        return;
      }
    }
    if (pushIdx !== -1) scopeStack.pop();
  }

  visit(tree.rootNode, 0);

  return { symbols, refs };
}

/**
 * Push a scope part onto `scopeStack`. Returns the new length so the caller
 * can call `scopeStack.pop()` symmetrically without tracking a parent stack.
 * `pushScope` mutates in place; no array allocation per recursion.
 */
function pushScope(scopeStack: string[], node: Node, queries: NodeQueries): number {
  const name = extractName(node, queries);
  if (!name) return -1;
  scopeStack.push(name);
  return scopeStack.length - 1;
}

/**
 * Extract the identifier from a declaration node.
 *
 *   1. Try `queries.nameExtractor(node)` first — languages whose declarations
 *      have no `name` field (Elixir `call`, C declarator chains) supply a
 *      custom function.
 *   2. Otherwise, fall back to `childForFieldName(queries.nameField[type] ?? 'name')`.
 *   3. If the field returns a node whose text contains whitespace, walk one
 *      level deeper looking for a plain `identifier` — covers a few C-style
 *      grammars that wrap the name in a `field_identifier`.
 */
/** Types we recognize as "this is an identifier" when extracting a name. */
const IDENTIFIER_NODE_TYPES: ReadonlySet<string> = new Set([
  'identifier',
  'simple_identifier',
  'type_identifier',
  'field_identifier',
  'property_identifier',
  'name',
  'word',
  'variable_name',
  'constant',
  'sym',
  'namespace_identifier',
]);

/**
 * Follow a declarator chain to the declared identifier:
 * `char *dup(…)` is (pointer_declarator declarator: (function_declarator
 * declarator: (identifier))), and `double Shape::area()` ends in a
 * qualified_identifier whose `name:` is the identifier. Reading only one
 * level down lost every pointer-returning C function and every out-of-class
 * C++ method definition.
 */
function declaratorChainName(start: Node): string | null {
  let current: Node | null = start;
  for (let depth = 0; current && depth < 16; depth++) {
    if (IDENTIFIER_NODE_TYPES.has(current.type)) return current.text;
    if (current.type === 'destructor_name' || current.type === 'operator_name') {
      return current.text;
    }
    current = current.childForFieldName('declarator') ?? current.childForFieldName('name');
  }
  return null;
}

function extractName(node: Node, queries: NodeQueries): string | null {
  if (queries.nameExtractor) {
    const extracted = queries.nameExtractor(node);
    if (extracted) return extracted;
  }
  const fieldName = queries.nameField?.[node.type] ?? 'name';
  const field = node.childForFieldName(fieldName);
  if (field) {
    const chained = declaratorChainName(field);
    if (chained) return chained;
    // Some grammars wrap the name one level deeper without a field.
    const inner = field.namedChild(0);
    if (inner && IDENTIFIER_NODE_TYPES.has(inner.type)) {
      return inner.text;
    }
  }
  // Field lookup failed (or returned non-identifier). Fall back to the first
  // identifier-shaped named child — covers PHP/Kotlin/Shell grammars where
  // the declaration's name lives in a *named child*, not a *field*.
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child && IDENTIFIER_NODE_TYPES.has(child.type)) {
      return child.text;
    }
  }
  return null;
}

/**
 * Return the raw text of 1-based line `line1Based` using precomputed newline offsets.
 */
function lineSlice(content: string, nlOffsets: readonly number[], line1Based: number): string {
  const start = line1Based <= 1 ? 0 : (nlOffsets[line1Based - 2] ?? -1) + 1;
  const end =
    line1Based - 1 < nlOffsets.length
      ? (nlOffsets[line1Based - 1] ?? content.length)
      : content.length;
  return content.slice(start, end);
}

const C_PREPROC_RE =
  /^#\s*(?:include|define|undef|if|ifdef|ifndef|elif|else|endif|pragma|error|line)\b/;
const ATTR_OR_ANNOTATION_RE =
  /^(?:@[A-Za-z_][\w.]*(?:\([^)]*\))?|#\[[^\]]*\]|\[[A-Za-z_][\w.,\s()="']*\])$/;

/**
 * Extract the first meaningful summary line of a doc comment or docstring
 * attached to `node` (capped at 200 characters).
 */
function extractDocComment(
  node: Node,
  content: string,
  nlOffsets: readonly number[],
  line: number,
  lang: SymbolLang,
): string {
  // 1. Python docstring inside function/class body (`def f(): """doc"""`)
  if (lang === 'py') {
    const body = node.childForFieldName('body');
    const firstStmt = body?.namedChild(0);
    const strNode =
      firstStmt?.type === 'expression_statement'
        ? firstStmt.namedChild(0)
        : firstStmt?.type === 'string'
          ? firstStmt
          : null;
    if (strNode && strNode.type === 'string') {
      const inner = strNode.text
        .replace(/^[rRuUfFbB]*(?:"""|'''|"|')/, '')
        .replace(/(?:"""|'''|"|')$/, '');
      const firstLine = inner
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.length > 0);
      if (firstLine) return firstLine.slice(0, 200);
    }
  }

  // 2. Leading comments on lines immediately preceding `line`
  const lineComments: string[] = [];
  const minLine = Math.max(1, line - 35);
  for (let cur = line - 1; cur >= minLine; cur--) {
    const trimmed = lineSlice(content, nlOffsets, cur).trim();
    if (!trimmed) break;

    // Elixir `@doc` / `@moduledoc` attributes
    if (lang === 'elixir') {
      const singleDoc = trimmed.match(/^@(?:module)?doc\s+"([^"]+)"/);
      if (singleDoc?.[1]) {
        return singleDoc[1].trim().slice(0, 200);
      }
      if (trimmed === '"""') {
        const heredocLines: string[] = [];
        for (let h = cur - 1; h >= minLine; h--) {
          const hTrim = lineSlice(content, nlOffsets, h).trim();
          const openMatch = hTrim.match(/^@(?:module)?doc\s+"""(.*)$/);
          if (openMatch) {
            if (openMatch[1]?.trim()) heredocLines.unshift(openMatch[1].trim());
            const first = heredocLines.find((l) => l.length > 0);
            return first ? first.slice(0, 200) : '';
          }
          heredocLines.unshift(hTrim);
        }
        break;
      }
    }

    // Skip annotations/attributes sitting directly between the doc comment and the symbol
    if (lineComments.length === 0 && ATTR_OR_ANNOTATION_RE.test(trimmed)) {
      continue;
    }

    // Single-line or multi-line C/Java/Kotlin/PHP/C#/Swift block comment ending with `*/`
    if (trimmed.endsWith('*/') && lineComments.length === 0) {
      if (trimmed.startsWith('/*')) {
        const single = trimmed
          .replace(/^\/\*+\s*/, '')
          .replace(/\s*\*+\/$/, '')
          .trim();
        return single.slice(0, 200);
      }
      const blockLines: string[] = [];
      for (let b = cur; b >= minLine; b--) {
        const bTrim = lineSlice(content, nlOffsets, b).trim();
        const hasOpen = bTrim.includes('/*');
        const cleaned = bTrim
          .replace(/^.*\/\*+\s*/, '')
          .replace(/\s*\*+\/.*$/, '')
          .replace(/^\*+\s?/, '')
          .trim();
        if (cleaned) blockLines.unshift(cleaned);
        if (hasOpen) {
          const first = blockLines.find((l) => l.length > 0 && !l.startsWith('@'));
          return (first ?? blockLines[0] ?? '').slice(0, 200);
        }
      }
      break;
    }

    // Line comments (`///`, `//!`, `//`, `#`)
    if (trimmed.startsWith('//')) {
      const cleaned = trimmed.replace(/^\/\/[/!]*\s?/, '').trim();
      lineComments.unshift(cleaned);
      continue;
    }
    if (
      trimmed.startsWith('#') &&
      !trimmed.startsWith('#!') &&
      !trimmed.startsWith('#[') &&
      !((lang === 'c' || lang === 'cpp') && C_PREPROC_RE.test(trimmed))
    ) {
      const cleaned = trimmed.replace(/^#+\s?/, '').trim();
      lineComments.unshift(cleaned);
      continue;
    }

    break;
  }

  const firstLineComment = lineComments.find((l) => l.length > 0);
  return firstLineComment ? firstLineComment.slice(0, 200) : '';
}

/**
 * Build one {@link IndexSymbol} from a declaration node. Returns `null` when
 * no name could be extracted — the visitor treats that as "skip this node",
 * matching the regex extractor's anonymous-declaration contract.
 */
function emitSymbol(
  node: Node,
  kind: SymbolKind,
  file: string,
  lang: SymbolLang,
  scopeStack: string[],
  content: string,
  nlOffsets: readonly number[],
  queries: NodeQueries,
  nameOverride?: string,
): IndexSymbol | null {
  const name = nameOverride ?? extractName(node, queries);
  if (!name) return null;

  // 1-based line, 0-based col. Tree-sitter positions are already 0-based for
  // both — we only adjust line by +1 to match `ts-parser.ts`.
  const pos = node.startIndex;
  const { line, col } = lineColAt(nlOffsets, pos);

  // Signature: the declaration's slice of the source, whitespace-collapsed,
  // capped at 500 chars. Mirrors `ts-parser.ts#getSignature`.
  const end = Math.min(node.endIndex, content.length);
  const { line: rawEndLine } = lineColAt(nlOffsets, Math.max(pos, end - 1));
  const endLine = Math.max(line, rawEndLine);
  const signature = content.slice(pos, end).replace(/\s+/g, ' ').trim().slice(0, 500);

  // Scope is dot-joined. Top-level declarations get an empty string — the
  // empty-scope convention is what `ts-parser.ts` and the BFS reader expect.
  const scope = scopeStack.join('.');

  const docComment = extractDocComment(node, content, nlOffsets, line, lang);
  const text = [name, signature, docComment].filter(Boolean).join(' | ').trim().slice(0, 1000);

  return {
    id: 0, // caller assigns during bulk insertion
    lang,
    kind,
    name: name.slice(0, 200),
    file,
    line,
    col,
    endLine,
    signature,
    docComment,
    scope,
    text,
  };
}
