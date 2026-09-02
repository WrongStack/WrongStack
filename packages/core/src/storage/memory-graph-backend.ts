import * as fs from 'node:fs/promises';
import type { MemoryEntry, MemoryScope } from '../types/memory.js';
import { type FileMemoryBackendOptions, FileMemoryBackend } from './memory-backend.js';
import type { MemoryBackend } from './memory-backend.js';

// ── Graph node and edge types ──────────────────────────────────────────

interface GraphNode {
  id: string;
  entry: MemoryEntry;
  firstSeen: string;
  count: number;
  /** Extracted metadata for fast lookup. */
  type?: MemoryEntry['type'] | undefined;
  tags?: string[] | undefined;
  priority?: MemoryEntry['priority'] | undefined;
}

interface GraphEdge {
  from: string;
  to: string;
  /** Why these nodes are related. */
  relation: 'co_occurring' | 'similar' | 'same_turn' | 'explicit';
  weight: number;
  ts: string;
}

// ── Backend ────────────────────────────────────────────────────────────

export interface GraphMemoryBackendOptions extends FileMemoryBackendOptions {
  /**
   * Path to the graph metadata file (edges + node metadata).
   * Defaults to `<projectDir>/memory-graph.json`.
   */
  graphPath?: string | undefined;
}

/**
 * @deprecated Migrate to `SageStore` from the SAGE package,
 * which provides the same `MemoryBackend` operations (remember, forget, search,
 * consolidate, list, clear) plus graph support via its integrated
 * `SageGraph` implementation.
 * This legacy backend stores entries as markdown bullets in a flat file with a
 * separate graph.json; SageStore stores structured records in JSONL (or
 * SQLite) with a dedicated edges.jsonl supporting 12 relation types (supersedes,
 * contradicts, about_file, etc.) and mutation-locked append.
 * Migration is NOT drop-in — migrate to SageStore and use its
 * integrated graph features instead.
 *
 * Graph-based memory backend that tracks relationships between entries.
 * Builds on top of FileMemoryBackend — entries are still persisted as
 * markdown bullets, but the graph layer adds:
 *
 *   - Co-occurrence edges (entries from the same remember() batch)
 *   - Content similarity edges (simple Jaccard on word overlap)
 *   - Turn-based edges (entries created in the same LLM turn)
 *   - Graph traversal queries (find related memories)
 *
 * The graph metadata persists to `<projectDir>/memory-graph.json`.
 */
export class GraphMemoryBackend implements MemoryBackend {
  readonly kind = 'graph';

  private readonly file: FileMemoryBackend;
  private readonly graphFile: string;

  // In-memory graph state — lazily loaded, saved on mutation.
  private nodes = new Map<string, GraphNode>();
  private edges: GraphEdge[] = [];
  private loadedScope: MemoryScope | null = null;
  private loaded = false;

  /**
   * Inverted index for O(1) term → node lookup during search.
   * Built incrementally on remember/forget, rebuilt on loadGraph if absent.
   * Maps lowercase term (min 3 chars) → Set of node IDs containing that term.
   */
  private invertedIndex = new Map<string, Set<string>>();

  /** Minimum term length to index — avoids noise from 1-2 char fragments. */
  private static readonly MIN_TERM_LEN = 3;

  /**
   * Promise that resolves when the current in-flight _saveGraph completes.
   * Tests call flush() to await this before deleting the backend or its temp dir.
   * Each save operation chains onto the previous one so concurrent saves are serialised.
   */
  private _saveDone: Promise<void> = Promise.resolve();

  constructor(opts: GraphMemoryBackendOptions) {
    this.file = new FileMemoryBackend({ paths: opts.paths });
    this.graphFile = opts.graphPath ?? `${opts.paths.projectDir}/memory-graph.json`;
  }

  // ── Backend interface ──────────────────────────────────────────────

