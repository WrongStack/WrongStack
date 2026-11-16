/**
 * Cross-System Ecosystem Bridge (`ecosystem-bridge.ts`).
 *
 * Bridges `codebase-index` tools (`codebase-impact-analysis`,
 * `codebase-diff-impact`, `codebase-read-symbol`) with project-local SAGE
 * anchored memories (`.wrongstack/memories/sage.db` or `memories.jsonl`) and
 * optional host-supplied WrongTrace / SAGE enrichment hooks.
 *
 * Strictly read-only and zero-side-effect: never creates a database or directory
 * when `.wrongstack/memories` does not exist.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import type { DatabaseSync as SQLiteDatabase } from 'node:sqlite';
import { loadDatabaseSync } from './sqlite-runtime.js';
import { posixIndexPath } from './writer-helpers.js';

export interface AnchoredSageInsight {
  id: string;
  kind: string;
  text: string;
  importance: number;
  anchorPath?: string | undefined;
  anchorSymbol?: string | undefined;
}

export interface EcosystemQuery {
  projectRoot: string;
  files?: readonly string[] | undefined;
  symbols?: readonly string[] | undefined;
  limit?: number | undefined;
}

export type EcosystemProviderHook = (query: EcosystemQuery) => AnchoredSageInsight[];

let customProviderHook: EcosystemProviderHook | null = null;

/** Register or clear an in-memory host provider for ecosystem insights. */
export function setEcosystemBridgeProvider(hook: EcosystemProviderHook | null): void {
  customProviderHook = hook;
}

interface RawMemoryAnchor {
  path?: string;
  symbol?: string;
}

interface RawMemoryRecord {
  id?: string;
  kind?: string;
  status?: string;
  text?: string;
  content?: string;
  importance?: number;
  anchors?: RawMemoryAnchor[];
  tags?: string[];
}

function matchMemoryRecord(
  rec: RawMemoryRecord,
  normFiles: ReadonlySet<string>,
  symbolSet: ReadonlySet<string>,
): AnchoredSageInsight | null {
  if (rec.status && rec.status !== 'active') return null;
  const text = (rec.text ?? rec.content ?? '').trim();
  if (!text) return null;

  const anchors = Array.isArray(rec.anchors) ? rec.anchors : [];
  for (const anchor of anchors) {
    const aPath = anchor.path ? posixIndexPath(anchor.path) : undefined;
    const aSym = anchor.symbol?.trim();
    if (aSym && symbolSet.has(aSym)) {
      return {
        id: rec.id ?? 'sage',
        kind: rec.kind ?? 'fact',
        text: text.slice(0, 280),
        importance: Number(rec.importance ?? 0.5),
        anchorPath: aPath,
        anchorSymbol: aSym,
      };
    }
    if (aPath && normFiles.has(aPath)) {
      return {
        id: rec.id ?? 'sage',
        kind: rec.kind ?? 'fact',
        text: text.slice(0, 280),
        importance: Number(rec.importance ?? 0.5),
        anchorPath: aPath,
        ...(aSym ? { anchorSymbol: aSym } : {}),
      };
    }
  }

  for (const sym of symbolSet) {
    if (sym.length >= 4 && text.includes(sym)) {
      return {
        id: rec.id ?? 'sage',
        kind: rec.kind ?? 'fact',
        text: text.slice(0, 280),
        importance: Number(rec.importance ?? 0.5),
        anchorSymbol: sym,
      };
    }
  }

  return null;
}

/**
 * Look up active SAGE memories anchored to the given project-relative files or
 * symbols without mutating or creating any database.
 */
