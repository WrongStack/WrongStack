/**
 * Derived-layer reads and writes of {@link IndexStore} (writer.ts): call
 * graph queries, rank tables, semantic file vectors and the concept layer.
 */

import { computeFileStructuralFingerprintWithStatement } from './fingerprint.js';
import type { FileRankRow, SymbolRankRow } from './graph-rank.js';
import type { CallSite, CodeMapGraph, Ref, SymbolKind } from './schema.js';
import type { ConceptCoverage, ConceptEdge, FileConcept, Subsystem } from './writer-concepts.js';
import * as writerConcepts from './writer-concepts.js';
import { decorateGraphNodesWithMemories } from './writer-graph-decorate.js';
import * as writerGraphReader from './writer-graph-reader.js';
import type { RankedFileRow } from './writer-rank.js';
import * as writerRank from './writer-rank.js';
import { IndexStoreBase } from './writer-store-base.js';
import * as writerSymbolQueries from './writer-symbol-queries.js';
import type { FileVectorRow, VectorHit } from './writer-vectors.js';
import * as writerVectors from './writer-vectors.js';

export abstract class IndexStoreDerivedLayers extends IndexStoreBase {
  findIncomingCallsByName(
    symbolName: string,
    file?: string,
    limit = 100,
  ): { calls: CallSite[]; symbolFound: boolean; ambiguous: boolean; totalMatches: number } {
    return writerSymbolQueries.findIncomingCallsByNameFromStore.call(
      this.writerSymbolQueriesHost(),
      symbolName,
      file,
      limit,
    );
  }

  findOutgoingCallsByName(
    symbolName: string,
    file?: string,
    limit = 100,
  ): { calls: CallSite[]; symbolFound: boolean; unresolvedCount: number; totalMatches: number } {
    return writerSymbolQueries.findOutgoingCallsByNameFromStore.call(
      this.writerSymbolQueriesHost(),
      symbolName,
      file,
      limit,
    );
  }

  findTransitiveIncomingCallsByName(
    symbolName: string,
    file?: string,
    limit = 200,
  ): { calls: CallSite[]; symbolFound: boolean; ambiguous: boolean; totalMatches: number } {
    return writerSymbolQueries.findTransitiveIncomingCallsByNameFromStore.call(
      this.writerSymbolQueriesHost(),
      symbolName,
      file,
      limit,
    );
  }

  findTransitiveOutgoingCallsByName(
    symbolName: string,
    file?: string,
    limit = 200,
  ): { calls: CallSite[]; symbolFound: boolean; unresolvedCount: number; totalMatches: number } {
    return writerSymbolQueries.findTransitiveOutgoingCallsByNameFromStore.call(
      this.writerSymbolQueriesHost(),
      symbolName,
      file,
      limit,
    );
  }

  findRefsTo(symbolId: number): Ref[] {
    return writerGraphReader.findRefsToWithStatement((sql) => this.stmt(sql), symbolId);
  }

  findRefsFrom(symbolId: number): Ref[] {
    return writerGraphReader.findRefsFromWithStatement((sql) => this.stmt(sql), symbolId);
  }

  getPackageGraph(): CodeMapGraph {
    return writerGraphReader.getPackageGraphWithStatement((sql) => this.stmt(sql));
  }

  getFileGraph(packageFilter: string): CodeMapGraph {
    const graph = writerGraphReader.getFileGraphWithStatement(
      (sql) => this.stmt(sql),
      packageFilter,
    );
    decorateGraphNodesWithMemories(this.projectRoot, graph.nodes);
    return graph;
  }

  getSymbolGraph(fileFilter: string): CodeMapGraph {
    const graph = writerGraphReader.getSymbolGraphWithStatement(
      (sql) => this.stmt(sql),
      fileFilter,
    );
    decorateGraphNodesWithMemories(this.projectRoot, graph.nodes);
    return graph;
  }

  getAllSymbols(): Array<{
    id: number;
    name: string;
    file: string;
    kind: SymbolKind;
    line: number;
    scope: string;
  }> {
    return writerSymbolQueries.getAllSymbols.call(this.writerSymbolQueriesHost());
  }

  /** Declarations in one file, in source order. */
  getFileSymbols(
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
    return writerSymbolQueries.getFileSymbols.call(this.writerSymbolQueriesHost(), file, limit);
  }

  /** Declarations behind an arbitrary id list, for the retrieval walk. */
  getSymbolsByIds(ids: readonly number[]): Array<{
    id: number;
    name: string;
    kind: string;
    lang: string;
    file: string;
    line: number;
    signature: string;
    scope: string;
  }> {
    return writerSymbolQueries.getSymbolsByIds.call(this.writerSymbolQueriesHost(), ids);
  }

  getAllResolvedRefs(): Array<{
    fromId: number;
    toId: number;
    callType: string;
  }> {
    return writerSymbolQueries.getAllResolvedRefs.call(this.writerSymbolQueriesHost());
  }

  /**
   * Replace both rank tables in one write. Called once per index run, after
   * ref resolution has settled — a rank computed against half-resolved refs
   * would describe a graph that never existed.
   */
  replaceRanks(symbols: readonly SymbolRankRow[], files: readonly FileRankRow[]): void {
    this.runWriteTransaction(() => {
      writerRank.replaceSymbolRanksWithStatement(
        (sql) => this.stmt(sql),
        IndexStoreBase.MAX_SQL_VARS,
        symbols,
      );
      writerRank.replaceFileRanksWithStatement(
        (sql) => this.stmt(sql),
        IndexStoreBase.MAX_SQL_VARS,
        files,
      );
    });
  }