  async remember(scope: MemoryScope, entry: MemoryEntry, filePath: string): Promise<void> {
    await this.file.remember(scope, entry, filePath);
    await this.loadGraph(scope);

    const nodeId = this.nodeId(entry);
    const existing = this.nodes.get(nodeId);
    if (existing) {
      existing.count++;
      existing.entry = entry;
      existing.type = entry.type;
      existing.tags = entry.tags;
      existing.priority = entry.priority;
      // Update inverted index for the modified node's text and tags
      this.updateNodeIndex(nodeId, entry);
    } else {
      this.nodes.set(nodeId, {
        id: nodeId,
        entry,
        firstSeen: entry.ts,
        count: 1,
        type: entry.type,
        tags: entry.tags,
        priority: entry.priority,
      });

      // Index the new node in the inverted index
      this.indexNode(nodeId, entry);

      // Create similarity edges — but only against the last SIMILARITY_WINDOW most
      // recent nodes instead of the full in-memory set. This converts O(N²) on
      // every remember() into O(K) where K is a small constant (100), making
      // remember() O(1) amortized regardless of how many entries are stored.
      const SIMILARITY_WINDOW = 100;
      const recentNodes = [...this.nodes.values()].slice(-SIMILARITY_WINDOW);
      for (const other of recentNodes) {
        if (other.id === nodeId) continue;
        const sim = wordOverlap(entry.text, other.entry.text);
        const tagSim = sharedTags(entry.tags ?? [], other.tags ?? []);
        const weight = Math.max(sim, tagSim * 0.5);
        if (weight > 0.15) {
          this.edges.push({
            from: nodeId,
            to: other.id,
            relation: sim >= tagSim ? 'similar' : 'same_turn',
            weight,
            ts: entry.ts,
          });
        }
      }
    }

    // Await the graph save to ensure flush() sees the file on disk before
    // cleanup. Unlike memory-consolidator (LLM call, 15s), this is a fast fs operation
    // and the caller's event loop is already freed by not awaiting file.remember().
    this._saveDone = this._saveGraph(scope);
    await this._saveDone;
  }

  async forget(scope: MemoryScope, query: string, filePath: string): Promise<number> {
    const removed = await this.file.forget(scope, query, filePath);
    if (removed > 0) {
      await this.loadGraph(scope);
      // Remove nodes whose entry text matches the query
      const n = query.toLowerCase();
      const toRemove: string[] = [];
      for (const [id, node] of this.nodes) {
        if (node.entry.text.toLowerCase().includes(n)) {
          toRemove.push(id);
        }
      }
      for (const id of toRemove) {
        // Remove from inverted index before deleting the node
        this.removeNodeFromIndex(id, this.nodes.get(id)?.entry);
        this.nodes.delete(id);
      }
      this.edges = this.edges.filter((e) => !toRemove.includes(e.from) && !toRemove.includes(e.to));
      this._saveDone = this._saveGraph(scope);
      await this._saveDone;
    }
    return removed;
  }

  async readAll(scope: MemoryScope, filePath: string): Promise<string> {
    return this.file.readAll(scope, filePath);
  }

  async list(scope: MemoryScope, filePath: string, limit?: number): Promise<MemoryEntry[]> {
    await this.loadGraph(scope);
    // Merge: file entries are canonical, graph adds metadata and dedup
    const fileEntries = await this.file.list(scope, filePath);
    const nodeMap = new Map(this.nodes.entries());

    // Enrich file entries with graph metadata
    const enriched = fileEntries.map((fe) => {
      const nodeId = this.nodeId(fe);
      const node = nodeMap.get(nodeId);
      if (node) {
        return {
          ...fe,
          type: node.type ?? fe.type,
          tags: node.tags ?? fe.tags,
          priority: node.priority ?? fe.priority,
        };
      }
      return fe;
    });

    // Add graph-only nodes not in file (shouldn't happen normally, but safety)
    const fileIds = new Set(fileEntries.map((e) => this.nodeId(e)));
    for (const [id, node] of this.nodes) {
      if (!fileIds.has(id)) {
        enriched.push(node.entry);
      }
    }

    enriched.sort((a, b) => b.ts.localeCompare(a.ts));
    return limit ? enriched.slice(0, limit) : enriched;
  }

  async search(
    scope: MemoryScope,
    query: string,
    _filePath: string,
    limit?: number,
  ): Promise<MemoryEntry[]> {
    await this.loadGraph(scope);
    const needle = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length >= GraphMemoryBackend.MIN_TERM_LEN);