export function findAnchoredSageMemories(query: EcosystemQuery): AnchoredSageInsight[] {
  const limit = Math.max(1, Math.min(query.limit ?? 5, 20));
  const results: AnchoredSageInsight[] = [];
  const seenIds = new Set<string>();

  if (customProviderHook) {
    try {
      for (const item of customProviderHook(query)) {
        if (!seenIds.has(item.id)) {
          seenIds.add(item.id);
          results.push(item);
          if (results.length >= limit) return results;
        }
      }
    } catch {
      // Best-effort enrichment
    }
  }

  const normFiles = new Set<string>();
  for (const f of query.files ?? []) {
    if (!f) continue;
    const rel = path.isAbsolute(f) ? path.relative(query.projectRoot, f) : f;
    normFiles.add(posixIndexPath(rel));
  }
  const symbolSet = new Set<string>(
    (query.symbols ?? []).map((s) => s.trim()).filter((s) => s.length > 0),
  );
  if (normFiles.size === 0 && symbolSet.size === 0) return results;

  const memoriesDir = path.join(query.projectRoot, '.wrongstack', 'memories');
  const sageDbPath = path.join(memoriesDir, 'sage.db');
  if (existsSync(sageDbPath)) {
    let db: SQLiteDatabase | null = null;
    try {
      const Database = loadDatabaseSync();
      db = new Database(sageDbPath, { readOnly: true });
      const rows = db
        .prepare(
          `SELECT id, data, kind, importance, status
           FROM memories
           WHERE status = 'active'
           ORDER BY importance DESC
           LIMIT 150`,
        )
        .all() as Array<{
        id: string;
        data: string;
        kind: string;
        importance: number;
        status: string;
      }>;

      for (const row of rows) {
        if (seenIds.has(row.id)) continue;
        try {
          const parsed = JSON.parse(row.data) as RawMemoryRecord;
          parsed.id ??= row.id;
          parsed.kind ??= row.kind;
          parsed.importance ??= row.importance;
          parsed.status ??= row.status;
          const matched = matchMemoryRecord(parsed, normFiles, symbolSet);
          if (matched) {
            seenIds.add(matched.id);
            results.push(matched);
            if (results.length >= limit) break;
          }
        } catch {
          // Ignore malformed JSON row
        }
      }
    } catch {
      // Best-effort read
    } finally {
      try {
        db?.close();
      } catch {
        // Ignore close error
      }
    }
  }

  if (results.length < limit) {
    const jsonlPath = path.join(memoriesDir, 'memories.jsonl');
    if (existsSync(jsonlPath)) {
      try {
        const raw = readFileSync(jsonlPath, 'utf8');
        for (const line of raw.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const parsed = JSON.parse(trimmed) as RawMemoryRecord;
            const id = parsed.id ?? `jsonl-${results.length}`;
            if (seenIds.has(id)) continue;
            const matched = matchMemoryRecord(parsed, normFiles, symbolSet);
            if (matched) {
              seenIds.add(matched.id);
              results.push(matched);
              if (results.length >= limit) break;
            }
          } catch {
            // Skip invalid JSONL line
          }
        }
      } catch {
        // Best-effort read
      }
    }
  }

  return results;
}

export interface SymbolSnapshotItem {
  name: string;
  kind: string;
  file: string;
  line?: number | undefined;
  signature?: string | undefined;
}

export interface SymbolMoveCandidate {
  moveKind: 'file-move' | 'symbol-rename';
  oldFile: string;
  oldSymbol: string;
  newFile: string;
  newSymbol: string;
  kind: string;
  confidence: number;
}

