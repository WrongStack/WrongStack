/**
 * Per-language tree-sitter node-mapping queries.
 *
 * The Day 2-3 skeleton defines the *declaration-kind* surface for each
 * language: which tree-sitter node types map to which `SymbolKind`, and how
 * to extract the symbol's name from that node. Ref/import/heritage emission
 * (calls, type references, extends/implements, include paths) landed with
 * P3.9, where real AST fixtures proved the mapping.
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
import type { RefRule } from './query-extractors.js';
import {
  cCallExtractor,
  cDeclarationKind,
  cDeclaratorNames,
  cDeclaresFunction,
  cIncludeExtractor,
  cSpecifierKind,
  declaratorNames,
  elixirDefinition,
  firstIdentifierCallExtractor,
  heritageExtractor,
  importFromText,
  phpConstructorExtractor,
  rubyCallExtractor,
  rubyInsideClass,
  sameNode,
} from './query-extractors.js';

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
 *   `refRules`     — P3.9: node types that emit cross-references (calls,
 *                    imports, heritage). Absent for languages whose grammar
 *                    would turn the rule into noise (Elixir's `call` covers
 *                    operators; shell has no symbol calls).
 */
export interface NodeQueries {
  declKinds: Record<string, SymbolKind>;
  nameField?: Partial<Record<string, string>>;
  nameExtractor?: (node: import('web-tree-sitter').Node) => string | null;
  scopeNodes?: ReadonlySet<string>;
  skipNamedChildren?: boolean;
  refRules?: Partial<Record<string, RefRule>>;
  /**
   * Final say on a matched node's kind; `null` skips it. For node types that
   * are only sometimes declarations: C's `declaration` (prototype, global or
   * local), a Ruby `constant` (assignment target or mere reference), an
   * Elixir `call` (`def` or any call at all).
   */
  resolveKind?: (node: import('web-tree-sitter').Node, kind: SymbolKind) => SymbolKind | null;
  /**
   * Names for nodes that declare several (`int a, b;`) or whose name is not an
   * identifier child. `undefined` falls back to single-name extraction.
   */
  declaredNames?: (node: import('web-tree-sitter').Node) => readonly string[] | undefined;
  /** Scope membership decided per node; replaces `scopeNodes` when set. */
  isScopeNode?: (node: import('web-tree-sitter').Node) => boolean;
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
    resolveKind: (node, kind) =>
      node.type === 'declaration' ? cDeclarationKind(node) : cSpecifierKind(node, kind),
    declaredNames: (node) =>
      node.type === 'declaration' && !cDeclaresFunction(node) ? cDeclaratorNames(node) : undefined,
    scopeNodes: new Set([
      'translation_unit',
      'function_definition',
      'struct_specifier',
      'union_specifier',
      'enum_specifier',
    ]),
    refRules: {
      // `obj->run()` and `Cls::stat()` carry structured function fields —
      // cCallExtractor handles all three AST shapes.
      call_expression: { callType: 'call', nameExtractor: cCallExtractor },
      preproc_include: { callType: 'import', nameExtractor: cIncludeExtractor },
    },
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
    resolveKind: cSpecifierKind,
    scopeNodes: new Set([
      'translation_unit',
      'function_definition',
      'class_specifier',
      'struct_specifier',
      'union_specifier',
      'enum_specifier',
      'namespace_definition',
    ]),
    refRules: {
      call_expression: { callType: 'call', nameExtractor: cCallExtractor },
      preproc_include: { callType: 'import', nameExtractor: cIncludeExtractor },
      // `class Foo : public Bar, private Baz` — the base-class clause.
      base_class_clause: { callType: 'inherit', nameExtractor: heritageExtractor },
    },
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
      constant_declaration: 'const',
    },
    declaredNames: (node) =>
      node.type === 'field_declaration' || node.type === 'constant_declaration'
        ? declaratorNames(node, new Set(['variable_declarator']))
        : undefined,
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
    // variable declarators, each emitted as its own symbol (declaredNames).
    scopeNodes: new Set([
      'program',
      'class_declaration',
      'interface_declaration',
      'enum_declaration',
      'record_declaration',
    ]),
    refRules: {
      method_invocation: { callType: 'call', field: 'name' },
      object_creation_expression: { callType: 'call', field: 'type' },
      // Verified AST: `superclass: (superclass (type_identifier))` and
      // `interfaces: (super_interfaces (type_list ...))` — no underscores.
      superclass: { callType: 'inherit', nameExtractor: heritageExtractor },
      super_interfaces: {
        callType: 'implement',
        nameExtractor: heritageExtractor,
      },
      import_declaration: {
        callType: 'import',
        nameExtractor: importFromText(['import ']),
      },
    },
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
    // Namespaces keep their full dotted name verbatim. Scoped to namespace
    // nodes: applied to every declaration it named an interface member
    // `System.Threading.Tasks.Task RunAsync();` after its RETURN TYPE.
    nameExtractor: (node) => {
      if (
        node.type !== 'namespace_declaration' &&
        node.type !== 'file_scoped_namespace_declaration'
      ) {
        return null;
      }
      const named = node.childForFieldName('name');
      if (named) return named.text;
      const inner = node.namedChild(0);
      if (inner && (inner.type === 'qualified_name' || inner.type === 'identifier')) {
        return inner.text;
      }
      return null;
    },
    declaredNames: (node) =>
      node.type === 'field_declaration'
        ? declaratorNames(node, new Set(['variable_declarator']), new Set(['variable_declaration']))
        : undefined,
    scopeNodes: new Set([
      'compilation_unit',
      'namespace_declaration',
      'class_declaration',
      'interface_declaration',
      'struct_declaration',
      'enum_declaration',
      'record_declaration',
    ]),
    refRules: {
      // Verified AST: `invocation_expression function: (identifier)` — the
      // callee field is `function` (C-style), not `name`.
      invocation_expression: { callType: 'call', field: 'function' },
      object_creation_expression: { callType: 'call', field: 'type' },
      base_list: { callType: 'inherit', nameExtractor: heritageExtractor },
      using_directive: {
        callType: 'import',
        nameExtractor: importFromText(['using ']),
      },
    },
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
      namespace_definition: 'name',
    },
    // `namespace App\Models;` — the whole qualified name, not its first
    // segment. The resolver binds `use App\Models\User` against it.
    declaredNames: (node) => {
      if (node.type !== 'namespace_definition') return undefined;
      const name = node.childForFieldName('name')?.text;
      return name ? [name] : [];
    },
    scopeNodes: new Set([
      'program',
      'namespace_definition',
      'class_declaration',
      'interface_declaration',
      'trait_declaration',
      'enum_declaration',
    ]),
    refRules: {
      function_call_expression: { callType: 'call', field: 'function' },
      // Verified AST: `new App\Model\User()` carries a BARE qualified_name
      // child (no `name:` field), so the field default never fires.
      object_creation_expression: { callType: 'call', nameExtractor: phpConstructorExtractor },
      base_clause: { callType: 'inherit', nameExtractor: heritageExtractor },
      class_interface_clause: {
        callType: 'implement',
        nameExtractor: heritageExtractor,
      },
      // Verified AST: `namespace_use_declaration (namespace_use_clause
      // (qualified_name ...))` — not `use_declaration`.
      namespace_use_declaration: {
        callType: 'import',
        nameExtractor: importFromText(['use ']),
      },
    },
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
    resolveKind: (node, kind) => {
      // A `constant` node is declared only as an assignment target
      // (`VERSION = "1"`); everywhere else it is a reference.
      if (node.type === 'constant') {
        const parent = node.parent;
        return parent?.type === 'assignment' && sameNode(parent.childForFieldName('left'), node)
          ? 'const'
          : null;
      }
      if (node.type === 'method') return rubyInsideClass(node) ? 'method' : 'function';
      return kind;
    },
    declaredNames: (node) => (node.type === 'constant' ? [node.text] : undefined),
    scopeNodes: new Set(['program', 'class', 'module', 'singleton_method', 'method']),
    refRules: {
      // `call` covers both `foo(...)` and `obj.foo(...)` — the extractor
      // records the method leaf, plus `require`/`require_relative` imports.
      call: { callType: 'call', nameExtractor: rubyCallExtractor },
      superclass: { callType: 'inherit', nameExtractor: heritageExtractor },
    },
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
      protocol_function_declaration: 'method',
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
    refRules: {
      // Verified AST: `call_expression (simple_identifier) (call_suffix …)` —
      // the callee is a bare first child, no field name.
      call_expression: { callType: 'call', nameExtractor: firstIdentifierCallExtractor },
      // Verified AST: `inheritance_specifier inherits_from: (user_type …)`.
      inheritance_specifier: { callType: 'inherit', nameExtractor: heritageExtractor },
      import_declaration: {
        callType: 'import',
        nameExtractor: importFromText(['import ', 'import type ', '@testable import ']),
      },
    },
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
    declaredNames: (node) =>
      node.type === 'property_declaration'
        ? declaratorNames(
            node,
            new Set(['variable_declaration']),
            new Set(['multi_variable_declaration']),
          )
        : undefined,
    scopeNodes: new Set([
      'source_file',
      'class_declaration',
      'object_declaration',
      'interface_declaration',
      'function_declaration',
    ]),
    refRules: {
      call_expression: { callType: 'call', nameExtractor: firstIdentifierCallExtractor },
      // Verified AST: `delegation_specifier (user_type (type_identifier))` —
      // the `: Handler` / `: Base()` clause.
      delegation_specifier: { callType: 'inherit', nameExtractor: heritageExtractor },
      import_header: {
        callType: 'import',
        nameExtractor: importFromText(['import ']),
      },
    },
  },
  elixir: {
    // Every Elixir definition is a `call` node (`def`, `defmodule`, …), and so
    // is every ordinary call. The previous table indexed `defmodule` itself as
    // a function named "defmodule", named each def after its whole argument
    // text ("total(items), do: …"), and emitted a function symbol for every
    // plain call in every body. elixirDefinition decides all three.
    declKinds: {
      call: 'function',
    },
    resolveKind: (node) => elixirDefinition(node)?.kind ?? null,
    nameExtractor: (node) => elixirDefinition(node)?.name ?? null,
    isScopeNode: (node) => elixirDefinition(node)?.kind === 'namespace',
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
export type { RefEmission, RefRule } from './query-extractors.js';
