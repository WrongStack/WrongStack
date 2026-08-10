/**
 * Per-language tree-sitter node-mapping queries.
 *
 * The Day 2-3 skeleton defines the *declaration-kind* surface for each
 * language: which tree-sitter node types map to which `SymbolKind`, and how
 * to extract the symbol's name from that node. Ref/import/heritage emission
 * (calls, type references, extends/implements, include paths) lands on Day 4
 * alongside the C-family tests, where real AST fixtures prove the mapping.
 *
 * Why no tree-sitter queries (the `.scm` query language)?
 *   The universal visitor (`visitor.ts`) walks the tree by node-type rather
 *   than running a `.scm` query. A query-based approach would be faster at
 *   very large scale but adds a second AST traversal pattern and a separate
 *   grammar file per language. Direct traversal keeps the code shape aligned
 *   with `ts-parser.ts` and `py-parser.ts` — one recursion, one witness list.
 *
 * Each language only needs to fill in the few fields that differ from the
 * default (see {@link DEFAULT_QUERIES}). The block form in `LANG_QUERIES`
 * documents the full set of fields exhaustively so the next reader can see
 * at a glance what a language can override.
 */

import type { SymbolKind, SymbolLang } from '../schema.js';

/**
 * Declarations worth indexing for a language.
 *
 *   `declKinds`    — map of `tree-sitter node.type` → `SymbolKind`.
 *   `nameField`    — node field name that carries the identifier; defaults
 *                    to `'name'`. Some grammars expose a `declarator` field
 *                    that wraps a `pointer_declarator` or `function_declarator`.
 *   `nameExtractor` — optional escape hatch for languages (e.g. Elixir)
 *                    whose declaration shape doesn't have a clean `name` field.
 *   `scopeNodes`   — node types that push a new scope onto the visitor's
 *                    stack. Class/struct/namespace/interface/impl/module.
 *   `skipNamedChildren` — when true, the visitor does not recurse into
 *                    named children of a declaration node. Set for languages
 *                    where the parent itself is the only indexable unit
 *                    (rare; default false).
 */
export interface NodeQueries {
  declKinds: Record<string, SymbolKind>;
  nameField?: Partial<Record<string, string>>;
  nameExtractor?: (node: import('web-tree-sitter').Node) => string | null;
  scopeNodes?: ReadonlySet<string>;
  skipNamedChildren?: boolean;
}

/** Sensible default: every language uses `name` as the field name. */
const DEFAULT_QUERIES: NodeQueries = {
  declKinds: {},
};

/**
 * Block-shaped per-language overrides. Each entry is the *complete* set of
 * fields the language cares about — `DEFAULT_QUERIES` is the fallback for
 * anything not specified, but in practice we keep `declKinds` and
 * `scopeNodes` explicit so the table is self-documenting.
 */