  // ── Semantic file vectors ────────────────────────────────────────────────

  /** Wipe stored vectors when the embedding model changed. */
  reconcileVectorProvider(provider: string): boolean {
    return this.runWithRetry(() =>
      writerVectors.reconcileVectorProviderWithStatement(
        (sql) => this.stmt(sql),
        (key) => this.getMetadata(key),
        (key, value) => this.setMetadata(key, value),
        provider,
      ),
    );
  }

  getFileVectorStates(provider: string): Map<string, string> {
    return writerVectors.getFileVectorStatesWithStatement((sql) => this.stmt(sql), provider);
  }

  upsertFileVectors(rows: readonly FileVectorRow[]): void {
    this.runWriteTransaction(() => {
      writerVectors.upsertFileVectorsWithStatement(
        (sql) => this.stmt(sql),
        IndexStoreBase.MAX_SQL_VARS,
        rows,
      );
    });
  }

  pruneOrphanFileVectors(): number {
    return this.runWithRetry(() =>
      writerVectors.pruneOrphanFileVectorsWithStatement((sql) => this.stmt(sql)),
    );
  }

  countFileVectors(): number {
    return writerVectors.countFileVectorsWithStatement((sql) => this.stmt(sql));
  }

  searchFileVectors(query: Float32Array, limit: number, minScore: number): VectorHit[] {
    return writerVectors.searchFileVectorsWithStatement(
      (sql) => this.stmt(sql),
      query,
      limit,
      minScore,
    );
  }

  // ── Concept layer ────────────────────────────────────────────────────────

  getFileStructuralFingerprint(file: string): string {
    return computeFileStructuralFingerprintWithStatement((sql) => this.stmt(sql), file);
  }

  upsertFileConcept(concept: FileConcept): void {
    this.runWriteTransaction(() => {
      writerConcepts.upsertFileConceptWithStatement((sql) => this.stmt(sql), concept);
    });
  }

  getFileConcept(file: string): FileConcept | undefined {
    return writerConcepts.getFileConceptWithStatement((sql) => this.stmt(sql), file);
  }

  getAllFileConcepts(): FileConcept[] {
    return writerConcepts.getAllFileConceptsWithStatement((sql) => this.stmt(sql));
  }

  getReadyConceptSummaries(): Map<string, string> {
    return writerConcepts.getReadyConceptSummariesWithStatement((sql) => this.stmt(sql));
  }

  getConceptCoverage(): ConceptCoverage {
    return writerConcepts.getConceptCoverageWithStatement((sql) => this.stmt(sql));
  }

  /** Flag summaries whose file has changed since they were written. */
  markStaleConcepts(): number {
    return this.runWithRetry(() =>
      writerConcepts.markStaleConceptsWithStatement((sql) => this.stmt(sql)),
    );
  }

  /** Drop summaries for files that are no longer indexed. */
  pruneOrphanConcepts(): number {
    return this.runWithRetry(() =>
      writerConcepts.pruneOrphanConceptsWithStatement((sql) => this.stmt(sql)),
    );
  }

  replaceSubsystems(subsystems: readonly Subsystem[], edges: readonly ConceptEdge[]): void {
    this.runWriteTransaction(() => {
      writerConcepts.replaceSubsystemsWithStatement(
        (sql) => this.stmt(sql),
        IndexStoreBase.MAX_SQL_VARS,
        subsystems,
        edges,
      );
    });
  }

  getSubsystems(): Subsystem[] {
    return writerConcepts.getSubsystemsWithStatement((sql) => this.stmt(sql));
  }

  getConceptEdges(): ConceptEdge[] {
    return writerConcepts.getConceptEdgesWithStatement((sql) => this.stmt(sql));
  }

  getPackageFileCounts(): Map<string, number> {
    return writerRank.getPackageFileCountsWithStatement((sql) => this.stmt(sql));
  }

  getRankedFiles(limit: number): RankedFileRow[] {
    return writerRank.getRankedFilesWithStatement((sql) => this.stmt(sql), limit);
  }

  getTopFileRanks(limit: number): FileRankRow[] {
    return writerRank.getTopFileRanksWithStatement((sql) => this.stmt(sql), limit);
  }

  getTopSymbolRanks(limit: number): SymbolRankRow[] {
    return writerRank.getTopSymbolRanksWithStatement((sql) => this.stmt(sql), limit);
  }

  getFileRankMap(): Map<string, number> {
    return writerRank.getFileRankMapWithStatement((sql) => this.stmt(sql));
  }

  getRankCounts(): { symbols: number; files: number } {
    return writerRank.getRankCountsWithStatement((sql) => this.stmt(sql));
  }

  getSymbolNameCandidates(): Map<number, number> {
    return writerRank.getSymbolNameCandidatesWithStatement((sql) => this.stmt(sql));
  }

  /** Declaring file and homonym count per symbol, from one scan. */
  getSymbolGraphFacts(): {
    fileOf: Map<number, string>;
    candidates: Map<number, number>;
    shadowedModules: Set<number>;
  } {
    return writerSymbolQueries.getSymbolGraphFacts.call(this.writerSymbolQueriesHost());
  }

  getImportVisibility(): Map<string, Set<string>> {
    return writerSymbolQueries.getImportVisibility.call(this.writerSymbolQueriesHost());
  }

  getAllImportRefs(): Array<{
    sourceFile: string | null;
    toName: string;
    toId: number | null;
    callType: string;
    line: number;
  }> {
    return writerSymbolQueries.getAllImportRefs.call(this.writerSymbolQueriesHost());
  }
}
