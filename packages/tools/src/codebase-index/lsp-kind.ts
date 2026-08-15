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
 * Maps an LSP kind number to the corresponding internal SymbolKind.
 * Returns null if the LSP kind has no equivalent in the internal taxonomy.
 */
export function lspKindToInternalKind(k: number): SymbolKind | null {
  switch (k) {
    case LSPSymbolKind.Class:
      return 'class';
    case LSPSymbolKind.Method:
      return 'method';
    case LSPSymbolKind.Property:
    case LSPSymbolKind.Field:
      return 'property';
    case LSPSymbolKind.Constructor:
      return 'class';
    case LSPSymbolKind.Enum:
      return 'enum';
    case LSPSymbolKind.Interface:
      return 'interface';
    case LSPSymbolKind.Function:
      return 'function';
    case LSPSymbolKind.Variable:
      return 'var';
    case LSPSymbolKind.Constant:
      return 'const';
    case LSPSymbolKind.EnumMember:
      return 'enum';
    case LSPSymbolKind.TypeParameter:
      return 'type';
    case LSPSymbolKind.Namespace:
      return 'namespace';
    default:
      return null;
  }
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
    // parameter and other internal-only kinds have no LSP equivalent
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
