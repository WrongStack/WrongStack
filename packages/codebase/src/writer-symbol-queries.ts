import type { CallSite, SymbolKind } from './schema.js';
import {
  findIncomingCallsByName,
  findOutgoingCallsByName,
  findTransitiveIncomingCallsByName,
  findTransitiveOutgoingCallsByName,
  getFileSymbolsWithStatement,
  getSymbolsByIdsWithStatement,
} from './writer-graph-reader.js';
import {
  getImportVisibilityWithStatement,
  getSymbolGraphFactsWithStatement,
} from './writer-rank.js';
import { getAllImportRefsWithStatement, getAllResolvedRefsWithStatement } from './writer-refs.js';

export interface WriterSymbolQueriesHost {
  stmt: (sql: string) => import('node:sqlite').StatementSync;
}

export function findIncomingCallsByNameFromStore(
  this: WriterSymbolQueriesHost,
  symbolName: string,
  file?: string,
  limit = 100,
): { calls: CallSite[]; symbolFound: boolean; ambiguous: boolean; totalMatches: number } {
  return findIncomingCallsByName((sql) => this.stmt(sql), symbolName, file, limit);
}

export function findOutgoingCallsByNameFromStore(
  this: WriterSymbolQueriesHost,
  symbolName: string,
  file?: string,
  limit = 100,
): { calls: CallSite[]; symbolFound: boolean; unresolvedCount: number; totalMatches: number } {
  return findOutgoingCallsByName((sql) => this.stmt(sql), symbolName, file, limit);
}

export function findTransitiveIncomingCallsByNameFromStore(
  this: WriterSymbolQueriesHost,
  symbolName: string,
  file?: string,
  limit = 200,
): { calls: CallSite[]; symbolFound: boolean; ambiguous: boolean; totalMatches: number } {
  return findTransitiveIncomingCallsByName((sql) => this.stmt(sql), symbolName, file, limit);
}

export function findTransitiveOutgoingCallsByNameFromStore(
  this: WriterSymbolQueriesHost,
  symbolName: string,
  file?: string,
  limit = 200,
): { calls: CallSite[]; symbolFound: boolean; unresolvedCount: number; totalMatches: number } {
  return findTransitiveOutgoingCallsByName((sql) => this.stmt(sql), symbolName, file, limit);
}

export function getAllSymbols(this: WriterSymbolQueriesHost): Array<{
  id: number;
  name: string;
  file: string;
  kind: SymbolKind;
  line: number;
  scope: string;
}> {
  return (
    this.stmt('SELECT id, name, file, kind, line, scope FROM symbols ORDER BY id').all() as Array<{
      id: number;
      name: string;
      file: string;
      kind: string;
      line: number;
      scope: string;
    }>
  ).map((r) => ({ ...r, kind: r.kind as SymbolKind }));
}

export function getFileSymbols(
  this: WriterSymbolQueriesHost,
  file: string,
  limit: number,
): Array<{
  id: number;
  name: string;
  kind: string;
  line: number;
  endLine?: number | undefined;
  isExported?: boolean | undefined;
  signature: string;
}> {
  return getFileSymbolsWithStatement((sql) => this.stmt(sql), file, limit);
}

export function getSymbolsByIds(
  this: WriterSymbolQueriesHost,
  ids: readonly number[],
): Array<{
  id: number;
  name: string;
  kind: string;
  lang: string;
  file: string;
  line: number;
  signature: string;
  scope: string;
}> {
  return getSymbolsByIdsWithStatement((sql) => this.stmt(sql), ids);
}

export function getAllResolvedRefs(this: WriterSymbolQueriesHost): Array<{
  fromId: number;
  toId: number;
  callType: string;
}> {
  return getAllResolvedRefsWithStatement((sql) => this.stmt(sql));
}

export function getSymbolGraphFacts(this: WriterSymbolQueriesHost): {
  fileOf: Map<number, string>;
  candidates: Map<number, number>;
  shadowedModules: Set<number>;
} {
  return getSymbolGraphFactsWithStatement((sql) => this.stmt(sql));
}

export function getImportVisibility(this: WriterSymbolQueriesHost): Map<string, Set<string>> {
  return getImportVisibilityWithStatement((sql) => this.stmt(sql));
}

export function getAllImportRefs(this: WriterSymbolQueriesHost): Array<{
  sourceFile: string | null;
  toName: string;
  toId: number | null;
  callType: string;
  line: number;
}> {
  return getAllImportRefsWithStatement((sql) => this.stmt(sql));
}