    // Use inverted index to find candidate nodes — O(K * avg_results) instead of O(N)
    const candidates = new Map<string, number>();
    for (const term of needle) {
      const nodeIds = this.invertedIndex.get(term);
      if (!nodeIds) continue;
      for (const nodeId of nodeIds) {
        const node = this.nodes.get(nodeId);
        if (!node || node.entry.scope !== scope) continue;
        // Count how many terms matched this node
        candidates.set(nodeId, (candidates.get(nodeId) ?? 0) + 1);
      }
    }

    // Also include high-priority entries even without lexical matches (priority boost > 0)
    // This preserves the original behavior where priority/count could surface entries
    // that don't match any query terms.
    for (const [nodeId, node] of this.nodes) {
      if (node.entry.scope !== scope) continue;
      if (candidates.has(nodeId)) continue; // Already in candidates
      // Include if priority boost > 0 (critical=3, high=2)
      if (node.priority === 'critical' || node.priority === 'high') {
        candidates.set(nodeId, 0); // 0 lexical matches but priority boost applies
      }
    }

    // Score candidates: text match (1pt/term), tag match (2pts/term), priority, count
    const scored: { entry: MemoryEntry; score: number }[] = [];
    for (const [nodeId] of candidates) {
      const node = this.nodes.get(nodeId)!;
      let score = 0;
      // Text match score: 1pt per matching term
      score += (candidates.get(nodeId) ?? 0) * 1;
      // Tag match score: 2pts per term that appears in any tag
      for (const term of needle) {
        if (node.entry.tags?.some((t) => t.toLowerCase().includes(term))) score += 2;
      }
      if (node.priority === 'critical') score += 3;
      else if (node.priority === 'high') score += 2;
      score += node.count * 0.5;
      scored.push({ entry: node.entry, score });
    }