const LANG_QUERIES: Partial<Record<SymbolLang, NodeQueries>> = {
  // ─── C family ──────────────────────────────────────────────────────────────
  c: {
    declKinds: {
      function_definition: 'function',
      declaration: 'function', // K&R-style `int foo(...)` ambiguous w/ local var; the visitor prefers the function branch when the declarator field is present
      struct_specifier: 'struct',
      union_specifier: 'struct',
      enum_specifier: 'enum',
      type_definition: 'type', // `typedef … X;`
      preproc_def: 'const', // `#define NAME …`
    },
    nameField: {
      function_definition: 'declarator',
      declaration: 'declarator',
      struct_specifier: 'name',
      enum_specifier: 'name',
      type_definition: 'declarator',
      preproc_def: 'name',
    },
    scopeNodes: new Set([
      'translation_unit',
      'function_definition',
      'struct_specifier',
      'union_specifier',
      'enum_specifier',
    ]),
  },
  cpp: {
    declKinds: {
      function_definition: 'function',
      template_declaration: 'function', // `template<typename T> …`
      class_specifier: 'class',
      struct_specifier: 'struct',
      union_specifier: 'struct',
      enum_specifier: 'enum',
      namespace_definition: 'namespace',
      type_definition: 'type',
    },
    nameField: {
      function_definition: 'declarator',
      template_declaration: 'name',
      class_specifier: 'name',
      struct_specifier: 'name',
      enum_specifier: 'name',
      namespace_definition: 'name',
      type_definition: 'declarator',
    },
    scopeNodes: new Set([
      'translation_unit',
      'function_definition',
      'class_specifier',
      'struct_specifier',
      'union_specifier',
      'enum_specifier',
      'namespace_definition',
    ]),
  },
  java: {
    declKinds: {
      class_declaration: 'class',
      interface_declaration: 'interface',
      enum_declaration: 'enum',
      record_declaration: 'class',
      annotation_type_declaration: 'interface',
      method_declaration: 'method',
      constructor_declaration: 'method',
      field_declaration: 'property',
    },
    nameField: {
      class_declaration: 'name',
      interface_declaration: 'name',
      enum_declaration: 'name',
      record_declaration: 'name',
      annotation_type_declaration: 'name',
      method_declaration: 'name',
      constructor_declaration: 'name',
    },
    // `field_declaration` has no single `name` field — it carries a list of
    // variable declarators. We emit one Symbol per node using the first
    // identifier-shaped named child (see `extractName` fallback in
    // `visitor.ts`). `int a, b, c;` therefore indexes only `a` — splitting
    // multi-declarator fields into separate Symbols is a separate refactor
    // that needs the visitor to know it has multiple names per node, and no
    // current test relies on it.
    scopeNodes: new Set([
      'program',
      'class_declaration',
      'interface_declaration',
      'enum_declaration',
      'record_declaration',
    ]),
  },
  csharp: {
    // C# 10+ `namespace Foo.Bar;` produces this node type. The legacy block
    // form `namespace Foo.Bar { ... }` produces `namespace_declaration`. Both
    // carry a `qualified_name` child whose text already includes the dots.
    // `using_directive` is intentionally not a declaration. Imports are
    // extracted separately; indexing a using directive as a namespace makes
    // the resolver bind it to its own source file before the real declaration.
    declKinds: {
      file_scoped_namespace_declaration: 'namespace',
      class_declaration: 'class',
      interface_declaration: 'interface',
      struct_declaration: 'struct',
      enum_declaration: 'enum',
      record_declaration: 'class',
      method_declaration: 'method',
      constructor_declaration: 'method',
      property_declaration: 'property',
      field_declaration: 'property',
      namespace_declaration: 'namespace',
    },
    // Custom name extractor: take the full dotted name verbatim.
    nameExtractor: (node) => {
      const inner = node.namedChild(0);
      if (inner && (inner.type === 'qualified_name' || inner.type === 'name')) {
        return inner.text;
      }
      return null;
    },
    scopeNodes: new Set([
      'compilation_unit',
      'namespace_declaration',
      'class_declaration',
      'interface_declaration',
      'struct_declaration',
      'enum_declaration',
      'record_declaration',
    ]),
  },
  php: {
    declKinds: {
      function_definition: 'function',
      method_declaration: 'method',
      class_declaration: 'class',
      interface_declaration: 'interface',
      trait_declaration: 'class',
      enum_declaration: 'enum',
      namespace_definition: 'namespace',
    },
    nameField: {
      function_definition: 'name',
      method_declaration: 'name',
      class_declaration: 'name',
      interface_declaration: 'name',
      trait_declaration: 'name',
      enum_declaration: 'name',
      namespace_declaration: 'name',
    },
    scopeNodes: new Set([
      'program',
      'namespace_definition',
      'class_declaration',
      'interface_declaration',
      'trait_declaration',
      'enum_declaration',
    ]),
  },

  // ─── Scripting / mobile ────────────────────────────────────────────────────
  ruby: {
    declKinds: {
      method: 'function',
      singleton_method: 'method',
      class: 'class',
      module: 'namespace',
      constant: 'const',
    },
    nameField: {
      method: 'name',
      singleton_method: 'name',
      class: 'name',
      module: 'name',
      constant: 'name',
    },
    scopeNodes: new Set(['program', 'class', 'module', 'singleton_method', 'method']),
  },
  swift: {
    declKinds: {
      function_declaration: 'function',
      class_declaration: 'class',
      struct_declaration: 'struct',
      enum_declaration: 'enum',
      protocol_declaration: 'interface',
      actor_declaration: 'class',
      extension_declaration: 'class',
      initializer: 'method',
      property_declaration: 'property',
    },
    nameField: {
      function_declaration: 'name',
      class_declaration: 'name',
      struct_declaration: 'name',
      enum_declaration: 'name',
      protocol_declaration: 'name',
      actor_declaration: 'name',
      extension_declaration: 'name',
      initializer: 'name',
      property_declaration: 'name',
    },
    scopeNodes: new Set([
      'source_file',
      'class_declaration',
      'struct_declaration',
      'enum_declaration',
      'protocol_declaration',
      'actor_declaration',
      'extension_declaration',
    ]),
  },
  kotlin: {
    declKinds: {
      class_declaration: 'class',
      object_declaration: 'class',
      interface_declaration: 'interface',
      function_declaration: 'function',
      property_declaration: 'property',
      type_alias: 'type',
    },
    nameField: {
      class_declaration: 'name',
      object_declaration: 'name',
      interface_declaration: 'name',
      function_declaration: 'name',
      property_declaration: 'name',
      type_alias: 'name',
    },
    scopeNodes: new Set([
      'source_file',
      'class_declaration',
      'object_declaration',
      'interface_declaration',
      'function_declaration',
    ]),
  },
  elixir: {
    declKinds: {
      // `def foo`, `defp foo`, `defmacro foo`, `macrop foo` all surface as
      // `call` nodes in the tree-sitter grammar — there is no
      // `function_definition`. The `nameExtractor` walks the call's
      // children to pick the right sibling identifier.
      call: 'function',
      module: 'namespace',
    },
    nameExtractor: (node) => {
      // The Elixir grammar produces `call` for `def foo do … end` and
      // `module` for `defmodule Foo.Bar do … end`. For `call`, we want
      // the second identifier (the function name) and verify the first
      // child is one of `def` / `defp` / `defmacro` / `macrop`. For
      // `module`, the alias is the first child of an `alias` keyword-less
      // construct — we grab the inner attribute's string content.
      if (node.type === 'module') {
        const aliasNode = node.childForFieldName('alias');
        return readFirstString(aliasNode) ?? null;
      }
      if (node.type !== 'call') return null;
      const first = node.namedChild(0);
      if (!first) return null;
      const target = first.text;
      // All Elixir definition keywords surface as `call` nodes. def/defp declare
      // named functions, defmodule declares a module, defprotocol declares a
      // behaviour, defstruct declares a struct (no symbol name in the
      // traditional sense — the field list is the value), defmacro/defmacrop
      // declare compile-time macros, and defguard/defguardp declare guard
      // macros. defstruct/defmodule (alias form) and `module` (the standalone
      // Elixir keyword) are handled above; the dispatch below covers the rest.
      if (
        target !== 'def' &&
        target !== 'defp' &&
        target !== 'defmacro' &&
        target !== 'defp_macro' &&
        target !== 'macrop' &&
        target !== 'defprotocol' &&
        target !== 'defguard' &&
        target !== 'defguardp'
      ) {
        return null;
      }
      const nameNode = node.namedChild(1);
      return nameNode?.text ?? null;
    },
    scopeNodes: new Set(['source', 'module']),
  },
  shell: {
    declKinds: {
      function_definition: 'function',
    },
    nameField: { function_definition: 'name' },
    scopeNodes: new Set(['program', 'function_definition']),
  },
};

/** Resolve the queries for a language, falling back to the default. */
export function getQueries(lang: SymbolLang): NodeQueries {
  return LANG_QUERIES[lang] ?? DEFAULT_QUERIES;
}

/** Read the first string-literal child of a node (used for Elixir aliases). */
function readFirstString(node: import('web-tree-sitter').Node | null): string | null {
  if (!node) return null;
  if (node.type === 'string_literal' || node.type === 'alias') {
    return node.text.replace(/^"|"$/g, '');
  }
  const child = node.namedChild(0);
  return child ? readFirstString(child) : null;
}
