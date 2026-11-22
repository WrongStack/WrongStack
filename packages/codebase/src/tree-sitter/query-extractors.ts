import type { CallType, SymbolKind } from '../schema.js';

type TsNode = import('web-tree-sitter').Node;

const NAME_LIKE_TYPES: ReadonlySet<string> = new Set([
  'identifier',
  'simple_identifier',
  'type_identifier',
  'field_identifier',
  'name',
  'constant',
]);

function namedChildrenOf(node: TsNode): TsNode[] {
  const out: TsNode[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) out.push(child);
  }
  return out;
}

/**
 * Names of the declarators under a field/property declaration. The first
 * identifier-shaped child used to be taken as THE name, which for
 * `private String name;` is the type `String` — and a primitive-typed
 * `int a, b;` had no identifier child at all, so it was never indexed.
 */
export function declaratorNames(
  node: TsNode,
  declaratorTypes: ReadonlySet<string>,
  containerTypes: ReadonlySet<string> = new Set(),
): string[] {
  const out: string[] = [];
  const walk = (current: TsNode, depth: number): void => {
    for (const child of namedChildrenOf(current)) {
      if (declaratorTypes.has(child.type)) {
        const id =
          child.childForFieldName('name') ??
          namedChildrenOf(child).find((c) => NAME_LIKE_TYPES.has(c.type));
        if (id) out.push(id.text);
      } else if (depth < 2 && containerTypes.has(child.type)) {
        walk(child, depth + 1);
      }
    }
  };
  walk(node, 0);
  return out;
}

/** Innermost identifier of each `declarator:` of a C declaration. */
export function cDeclaratorNames(node: TsNode): string[] {
  const out: string[] = [];
  for (const declarator of node.childrenForFieldName('declarator')) {
    let current: TsNode | null = declarator;
    for (let depth = 0; current && depth < 16; depth++) {
      if (current.type === 'identifier') {
        out.push(current.text);
        break;
      }
      current = current.childForFieldName('declarator');
    }
  }
  return out;
}

export function cDeclaresFunction(node: TsNode): boolean {
  for (const declarator of node.childrenForFieldName('declarator')) {
    let current: TsNode | null = declarator;
    for (let depth = 0; current && depth < 16; depth++) {
      if (current.type === 'function_declarator') return true;
      current = current.childForFieldName('declarator');
    }
  }
  return false;
}

/**
 * A C `declaration` is a prototype, a file-scope variable, or a local. Every
 * one of them used to be indexed as a `function` — each local variable of
 * every function body included.
 */
export function cDeclarationKind(node: TsNode): SymbolKind | null {
  if (cDeclaresFunction(node)) return 'function';
  let parent = node.parent;
  while (parent?.type.startsWith('preproc_')) parent = parent.parent;
  return parent?.type === 'translation_unit' ? 'var' : null;
}

const C_SPECIFIER_TYPES: ReadonlySet<string> = new Set([
  'struct_specifier',
  'union_specifier',
  'enum_specifier',
  'class_specifier',
]);

/**
 * `struct node *next` and `class Foo;` are references to a type, not its
 * definition: only a specifier with a body declares one. Without this every
 * parameter of type `struct x *` added another "struct x" symbol.
 */
export function cSpecifierKind(node: TsNode, kind: SymbolKind): SymbolKind | null {
  if (!C_SPECIFIER_TYPES.has(node.type)) return kind;
  return node.childForFieldName('body') ? kind : null;
}

export function sameNode(a: TsNode | null, b: TsNode): boolean {
  return a !== null && a.startIndex === b.startIndex && a.endIndex === b.endIndex;
}

/** Ruby: methods defined inside a class/module are methods. */
export function rubyInsideClass(node: TsNode): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type === 'class' || parent.type === 'module' || parent.type === 'singleton_class') {
      return true;
    }
    if (parent.type === 'method' || parent.type === 'singleton_method') return false;
  }
  return false;
}

/**
 * Elixir definitions are calls: `def total(items)`, `defp tax(x) when x > 0`,
 * `defmodule Billing.Invoice`. Anything else — which is almost every `call`
 * node in a file — is not a declaration.
 */
const ELIXIR_FUNCTION_DEFS: ReadonlySet<string> = new Set([
  'def',
  'defp',
  'defmacro',
  'defmacrop',
  'defguard',
  'defguardp',
  'defdelegate',
]);
const ELIXIR_MODULE_DEFS: ReadonlySet<string> = new Set(['defmodule', 'defprotocol']);