    scored.sort((a, b) => b.score - a.score);
    const matched = scored.map((s) => s.entry);
    return limit ? matched.slice(0, limit) : matched;
  }

  async clear(scope: MemoryScope, filePath: string): Promise<void> {
    await this.file.clear(scope, filePath);
    this.nodes.clear();
    this.edges = [];
    this.invertedIndex = new Map();
    this.loadedScope = scope;
    this.loaded = true;
    // Write empty graph
    try {
      await fs.unlink(this.graphFile);
    } catch {
      /* ok */
    }
  }

  async consolidate(scope: MemoryScope, filePath: string): Promise<number> {
    return this.file.consolidate(scope, filePath);
  }

  // ── Graph-specific queries ─────────────────────────────────────────

  /**
   * Find memories related to the given entry, ordered by edge weight.
   */
  async findRelated(
    scope: MemoryScope,
    _filePath: string,
    entryText: string,
    limit = 5,
  ): Promise<MemoryEntry[]> {
    await this.loadGraph(scope);
    const targetId = this.nodeId({ scope, text: entryText, ts: '' });
    const related = this.edges
      .filter((e) => e.from === targetId || e.to === targetId)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, limit);

    const result: MemoryEntry[] = [];
    for (const edge of related) {
      const otherId = edge.from === targetId ? edge.to : edge.from;
      const node = this.nodes.get(otherId);
      if (node) result.push(node.entry);
    }
    return result;
  }

  /**
   * Get all edges for visualization or traversal.
   */
  getGraph(): { nodes: GraphNode[]; edges: GraphEdge[] } {
    return {
      nodes: [...this.nodes.values()],
      edges: [...this.edges],
    };
  }

  // ── Persistence ────────────────────────────────────────────────────

  private nodeId(entry: MemoryEntry): string {
    // Stable ID from scope + normalized text
    const norm = entry.text.toLowerCase().trim().replace(/\s+/g, ' ');
    return `${entry.scope ?? 'mem'}::${simpleHash(norm)}`;
  }

  private async loadGraph(scope: MemoryScope): Promise<void> {
    if (this.loaded && this.loadedScope === scope) return;
    try {
      const raw = await fs.readFile(this.graphFile, 'utf8');
      const data: { nodes: Array<[string, GraphNode]>; edges: GraphEdge[] } = JSON.parse(raw);
      this.nodes = new Map(data.nodes);
      this.edges = data.edges;
    } catch {
      this.nodes = new Map();
      this.edges = [];
    }
    // Build inverted index from loaded nodes
    this.buildInvertedIndex();
    this.loadedScope = scope;
    this.loaded = true;
  }

  /** Fire-and-forget graph persistence. Named _saveGraph to signal it must not be awaited. */
  private async _saveGraph(scope: MemoryScope): Promise<void> {
    this.loadedScope = scope;
    this.loaded = true;
    try {
      const data = {
        nodes: [...this.nodes.entries()],
        edges: this.edges,
      };
      const dir = this.graphFile.substring(0, this.graphFile.lastIndexOf('/'));
      await fs.mkdir(dir, { recursive: true });
      // Atomic write via temp file
      const tmp = `${this.graphFile}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(data));
      await fs.rename(tmp, this.graphFile);
    } catch {
      // best-effort — graph is an enhancement, not critical
    }
  }

  /**
   * Wait for all in-flight _saveGraph operations to complete.
   * Call this before deleting the backend or its temp directory.
   */
  async flush(): Promise<void> {
    await this._saveDone;
  }

  // ── Inverted Index Helpers ───────────────────────────────────────────

  /**
   * Build the inverted index from all currently loaded nodes.
   * Called on loadGraph() to reconstruct the index after loading from disk.
   */
  private buildInvertedIndex(): void {
    this.invertedIndex = new Map();
    for (const [nodeId, node] of this.nodes) {
      for (const term of this.extractTerms(node.entry)) {
        let nodeIds = this.invertedIndex.get(term);
        if (!nodeIds) {
          nodeIds = new Set();
          this.invertedIndex.set(term, nodeIds);
        }
        nodeIds.add(nodeId);
      }
    }
  }

  /**
   * Index a node in the inverted index. Adds the node's ID to all term entries.
   */
  private indexNode(nodeId: string, entry: MemoryEntry): void {
    for (const term of this.extractTerms(entry)) {
      let nodeIds = this.invertedIndex.get(term);
      if (!nodeIds) {
        nodeIds = new Set();
        this.invertedIndex.set(term, nodeIds);
      }
      nodeIds.add(nodeId);
    }
  }

  /**
   * Remove a node's terms from the inverted index before deleting it.
   * Used in forget() and when updating existing nodes.
   */
  private removeNodeFromIndex(nodeId: string, entry?: MemoryEntry): void {
    if (!entry) return;
    for (const term of this.extractTerms(entry)) {
      const nodeIds = this.invertedIndex.get(term);
      if (nodeIds) {
        nodeIds.delete(nodeId);
        if (nodeIds.size === 0) {
          this.invertedIndex.delete(term);
        }
      }
    }
  }

  /**
   * Update an existing node's entries in the inverted index.
   * Removes old terms and adds new ones.
   */
  private updateNodeIndex(nodeId: string, entry: MemoryEntry): void {
    // Remove old entries for this node
    const existing = this.nodes.get(nodeId);
    if (existing) {
      this.removeNodeFromIndex(nodeId, existing.entry);
    }
    // Add new entries
    this.indexNode(nodeId, entry);
  }

  /**
   * Extract searchable terms from a memory entry.
   * Returns lowercase words from text (min length) and full tag strings.
   */
  private extractTerms(entry: MemoryEntry): string[] {
    const terms: string[] = [];
    // Extract words from text (only terms >= MIN_TERM_LEN to avoid noise)
    const words = entry.text.toLowerCase().split(/\s+/);
    for (const word of words) {
      if (word.length >= GraphMemoryBackend.MIN_TERM_LEN) {
        terms.push(word);
      }
    }
    // Index full tags as complete strings (not individual words)
    if (entry.tags) {
      for (const tag of entry.tags) {
        const lower = tag.toLowerCase();
        if (lower.length >= GraphMemoryBackend.MIN_TERM_LEN && !terms.includes(lower)) {
          terms.push(lower);
        }
      }
    }
    return terms;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

/** Jaccard-style word overlap between two strings. 0.0 = no overlap, 1.0 = identical. */
function wordOverlap(a: string, b: string): number {
  const wordsA = new Set(
    a
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
  const wordsB = new Set(
    b
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }
  return intersection / Math.max(wordsA.size, wordsB.size);
}

/** Tag overlap ratio — how many tags two nodes share. */
function sharedTags(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  let shared = 0;
  for (const t of a) if (setB.has(t)) shared++;
  return shared / Math.max(a.length, b.length);
}

/** Fast non-crypto hash for stable node IDs. */
function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}
