/**
 * TypeScript/JavaScript symbol extraction using the TypeScript Compiler API.
 *
 * We traverse the AST and collect:
 * - classes, interfaces, enums, type aliases  → class|interface|enum|type
 * - functions and methods                       → function|method
 * - const/let/var declarations                 → const|let|var
 * - property/accessor declarations            → property
 *
 * The `id` field on each Symbol is always 0 — the caller is responsible for
 * assigning unique ids during insertion.
 */

import type * as TS from '@typescript/typescript6';
import type { FileSymbols, Symbol as IndexSymbol, Ref, SymbolKind, SymbolLang } from './schema.js';

type TsModule = typeof import('@typescript/typescript6');

/**
 * The TypeScript compiler is ~9MB of JavaScript and costs ~26MB heap / ~44MB
 * RSS to evaluate. A static `import` here put it in the module graph of every
 * bundle that can reach the indexer — including `wstack version`, the mailbox
 * bridge, and the codebase-index project server, none of which parse TS.
 *
 * It must stay a runtime `import()` of an EXTERNAL package: the build runs with
 * `splitting: false` (scripts/build-package.mjs), so esbuild inlines dynamic
 * imports of in-repo files. `parser-dispatch.ts` doing `await import('./ts-parser.js')`
 * therefore does NOT defer anything on its own — this boundary is the one that
 * survives bundling. Mirrors `_syntax-check.ts`.
 */
let ts!: TsModule;
let tsLoad: Promise<TsModule> | null = null;

function loadTypescript(): Promise<TsModule> {
  tsLoad ??= import('@typescript/typescript6').then((m) => {
    ts = ((m as unknown as { default?: TsModule }).default ?? m) as TsModule;
    return ts;
  });
  return tsLoad;
}

// Map TypeScript SyntaxKind → our SymbolKind taxonomy. Built on first use
// because the enum values only exist once the compiler module is loaded.
let kindMapCache: Partial<Record<TS.SyntaxKind, SymbolKind>> | null = null;

function kindMap(): Partial<Record<TS.SyntaxKind, SymbolKind>> {
  kindMapCache ??= {
    [ts.SyntaxKind.ClassDeclaration]: 'class',
    [ts.SyntaxKind.InterfaceDeclaration]: 'interface',
    [ts.SyntaxKind.EnumDeclaration]: 'enum',
    [ts.SyntaxKind.TypeAliasDeclaration]: 'type',
    [ts.SyntaxKind.FunctionDeclaration]: 'function',
    [ts.SyntaxKind.MethodDeclaration]: 'method',
    [ts.SyntaxKind.GetAccessor]: 'property',
    [ts.SyntaxKind.SetAccessor]: 'property',
    [ts.SyntaxKind.PropertyDeclaration]: 'property',
    [ts.SyntaxKind.Parameter]: 'parameter',
    [ts.SyntaxKind.NamespaceExportDeclaration]: 'namespace',
  };
  return kindMapCache;
}

function kindOf(node: TS.Node): SymbolKind | null {
  // VariableDeclaration needs special handling — its parent tells us whether
  // it's `const`, `let`, or `var`.
  if (ts.isVariableDeclaration(node)) {
    const parent = node.parent;
    if (ts.isVariableDeclarationList(parent)) {
      const flags = parent.flags;
      if (flags & ts.NodeFlags.Let) return 'let';
      if (flags & ts.NodeFlags.Const) return 'const';
      return 'var';
    }
  }

  // Namespace (module) declaration
  if (ts.isModuleDeclaration(node)) return 'namespace';

  return kindMap()[node.kind] ?? null;
}

// Extension → language lives in languages.ts (single source of truth for
// discovery + first-class + generic coverage).

function getSignature(
  printer: TS.Printer,
  node: TS.Declaration,
  sourceFile: TS.SourceFile,
): string {
  const raw = printer.printNode(ts.EmitHint.Unspecified, node, sourceFile);
  return raw.replace(/\s+/g, ' ').slice(0, 500);
}

/**
 * Extract the first line of a JSDoc comment preceding a node.
 * Uses `ts.getLeadingCommentRanges` which is the modern replacement for
 * the removed `ts.getJSDocComments`.
 */