function normalizeAnonSignature(name: string, signature: string | undefined): string {
  if (!signature) return '';
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return signature
    .replace(new RegExp(`\\b${escaped}\\b`, 'g'), '_')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Deterministically detect symbols that were moved across files or renamed in
 * place between two index snapshots, enabling automatic SAGE memory anchor
 * healing (`path-remap`).
 */
export function detectMovedOrRenamedSymbols(
  prevSymbols: readonly SymbolSnapshotItem[],
  nextSymbols: readonly SymbolSnapshotItem[],
): SymbolMoveCandidate[] {
  const nextKeySet = new Set(
    nextSymbols.map((s) => `${posixIndexPath(s.file)}::${s.kind}::${s.name}`),
  );
  const prevKeySet = new Set(
    prevSymbols.map((s) => `${posixIndexPath(s.file)}::${s.kind}::${s.name}`),
  );

  const removed = prevSymbols.filter(
    (s) => !nextKeySet.has(`${posixIndexPath(s.file)}::${s.kind}::${s.name}`),
  );
  const added = nextSymbols.filter(
    (s) => !prevKeySet.has(`${posixIndexPath(s.file)}::${s.kind}::${s.name}`),
  );

  if (removed.length === 0 || added.length === 0) return [];

  const candidates: SymbolMoveCandidate[] = [];
  const usedAdded = new Set<number>();
  // A name alone does not prove a move: a deleted file's `parse` and an
  // unrelated new file's `parse` share it. Differing signatures are not a
  // move, and without signatures only a one-to-one pairing is trusted.
  const nameKindCount = (list: readonly SymbolSnapshotItem[]) => {
    const counts = new Map<string, number>();
    for (const s of list)
      counts.set(`${s.kind}::${s.name}`, (counts.get(`${s.kind}::${s.name}`) ?? 0) + 1);
    return counts;
  };
  const removedCounts = nameKindCount(removed);
  const addedCounts = nameKindCount(added);

  // Pass 1: Cross-file moves (same symbol name + kind moved from oldFile to newFile)
  for (const rem of removed) {
    const oldFile = posixIndexPath(rem.file);
    let bestIdx = -1;
    let bestConfidence = 0;

    for (let i = 0; i < added.length; i++) {
      if (usedAdded.has(i)) continue;
      const add = added[i]!;
      const newFile = posixIndexPath(add.file);
      if (add.name !== rem.name || add.kind !== rem.kind || newFile === oldFile) continue;

      const oldSig = normalizeAnonSignature(rem.name, rem.signature);
      const newSig = normalizeAnonSignature(add.name, add.signature);
      if (oldSig !== '' && newSig !== '' && oldSig !== newSig) continue;
      const key = `${rem.kind}::${rem.name}`;
      const unique = removedCounts.get(key) === 1 && addedCounts.get(key) === 1;
      if (oldSig === '' || newSig === '') {
        if (!unique) continue;
      }
      const confidence = oldSig !== '' && oldSig === newSig ? 0.98 : 0.85;
      if (confidence > bestConfidence) {
        bestConfidence = confidence;
        bestIdx = i;
      }
    }

    if (bestIdx !== -1) {
      usedAdded.add(bestIdx);
      const matched = added[bestIdx]!;
      candidates.push({
        moveKind: 'file-move',
        oldFile,
        oldSymbol: rem.name,
        newFile: posixIndexPath(matched.file),
        newSymbol: matched.name,
        kind: rem.kind,
        confidence: bestConfidence,
      });
    }
  }

  // Pass 2: Same-file symbol renames (same file + kind + non-empty anonymous signature)
  for (const rem of removed) {
    const oldFile = posixIndexPath(rem.file);
    if (candidates.some((c) => c.oldFile === oldFile && c.oldSymbol === rem.name)) continue;
    const oldAnon = normalizeAnonSignature(rem.name, rem.signature);
    if (!oldAnon || oldAnon.length < 6) continue;

    for (let i = 0; i < added.length; i++) {
      if (usedAdded.has(i)) continue;
      const add = added[i]!;
      const newFile = posixIndexPath(add.file);
      if (newFile !== oldFile || add.kind !== rem.kind) continue;

      const newAnon = normalizeAnonSignature(add.name, add.signature);
      if (newAnon === oldAnon) {
        usedAdded.add(i);
        candidates.push({
          moveKind: 'symbol-rename',
          oldFile,
          oldSymbol: rem.name,
          newFile,
          newSymbol: add.name,
          kind: rem.kind,
          confidence: 0.9,
        });
        break;
      }
    }
  }

  return candidates;
}

export interface RemapSageMemoriesResult {
  updatedSqliteCount: number;
  updatedJsonlCount: number;
  remappedMemoryIds: string[];
}

function applyMovesToRecord(
  record: RawMemoryRecord,
  moves: readonly SymbolMoveCandidate[],
): boolean {
  if (!Array.isArray(record.anchors) || record.anchors.length === 0) return false;
  let mutated = false;
  for (const anchor of record.anchors) {
    const aPath = anchor.path ? posixIndexPath(anchor.path) : undefined;
    const aSym = anchor.symbol?.trim();
    for (const move of moves) {
      if (aPath === move.oldFile && aSym === move.oldSymbol) {
        anchor.path = move.newFile;
        anchor.symbol = move.newSymbol;
        mutated = true;
        break;
      }
    }
  }
  return mutated;
}

/**
 * Heal anchored SAGE memories in `.wrongstack/memories/sage.db` and
 * `memories.jsonl` when `detectMovedOrRenamedSymbols` discovers moved or
 * renamed symbols. Never creates `.wrongstack` if it does not already exist.
 */
export function remapAnchoredSageMemories(
  projectRoot: string,
  moves: readonly SymbolMoveCandidate[],
): RemapSageMemoriesResult {
  const result: RemapSageMemoriesResult = {
    updatedSqliteCount: 0,
    updatedJsonlCount: 0,
    remappedMemoryIds: [],
  };
  if (moves.length === 0) return result;

  const memoriesDir = path.join(projectRoot, '.wrongstack', 'memories');
  if (!existsSync(memoriesDir)) return result;

  const seenIds = new Set<string>();
  const sqlitePath = path.join(memoriesDir, 'sage.db');
  if (existsSync(sqlitePath)) {
    let db: SQLiteDatabase | null = null;
    try {
      const Database = loadDatabaseSync();
      db = new Database(sqlitePath);
      const rows = db
        .prepare("SELECT id, data FROM memories WHERE status = 'active'")
        .all() as Array<{ id: string; data: string }>;
      const updateStmt = db.prepare('UPDATE memories SET data = ? WHERE id = ?');
      for (const row of rows) {
        try {
          const parsed = JSON.parse(row.data) as RawMemoryRecord;
          if (applyMovesToRecord(parsed, moves)) {
            updateStmt.run(JSON.stringify(parsed), row.id);
            result.updatedSqliteCount += 1;
            if (!seenIds.has(row.id)) {
              seenIds.add(row.id);
              result.remappedMemoryIds.push(row.id);
            }
          }
        } catch {
          // Ignore malformed row
        }
      }
    } catch {
      // Best-effort SQLite update
    } finally {
      try {
        db?.close();
      } catch {
        // Ignore close error
      }
    }
  }

  const jsonlPath = path.join(memoriesDir, 'memories.jsonl');
  if (existsSync(jsonlPath)) {
    try {
      const raw = readFileSync(jsonlPath, 'utf8');
      const lines = raw.split('\n');
      let fileMutated = false;
      const nextLines = lines.map((line) => {
        const trimmed = line.trim();
        if (!trimmed) return line;
        try {
          const parsed = JSON.parse(trimmed) as RawMemoryRecord;
          if (applyMovesToRecord(parsed, moves)) {
            fileMutated = true;
            result.updatedJsonlCount += 1;
            const id = parsed.id ?? `jsonl-${result.updatedJsonlCount}`;
            if (!seenIds.has(id)) {
              seenIds.add(id);
              result.remappedMemoryIds.push(id);
            }
            return JSON.stringify(parsed);
          }
        } catch {
          // Keep original line on parse error
        }
        return line;
      });
      if (fileMutated) {
        writeFileSync(jsonlPath, nextLines.join('\n'), 'utf8');
      }
    } catch {
      // Best-effort JSONL update
    }
  }

  return result;
}

// ─── WrongTrace File Health / Fragility Bridge ──────────────────────────────

export interface AnchoredFileHealth {
  file: string;
  /** 0..100 health score (lower = more fragile). */
  healthScore: number;
  isFragile: boolean;
  recentThrashingCount: number;
  isLocked?: boolean | undefined;
  lockOwner?: string | undefined;
  warning?: string | undefined;
}

export type WrongTraceHealthProviderHook = (
  projectRoot: string,
  files: readonly string[],
) => AnchoredFileHealth[];

let customHealthHook: WrongTraceHealthProviderHook | null = null;

/** Register or clear an in-memory host provider for WrongTrace file health telemetry. */
export function setWrongTraceHealthProvider(hook: WrongTraceHealthProviderHook | null): void {
  customHealthHook = hook;
}

/**
 * Look up WrongTrace file fragility, thrashing, and lock alerts for the given
 * project-relative or absolute files. Zero-overhead when no health provider or
 * `.wrongstack/wrongtrace-health.json` exists.
 */
export function findFileHealthAlerts(
  projectRoot: string,
  files: readonly string[],
): AnchoredFileHealth[] {
  if (!projectRoot || files.length === 0) return [];
  const normFiles = new Set<string>();
  for (const f of files) {
    if (!f) continue;
    const rel = path.isAbsolute(f) ? path.relative(projectRoot, f) : f;
    normFiles.add(posixIndexPath(rel));
  }
  if (normFiles.size === 0) return [];

  const results: AnchoredFileHealth[] = [];
  const seenFiles = new Set<string>();

  if (customHealthHook) {
    try {
      for (const item of customHealthHook(projectRoot, [...normFiles])) {
        const key = posixIndexPath(item.file);
        if (normFiles.has(key) && !seenFiles.has(key)) {
          seenFiles.add(key);
          results.push({ ...item, file: key });
        }
      }
    } catch {
      // Best-effort health hook
    }
  }

  const healthJsonPath = path.join(projectRoot, '.wrongstack', 'wrongtrace-health.json');
  if (existsSync(healthJsonPath)) {
    try {
      const raw = JSON.parse(readFileSync(healthJsonPath, 'utf8').replace(/^\uFEFF/, '')) as
        | { files?: Array<Record<string, unknown>> }
        | Array<Record<string, unknown>>
        | null;
      const list = Array.isArray(raw) ? raw : Array.isArray(raw?.files) ? raw.files : [];
      for (const entry of list) {
        if (!entry || typeof entry !== 'object') continue;
        const rawPath = String(entry['file_path'] ?? entry['file'] ?? entry['path'] ?? '');
        if (!rawPath) continue;
        const rel = path.isAbsolute(rawPath) ? path.relative(projectRoot, rawPath) : rawPath;
        const key = posixIndexPath(rel);
        if (!normFiles.has(key) || seenFiles.has(key)) continue;
        const healthScore = Number(entry['health_score'] ?? entry['healthScore'] ?? 100);
        const isFragile = Boolean(entry['is_fragile'] ?? entry['isFragile'] ?? healthScore < 50);
        const recentThrashingCount = Number(
          entry['recent_thrashing_count'] ?? entry['recentThrashingCount'] ?? 0,
        );
        const isLocked = Boolean(entry['is_locked'] ?? entry['isLocked'] ?? false);
        const lockOwner =
          typeof entry['lock_owner'] === 'string'
            ? entry['lock_owner']
            : typeof entry['lockOwner'] === 'string'
              ? entry['lockOwner']
              : undefined;
        const warning = typeof entry['warning'] === 'string' ? entry['warning'] : undefined;
        if (isFragile || recentThrashingCount > 0 || isLocked) {
          seenFiles.add(key);
          results.push({
            file: key,
            healthScore,
            isFragile,
            recentThrashingCount,
            ...(isLocked ? { isLocked } : {}),
            ...(lockOwner ? { lockOwner } : {}),
            ...(warning ? { warning } : {}),
          });
        }
      }
    } catch {
      // Ignore malformed health JSON
    }
  }

  return results;
}