export function elixirDefinition(node: TsNode): { kind: SymbolKind; name: string } | null {
  if (node.type !== 'call') return null;
  const target = node.childForFieldName('target') ?? node.namedChild(0);
  if (target?.type !== 'identifier') return null;
  const args = namedChildrenOf(node).find((child) => child.type === 'arguments');
  const head = args?.namedChild(0);
  if (!head) return null;
  if (ELIXIR_MODULE_DEFS.has(target.text)) {
    return head.type === 'alias' ? { kind: 'namespace', name: head.text } : null;
  }
  if (!ELIXIR_FUNCTION_DEFS.has(target.text)) return null;
  const name = elixirFunctionName(head, 0);
  return name ? { kind: 'function', name } : null;
}

function elixirFunctionName(head: TsNode, depth: number): string | null {
  if (depth > 3) return null;
  // `def ready?, do: true`
  if (head.type === 'identifier') return head.text;
  // `def total(items)`
  if (head.type === 'call') {
    const target = head.childForFieldName('target') ?? head.namedChild(0);
    return target?.type === 'identifier' ? target.text : null;
  }
  // `defp tax(x) when x > 0`
  if (head.type === 'binary_operator') {
    const left = head.childForFieldName('left') ?? head.namedChild(0);
    return left ? elixirFunctionName(left, depth + 1) : null;
  }
  return null;
}

/** One ref a refRule wants emitted. `callType` defaults to the rule's. */
export interface RefEmission {
  toName: string;
  callType?: CallType;
  module?: string;
}

/**
 * How to turn one tree-sitter node into refs.
 *
 *   `callType`      — the ref kind this rule emits.
 *   `field`         — field carrying the callee/target (e.g. `'function'`).
 *                     Default when no extractor: leaf-name of that field.
 *   `nameExtractor` — full control (multi-ref nodes like heritage lists,
 *                     imports whose module must be derived from the node
 *                     text, Ruby `require` calls). Return `null`/`[]` to
 *                     emit nothing for this node.
 */
export interface RefRule {
  callType: CallType;
  field?: string;
  nameExtractor?: (node: import('web-tree-sitter').Node) => ReadonlyArray<RefEmission> | null;
}

/**
 * PHP grouped use — `use App\{Foo, Bar as B};` binds EACH member, not one
 * fused emission. Each member keeps its own alias handling (the alias is
 * local-only; the ref targets the original member).
 */
function parseGroupedUse(text: string): ReadonlyArray<RefEmission> | null {
  const open = text.indexOf('{');
  const close = text.lastIndexOf('}');
  if (open < 0 || close <= open) return null;
  const prefix = text.slice(0, open).replace(/[\\/]+$/, '');
  const out: RefEmission[] = [];
  for (const rawMember of text.slice(open + 1, close).split(',')) {
    let member = rawMember.trim();
    if (!member) continue;
    // Mixed groups can qualify per member: `use App\{Foo, function bar}`.
    member = member
      .replace(
        /^(static|final|type|class|struct|enum|protocol|var|func|let|typealias|function|const)\s+/i,
        '',
      )
      .trim();
    if (!member) continue;
    const aliasMatch = /\s+as\s+([A-Za-z_]\w*)\s*$/i.exec(member);
    if (aliasMatch) member = member.slice(0, aliasMatch.index).trim();
    if (!member) continue;
    const module = prefix ? `${prefix}\\${member}` : member;
    const toName = member.split(/[\\/]/).filter(Boolean).pop();
    if (toName) out.push({ toName, callType: 'import', module });
  }
  return out.length ? out : null;
}

