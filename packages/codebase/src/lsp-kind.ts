/**
 * LSP SymbolKind mapping utilities.
 *
 * LSP SymbolKind numbers are defined by vscode-languageserver-protocol.
 * This module maps between LSP kind numbers and the internal SymbolKind taxonomy.
 */

import type { SymbolKind } from './schema.js';

/**
 * LSP SymbolKind values (1–26) as defined by vscode-languageserver-protocol.
 */
export enum LSPSymbolKind {
  File = 1,
  Module = 2,
  Namespace = 3,
  Package = 4,
  Class = 5,
  Method = 6,
  Property = 7,
  Field = 8,
  Constructor = 9,
  Enum = 10,
  Interface = 11,
  Function = 12,
  Variable = 13,
  Constant = 14,
  String = 15,
  Number = 16,
  Boolean = 17,
  Array = 18,
  Object = 19,
  Key = 20,
  Null = 21,
  EnumMember = 22,
  Struct = 23,
  Event = 24,
  Operator = 25,
  TypeParameter = 26,
}

/**
 * Every internal kind an LSP kind covers, primary kind first.
 *
 * One LSP kind can span several internal kinds: `Variable` is both `var` and
 * `let`, `Interface` is both `interface` and Rust's `trait`. A single-kind
 * mapping made an `lspKind: 13` filter silently drop every `let`.
 *
 * `Constructor` and `EnumMember` are deliberately absent: the index stores
 * neither, and the old `class`/`enum` stand-ins answered a constructor filter
 * with classes and an enum-member filter with enums.
 */
const LSP_TO_INTERNAL_KINDS: Readonly<Partial<Record<number, readonly SymbolKind[]>>> = {
  [LSPSymbolKind.Module]: ['mod'],
  [LSPSymbolKind.Namespace]: ['namespace'],
  [LSPSymbolKind.Class]: ['class'],
  [LSPSymbolKind.Method]: ['method'],
  [LSPSymbolKind.Property]: ['property'],
  [LSPSymbolKind.Field]: ['property'],
  [LSPSymbolKind.Enum]: ['enum'],
  [LSPSymbolKind.Interface]: ['interface', 'trait'],
  [LSPSymbolKind.Function]: ['function'],
  [LSPSymbolKind.Variable]: ['var', 'let'],
  [LSPSymbolKind.Constant]: ['const', 'static'],
  [LSPSymbolKind.Object]: ['object'],
  [LSPSymbolKind.Struct]: ['struct'],
  [LSPSymbolKind.TypeParameter]: ['type'],
};

/** All internal kinds an LSP kind number covers; empty when it has no equivalent. */
export function lspKindToInternalKinds(k: number): readonly SymbolKind[] {
  return LSP_TO_INTERNAL_KINDS[k] ?? [];
}

/**
 * Maps an LSP kind number to its primary internal SymbolKind.
 * Returns null if the LSP kind has no equivalent in the internal taxonomy.
 */
export function lspKindToInternalKind(k: number): SymbolKind | null {
  return LSP_TO_INTERNAL_KINDS[k]?.[0] ?? null;
}

/**
 * Maps an internal SymbolKind to the corresponding LSP kind number.
 * Returns null if the internal kind has no equivalent LSP kind.
 */
export function internalKindToLspKind(k: SymbolKind): number | null {
  switch (k) {
    case 'class':
      return LSPSymbolKind.Class;
    case 'method':
      return LSPSymbolKind.Method;
    case 'property':
      return LSPSymbolKind.Property;
    case 'function':
      return LSPSymbolKind.Function;
    case 'var':
      return LSPSymbolKind.Variable;
    case 'const':
      return LSPSymbolKind.Constant;
    case 'let':
      return LSPSymbolKind.Variable;
    case 'enum':
      return LSPSymbolKind.Enum;
    case 'interface':
      return LSPSymbolKind.Interface;
    case 'namespace':
      return LSPSymbolKind.Namespace;
    case 'type':
      return LSPSymbolKind.TypeParameter;
    case 'struct':
      return LSPSymbolKind.Struct;
    case 'trait':
      return LSPSymbolKind.Interface;
    case 'mod':
      return LSPSymbolKind.Module;
    case 'object':
      return LSPSymbolKind.Object;
    case 'static':
      return LSPSymbolKind.Constant;
    // parameter, impl, literal, schema have no LSP equivalent
    default:
      return null;
  }
}

/**
 * Returns true if `k` is a valid LSP SymbolKind number (1–26).
 */
export function isLspKind(k: number): boolean {
  return Number.isInteger(k) && k >= 1 && k <= 26;
}