function getJsDoc(node: TS.Node, sourceFile: TS.SourceFile): string {
  const fullText = sourceFile.getFullText();
  // getLeadingCommentRanges wants the position where the node's leading trivia
  // begins (getFullStart), not the node's width — passing getFullWidth() looked
  // past the comment and silently returned no JSDoc for every symbol.
  const nodePos = node.getFullStart();
  const comments = ts.getLeadingCommentRanges(fullText, nodePos);
  if (!comments) return '';

  for (const range of comments) {
    const commentText = fullText.slice(range.pos, range.end);
    // Only process JSDoc comments (/** ... */)
    const trimmed = commentText.trim();
    if (trimmed.startsWith('/**') && trimmed.endsWith('*/')) {
      // Strip the /** and */ delimiters and leading * on each line
      const inner = trimmed
        .slice(3, -2) // remove /** and */
        .replace(/^[ \t]*\*[ ]?/gm, '') // remove leading " * " or " *" on each line
        .trim();
      return inner.split('\n')[0]?.trim().slice(0, 200) ?? '';
    }
  }
  return '';
}

/** Push the current node's scope contribution onto `parts` (for the O(1) recursive scope tracker). */
function pushScopeName(node: TS.Node, parts: string[]): void {
  if (
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isTypeAliasDeclaration(node)
  ) {
    parts.push(node.name?.text ?? 'Anon');
  } else if (
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessor(node) ||
    ts.isSetAccessor(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isFunctionDeclaration(node)
  ) {
    if (node.name && ts.isIdentifier(node.name)) {
      parts.push(node.name.text);
    }
  }
}

interface ParseOptions {
  file: string;
  content: string;
  lang: SymbolLang;
}

/**
 * Parse a TypeScript/JavaScript source file and extract all code symbols.
 *
 * The returned `Symbol.id` field is always `0` — the caller is responsible
 * for assigning unique numeric ids during bulk insertion.
 *
 * Returns an empty array for files that can't be parsed or contain no symbols.
 *
 * Async because the TypeScript compiler is loaded on first use — see
 * {@link loadTypescript}. The load is memoized, so only the first call to this
 * function in a process pays for it.
 */
export async function parseSymbols(opts: ParseOptions): Promise<FileSymbols> {
  const { file, content, lang } = opts;
  await loadTypescript();

  let sourceFile: TS.SourceFile;
  try {
    sourceFile = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
  } catch {
    /* v8 ignore next -- createSourceFile tolerates malformed input and does not throw; defensive. */
    return { file, lang, symbols: [], mtimeMs: Date.now() };
  }

  const symbols: IndexSymbol[] = [];
  const refs: Ref[] = [];
  // Create the printer once per file instead of per-symbol. ts.createPrinter is
  // not free — it allocates internal emitter state — and we call getSignature
  // for every navigable declaration (often 100-300 per file).
  const printer = ts.createPrinter({});

  function visit(node: TS.Node, funcDepth: number, scopeParts: string[]): void {
    // ── Symbol extraction ──────────────────────────────────────────────
    const kind = kindOf(node);

    if (kind) {
      // Keep the index focused on navigable declarations. Function-local
      // variables and parameters account for most rows in large TypeScript
      // projects and otherwise swamp exact declaration searches.
      // funcDepth is a cheap O(1) counter threaded through the recursion
      // instead of walking up the parent chain per symbol.
      if (
        (kind === 'const' || kind === 'let' || kind === 'var' || kind === 'parameter') &&
        funcDepth > 0
      ) {
        // Fall through to ref extraction — function-local variables can still
        // appear in type references and calls.
      } else {
        const nameNode = (node as { name?: TS.Identifier | undefined }).name;
        if (!nameNode || !ts.isIdentifier(nameNode)) {
          // Anonymous declaration (e.g. `export default class { ... }`) — no
          // name identifier, so there's nothing to index. Skip children too
          // to avoid indexing members of anonymous containers. Ref extraction
          // for the node itself is also skipped, but anonymous declarations
          // never match ref checks anyway.
          return;
        }
        const name = nameNode.text;
        const pos = nameNode.getStart(sourceFile);
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(pos);
        const scope = scopeParts.join('.');
        const signature = getSignature(printer, node as TS.Declaration, sourceFile);
        const docComment = getJsDoc(node, sourceFile);
        const text = [name, signature, docComment].filter(Boolean).join(' | ');

        symbols.push({
          id: 0,
          lang,
          kind,
          name,
          file,
          line: line + 1,
          col: character,
          signature,
          docComment,
          scope,
          text,
        });
      }
    }

    // ── Reference extraction (inlined from extractRefs) ────────────────
    const pos = node.getStart(sourceFile);
    const { line } = sourceFile.getLineAndCharacterOfPosition(pos);
    const lineNum = line + 1;

    if (ts.isCallExpression(node)) {
      const expr = node.expression;
      if (ts.isIdentifier(expr)) {
        refs.push({ fromId: 0, toName: expr.text, callType: 'call', line: lineNum });
      }
    } else if (ts.isPropertyAccessExpression(node)) {
      if (ts.isIdentifier(node.expression)) {
        refs.push({ fromId: 0, toName: node.expression.text, callType: 'call', line: lineNum });
      }
    } else if (ts.isTypeReferenceNode(node)) {
      const name = getTypeName(node.typeName);
      if (name) refs.push({ fromId: 0, toName: name, callType: 'type_ref', line: lineNum });
    } else if (ts.isHeritageClause(node)) {
      for (const t of node.types) {
        const name = getTypeName(t.expression as TS.EntityName);
        if (name)
          refs.push({
            fromId: 0,
            toName: name,
            callType: node.token === ts.SyntaxKind.ExtendsKeyword ? 'inherit' : 'implement',
            line: lineNum,
          });
      }
    } else if (ts.isImportDeclaration(node)) {
      // Emit import refs for each imported symbol NAME rather than the module
      // path string.  This lets the ref resolver match the import against the
      // target symbol's declaration name, so the dead-code BFS can traverse
      // module boundaries.  Module-path refs (old behaviour) were never
      // resolvable because no symbol is ever named './foo.js'.
      emitImportSpecifierRefs(node, refs, lineNum);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      // Re-exports: export { X } from './foo' — emit refs for the exported
      // names so they resolve to the source module's symbols.
      emitExportSpecifierRefs(node, refs, lineNum);
    }

    // Push scope name before recursing, pop after (O(1) instead of O(depth) parent walk)
    const scopeIdx = scopeParts.length;
    pushScopeName(node, scopeParts);
    const childFuncDepth = ts.isFunctionLike(node) ? funcDepth + 1 : funcDepth;
    ts.forEachChild(node, (child) => visit(child, childFuncDepth, scopeParts));
    scopeParts.length = scopeIdx;
  }

  visit(sourceFile, 0, []);

  return { file, lang, symbols, refs: deduplicateRefs(refs), mtimeMs: Date.now() };
}

// ─── Reference extraction helpers ──────────────────────────────────────────────

/** Extract the name string from a type name node (simple or qualified). */
function getTypeName(name: TS.EntityName): string {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isQualifiedName(name)) return `${getTypeName(name.left)}.${name.right.text}`;
  /* v8 ignore next -- an EntityName is always an Identifier or QualifiedName; defensive. */
  return '';
}