/** Strip `import`-shaped node text into `{toName, module}` emissions. */
export function importFromText(prefixes: readonly string[]): NonNullable<RefRule['nameExtractor']> {
  return (node) => {
    let text = node.text.replace(/\s+/g, ' ').trim();
    for (const prefix of prefixes) {
      if (text.startsWith(prefix)) text = text.slice(prefix.length).trim();
    }
    // Import modifiers, stripped BEFORE module derivation so they never
    // pollute `module`: java `import static x.y.Z` and c# `using static`
    // bind the member; swift kind-qualified imports (`import class
    // Foundation.URLSession`) bind URLSession; php `use function App\foo`
    // binds foo.
    text = text
      .replace(
        /^(static|final|type|class|struct|enum|protocol|var|func|let|typealias|function|const)\s+/i,
        '',
      )
      .trim();
    // PHP grouped use — detected after modifier strip (`use function
    // App\{foo}`) but before the trailing-`;}` strip (the group's closing
    // brace is load-bearing there).
    if (text.includes('{')) return parseGroupedUse(text);
    // PHP multi-clause use — `use A\B, C\D;` and `use function App\foo,
    // const App\BAR;` bind EACH clause (verified AST:
    // namespace_use_declaration carries multiple namespace_use_clause
    // children; the refRule fires on the declaration node whose text
    // spans them all). Without this split the clauses fuse into one
    // bogus module (`App\foo, const App\BAR`) and every clause but the
    // last loses its binding.
    //   Comma guard: C# using-aliases may contain commas inside generic
    // argument lists (`using L = List<int, string>;`) AND in non-generic
    // alias targets (`using Pair = (int, string);`, `using M = int[,]`)
    // and must NOT split. PHP use clauses can never contain `<` — and
    // PHP aliases are written `as`, never `=` — so either marker exempts
    // the text from the split.
    if (text.includes(',') && !text.includes('<') && !text.includes('=')) {
      const out: RefEmission[] = [];
      for (const clause of text.split(',')) {
        const one = oneImportClause(clause.trim());
        if (one) out.push(one);
      }
      return out.length ? out : null;
    }
    // oneImportClause yields ONE emission; the visitor iterates an ARRAY —
    // a bare object here throws at the first import node and aborts every
    // ref for the file (caught by the P3.9 suite: files with imports lost
    // their call refs too).
    const single = oneImportClause(text);
    return single ? [single] : null;
  };
}

/** Resolve one comma-free import clause to its `{toName, module}` emission. */
function oneImportClause(rawClause: string): RefEmission | null {
  let text = rawClause;
  // Per-clause modifier strip — mixed clauses carry their own kind:
  // `use function App\foo, const App\BAR;`.
  text = text
    .replace(
      /^(static|final|type|class|struct|enum|protocol|var|func|let|typealias|function|const)\s+/i,
      '',
    )
    .trim();
  // Trailing `;`/`}` BEFORE alias handling — the alias regex is
  // `$`-anchored and PHP writes `use App\Models\User as U;`.
  text = text.replace(/[;}]+$/g, '').trim();
  // Alias imports — `use App\Models\User as U`, `import com.example.Foo
  // as Bar`, `using Txt = System.Text`. The alias is the LOCAL name; the
  // ref must target the ORIGINAL (pre-alias) symbol so resolution binds
  // to its declaration, not to the aliasing file. PHP's `AS` is
  // case-insensitive, like every PHP keyword.
  const aliasMatch = /\s+as\s+([A-Za-z_]\w*)\s*$/i.exec(text);
  if (aliasMatch) text = text.slice(0, aliasMatch.index).trim();
  const eqMatch = /^([A-Za-z_]\w*)\s*=\s*(.+)$/.exec(text);
  if (eqMatch) text = eqMatch[2]!.trim();
  if (!text) return null;
  // Java/C# wildcard imports (`a.b.*`) bind the package, not a symbol.
  if (text.endsWith('*')) text = text.slice(0, -1).replace(/[.]$/, '');
  if (!text) return null;
  const module = text;
  // Strip a generic-argument tail from the LEAF before name resolution:
  // `using L = System.Collections.Generic.List<int, string>` resolves by
  // NAME to the `List` declaration — `List<int, string>` would never match.
  // (heritageLeaf's text fallback strips the same tail for the same reason.)
  const toName = module
    .split(/[.\\/]/)
    .filter(Boolean)
    .pop()
    ?.replace(/<.*>$/s, '');
  if (!toName) return null;

  return { toName, callType: 'import', module };
}

/**
 * Heritage lists (`base_list`, `super_interface_list`, …) carry several
 * target names in one node — collect every identifier-shaped descendant
 * within a small depth budget.
 *
 * Qualified names resolve to their LEAF segment only. Verified AST shapes:
 *  - java `scoped_type_identifier` (nested: `com.example.Base` → 3 levels)
 *  - c# `qualified_name` in base_list (`App.Base`)
 *  - php `qualified_name` in base_clause (`App\Base`)
 *  - kotlin `user_type` with segment `type_identifier` children
 *  - ruby `scope_resolution` (`Bar::Baz`) — the `name:` constant is the
 *    actual superclass
 * Generic type arguments are NOT the declared name: `extends Base<Foo>`
 * nests (type_arguments (type_identifier)) — recursing it would emit Foo
 * as a phantom inherit ref, so argument subtrees are skipped everywhere.
 */
