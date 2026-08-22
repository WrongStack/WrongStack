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
export interface VisitResult {
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
    if (node.isMissing || node.isError) {
      // Skip syntax-error and MISSING nodes — they represent parser recovery,
      // not real source. Equivalent to `generic-parser` returning empty for
      // a file that fails a regex.
    } else {
      const kind = queries.declKinds[node.type];
      if (kind) {
        const emitted = emitSymbol(
          node,
          kind,
          file,
          lang,
          scopeStack,
          boundedContent,
          nlOffsets,
          queries,
        );
        if (emitted) symbols.push(emitted);
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
    const pushesScope = queries.scopeNodes?.has(node.type) ?? false;
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
]);

function extractName(node: Node, queries: NodeQueries): string | null {
  if (queries.nameExtractor) {
    const extracted = queries.nameExtractor(node);
    if (extracted) return extracted;
  }
  const fieldName = queries.nameField?.[node.type] ?? 'name';
  const field = node.childForFieldName(fieldName);
  if (field) {
    if (IDENTIFIER_NODE_TYPES.has(field.type)) {
      return field.text;
    }
    // Some grammars wrap the name one level deeper (e.g. a declarator chain).
    const inner = field.childForFieldName('name') ?? field.namedChild(0);
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
): IndexSymbol | null {
  const name = extractName(node, queries);
  if (!name) return null;

  // 1-based line, 0-based col. Tree-sitter positions are already 0-based for
  // both — we only adjust line by +1 to match `ts-parser.ts`.
  const pos = node.startIndex;
  const { line, col } = lineColAt(nlOffsets, pos);

  // Signature: the declaration's slice of the source, whitespace-collapsed,
  // capped at 500 chars. Mirrors `ts-parser.ts#getSignature`.
  const end = Math.min(node.endIndex, content.length);
  const signature = content.slice(pos, end).replace(/\s+/g, ' ').trim().slice(0, 500);

  // Scope is dot-joined. Top-level declarations get an empty string — the
  // empty-scope convention is what `ts-parser.ts` and the BFS reader expect.
  const scope = scopeStack.join('.');

  const text = [name, signature].filter(Boolean).join(' | ').trim().slice(0, 1000);

  return {
    id: 0, // caller assigns during bulk insertion
    lang,
    kind,
    name: name.slice(0, 200),
    file,
    line,
    col,
    signature,
    docComment: '', // doc-comment extraction lands with ref emission on Day 4
    scope,
    text,
  };
}