/** Remove duplicate refs (same target, kind, line). fromId is always 0 at this stage. */
function deduplicateRefs(refs: Ref[]): Ref[] {
  const seen = new Set<string>();
  return refs.filter((r) => {
    // The module is part of the identity: two imports of the same name from
    // different modules on one line are distinct dependencies.
    const key = `${r.toName}:${r.callType}:${r.line}:${r.module ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Extract the imported (original-export) name from an ImportSpecifier. */
function getImportSpecifierName(spec: TS.ImportSpecifier): string {
  // import { X as Y } from './foo' → propertyName is 'X', name is 'Y'
  // import { X } from './foo' → propertyName is undefined, name is 'X'
  // We emit the ORIGINAL exported name so the ref resolves to the
  // declaration symbol in the source module.
  return spec.propertyName?.text ?? spec.name.text;
}

/**
 * Emit `import` refs for each named symbol brought into scope by an
 * `ImportDeclaration`.  Uses the original exported name (not the local
 * alias and not the module path) so the ref resolver can match it against
 * the target symbol's declaration name.
 *
 * Handles:
 *   import { X } from 'M'           → ref toName: 'X'
 *   import { X as Y } from 'M'      → ref toName: 'X'  (original name)
 *   import X from 'M'                → ref toName: 'X'
 *   import * as X from 'M'           → ref toName: 'X'
 *   import { type X } from 'M'       → ref toName: 'X'  (type-only flagged)
 *   import 'M'                       → no refs (side-effect only)
 */
function emitImportSpecifierRefs(node: TS.ImportDeclaration, refs: Ref[], lineNum: number): void {
  const module = moduleSpecifierOf(node.moduleSpecifier);
  const clause = node.importClause;

  if (!clause) {
    // Side-effect import: `import './polyfill.js'`. There is no symbol to name,
    // but it is a genuine file dependency — recorded module-only so the Code
    // Atlas still draws the edge.
    if (module) {
      refs.push({ fromId: 0, toName: module, callType: 'import', line: lineNum, module });
    }
    return;
  }

  // Default import: import X from 'M'  (may coexist with named bindings
  // e.g. import React, { useState } from 'react')
  if (clause.name) {
    refs.push({ fromId: 0, toName: clause.name.text, callType: 'import', line: lineNum, module });
  }

  // Named imports: import { X, Y } from 'M'
  const bindings = clause.namedBindings;
  if (!bindings) return;

  if (ts.isNamedImports(bindings)) {
    for (const element of bindings.elements) {
      refs.push({
        fromId: 0,
        toName: getImportSpecifierName(element),
        callType: 'import',
        line: lineNum,
        module,
      });
    }
  } else if (ts.isNamespaceImport(bindings)) {
    // import * as X from 'M'
    refs.push({
      fromId: 0,
      toName: bindings.name.text,
      callType: 'import',
      line: lineNum,
      module,
    });
  }
}

/** Literal text of a module specifier, or `undefined` if it is not a literal. */
function moduleSpecifierOf(node: TS.Expression | undefined): string | undefined {
  return node && ts.isStringLiteral(node) ? node.text : undefined;
}

/**
 * Emit `import` refs for each symbol re-exported by an `ExportDeclaration`
 * with a `from` clause.  These use the original source-side name so the ref
 * resolves to the declaration symbol in the source module.
 *
 * Handles:
 *   export { X } from 'M'           → ref toName: 'X'
 *   export { X as Y } from 'M'      → ref toName: 'X'  (original name)
 *   export * as X from 'M'          → ref toName: 'X'  (namespace)
 *   export * from 'M'               → module-only ref (no symbol to name, but
 *                                      still a real file dependency)
 */
function emitExportSpecifierRefs(node: TS.ExportDeclaration, refs: Ref[], lineNum: number): void {
  const module = moduleSpecifierOf(node.moduleSpecifier);
  const clause = node.exportClause;

  if (clause && ts.isNamespaceExport(clause)) {
    // export * as X from 'M' — NamespaceExport has a .name
    refs.push({ fromId: 0, toName: clause.name.text, callType: 'import', line: lineNum, module });
    return;
  }

  if (clause && ts.isNamedExports(clause)) {
    // export { X } from 'M' — NamedExports
    for (const element of clause.elements) {
      // export { X as Y } → propertyName is 'X' (original), name is 'Y' (exported)
      // export { X } → propertyName is undefined, name is 'X'
      const originalName = element.propertyName?.text ?? element.name.text;
      refs.push({ fromId: 0, toName: originalName, callType: 'import', line: lineNum, module });
    }
    return;
  }

  // export * from 'M' — no clause (wildcard). No per-symbol ref is possible,
  // but the module edge is: barrel files are almost entirely wildcard
  // re-exports, and without this they contribute no dependencies at all.
  if (module) {
    refs.push({ fromId: 0, toName: module, callType: 'import', line: lineNum, module });
  }
}

/** Detect SymbolLang from a file path — re-exported from the central map. */
export { detectLang } from './languages.js';