export const heritageExtractor: NonNullable<RefRule['nameExtractor']> = (node) => {
  const out: RefEmission[] = [];
  // Subtrees that are NEVER the declared name: type arguments/parameters and
  // call arguments. C# also allows predefined types there (`IFoo<string>` →
  // (predefined_type)), which the identifier checks below ignore anyway.
  const SKIP_SUBTREES = new Set([
    'type_arguments',
    'type_argument_list',
    // tree-sitter-cpp names its argument subtree template_argument_list —
    // verified AST: (base_class_clause (template_type name:
    // (type_identifier) arguments: (template_argument_list
    // (type_descriptor type: (type_identifier))))). Without this entry
    // `class D : Base<Foo>` recurses into the descriptor and emits Foo as a
    // phantom inherit ref.
    'template_argument_list',
    'type_parameter_list',
    'type_projection',
    'value_arguments',
  ]);
  const collect = (current: import('web-tree-sitter').Node, depth: number): void => {
    if (depth > 4) return;
    for (let i = 0; i < current.namedChildCount; i++) {
      const child = current.namedChild(i);
      if (!child) continue;
      if (SKIP_SUBTREES.has(child.type)) continue;
      if (
        child.type === 'type_identifier' ||
        child.type === 'identifier' ||
        child.type === 'named_type' ||
        child.type === 'type' ||
        // PHP heritage carries `name`; Ruby a `constant`.
        child.type === 'constant' ||
        child.type === 'name'
      ) {
        const name = child.type === 'named_type' ? leafSegment(child.text) : child.text;
        if (name) out.push({ toName: name });
        continue;
      }
      // Generic wrappers (java `generic_type`, c# `generic_name`): the
      // declared name is the first identifier-shaped child — its trailing
      // type_arguments child is noise (guarded above too, belt and braces).
      if (child.type === 'generic_type' || child.type === 'generic_name') {
        for (let j = 0; j < child.namedChildCount; j++) {
          const inner = child.namedChild(j);
          if (
            inner &&
            !SKIP_SUBTREES.has(inner.type) &&
            (inner.type === 'type_identifier' ||
              inner.type === 'identifier' ||
              inner.type === 'name')
          ) {
            out.push({ toName: inner.text });
            break;
          }
        }
        continue;
      }
      // Qualified forms: take the declared leaf, never every segment.
      if (
        child.type === 'qualified_name' ||
        child.type === 'scoped_type_identifier' ||
        child.type === 'user_type' ||
        child.type === 'scope_resolution'
      ) {
        const leaf = heritageLeaf(child, 0);
        if (leaf) out.push({ toName: leaf });
        continue;
      }
      collect(child, depth + 1);
    }
  };
  collect(node, 0);
  return out;
};

/** Leaf segment of a qualified heritage name. */
function heritageLeaf(node: import('web-tree-sitter').Node, depth: number): string | null {
  if (depth > 6) return null;
  // Field access first: java scoped_type_identifier / ruby scope_resolution
  // expose the declared name via `name:`.
  const named = node.childForFieldName('name');
  if (named) {
    // A `name:` field may itself be qualified (java nests
    // scoped_type_identifier under `name:`) — recurse.
    if (
      named.type === 'scoped_type_identifier' ||
      named.type === 'qualified_name' ||
      named.type === 'scope_resolution' ||
      named.type === 'user_type'
    ) {
      return heritageLeaf(named, depth + 1);
    }
    return named.text;
  }
  // Kotlin `user_type` has no name field; its LAST type_identifier child is
  // the leaf (`com.example.Base` → children [com, example, Base]). PHP's
  // `qualified_name` leaf child is typed `name` (verified AST).
  const children: import('web-tree-sitter').Node[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c) children.push(c);
  }
  for (let i = children.length - 1; i >= 0; i--) {
    const c = children[i]!;
    // Skip argument subtrees — `Handler<Event>`'s last child is
    // type_arguments, never the declared name (matches SKIP_SUBTREES above).
    if (
      c.type === 'type_arguments' ||
      c.type === 'type_argument_list' ||
      // cpp: (template_type arguments: (template_argument_list …)) — the
      // descriptor's type_identifier inside it is never the declared base.
      c.type === 'template_argument_list' ||
      c.type === 'type_parameter_list' ||
      c.type === 'type_projection' ||
      c.type === 'value_arguments'
    ) {
      continue;
    }
    if (
      c.type === 'type_identifier' ||
      c.type === 'identifier' ||
      c.type === 'constant' ||
      c.type === 'name'
    ) {
      return c.text;
    }
    if (
      c.type === 'scoped_type_identifier' ||
      c.type === 'qualified_name' ||
      c.type === 'scope_resolution' ||
      c.type === 'user_type'
    ) {
      return heritageLeaf(c, depth + 1);
    }
  }
  // Fallback: leaf segment of the node's own text (`.`-qualified, PHP
  // `\`-namespaced, C++ `::`-scoped), with any `<...>` argument tail removed.
  return leafSegment(
    node.text
      .replace(/\\/g, '.')
      .replace(/::/g, '.')
      .replace(/<[^<>]*>$/, ''),
  );
}

/** Last `.`-separated segment of a dotted name. */
function leafSegment(text: string): string {
  return text.split('.').filter(Boolean).pop() ?? text;
}

/**
 * C/C++ call extractor. The `function` field of a `call_expression` is not
 * always a bare identifier — verified AST forms:
 *  - `obj->run()`  → `field_expression (argument: (identifier) field: (field_identifier))`
 *  - `Cls::stat()` → `qualified_identifier (scope: (namespace_identifier) name: (identifier))`
 *  - `helper()`    → `identifier`
 * The declared method name is the FIELD/NAME child (`run`, `stat`) — the
 * receiver (`obj`, `Cls`) is not a symbol reference by itself.
 */
export const cCallExtractor: NonNullable<RefRule['nameExtractor']> = (node) => {
  const fn = node.childForFieldName('function');
  if (!fn) return null;
  if (fn.type === 'field_expression') {
    // `obj->method()` / `obj.method()` — method is the declared symbol.
    const field = fn.childForFieldName('field');
    if (field) return [{ toName: field.text, callType: 'call' }];
    const seg = fn.text.split('->').filter(Boolean).pop();
    if (seg) return [{ toName: leafSegment(seg.split('.')[0] ?? seg), callType: 'call' }];
    return null;
  }
  if (fn.type === 'qualified_identifier') {
    // `Cls::method()` — method is the `name:` child; `Cls` is the scope.
    const name = fn.childForFieldName('name');
    if (name) return [{ toName: name.text, callType: 'call' }];
    const seg = fn.text.split('::').filter(Boolean).pop();
    if (seg) return [{ toName: seg.split(/[<(]/)[0]!.trim(), callType: 'call' }];
    return null;
  }
  // Bare identifier — leaf of the raw text.
  return [{ toName: fn.text.split(/[<(]/)[0]!.trim(), callType: 'call' }];
};

/** Ruby `call`: the method ref, plus `require`/`require_relative` imports. */
export const rubyCallExtractor: NonNullable<RefRule['nameExtractor']> = (node) => {
  const emissions: RefEmission[] = [];
  const method = node.childForFieldName('method');
  if (method) {
    const name = method.text;
    if (name && !name.includes(' ')) emissions.push({ toName: name, callType: 'call' });
    if (name === 'require' || name === 'require_relative') {
      const args = node.childForFieldName('arguments');
      const first = args?.namedChild(0);
      if (first) {
        const raw = first.text.replace(/^['"]|['"]$/g, '');
        const toName = raw.split('/').filter(Boolean).pop();
        if (toName) emissions.push({ toName, callType: 'import', module: raw });
      }
    }
  }
  return emissions;
};

/** First-identifier call extractor for `call_expression` nodes whose
 *  grammar carries no callee field (Kotlin `simple_identifier` + suffix,
 *  Swift `simple_identifier` + `call_suffix`). */
export const firstIdentifierCallExtractor: NonNullable<RefRule['nameExtractor']> = (node) => {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child && (child.type === 'simple_identifier' || child.type === 'identifier')) {
      return [{ toName: child.text, callType: 'call' }];
    }
  }
  const first = node.namedChild(0);
  if (!first) return null;
  const leaf = leafSegment(first.text.split(/[<(]/)[0] ?? first.text);
  if (!leaf) return null;
  return [{ toName: leaf, callType: 'call' }];
};

/** C `#include`: module from the quoted/bracketed path. */
export const cIncludeExtractor: NonNullable<RefRule['nameExtractor']> = (node) => {
  const raw = node.text.replace(/^#\s*include\s*/i, '').trim();
  const module = raw.replace(/^["'<]|["'>]$/g, '');
  if (!module) return null;
  const toName = module.split('/').pop()?.replace(/\.h$/, '');
  if (!toName) return null;
  return [{ toName, callType: 'import', module }];
};

/**
 * PHP constructor calls. Verified AST: `new App\Model\User()` →
 * (object_creation_expression (qualified_name prefix: … (name)) (arguments))
 * — a BARE qualified_name child, no `name:` field (and unqualified `new
 * User()` likewise), so the field-based default never fires. Take the first
 * qualified_name/name child and leaf-split on the namespace separator.
 */
export const phpConstructorExtractor: NonNullable<RefRule['nameExtractor']> = (node) => {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child && (child.type === 'qualified_name' || child.type === 'name')) {
      const leaf = child.text.split(/[\\]/).filter(Boolean).pop();
      if (leaf) return [{ toName: leaf, callType: 'call' }];
    }
  }
  return null;
};
