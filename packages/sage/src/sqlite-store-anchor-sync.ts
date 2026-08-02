import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { ancestorPaths, normalizeSlashes } from './paths.js';
import { sqliteAnchorNode, sqliteAnchorRelation } from './sqlite-store-anchors.js';
import { memoryNodeId } from './sqlite-store-graph-helpers.js';
import type { Sage } from './types.js';

type SqliteStatement = ReturnType<DatabaseSync['prepare']>;

export function syncSqliteAnchorEdges(
  deps: {
    stmt(sql: string): SqliteStatement;
    nowIso(): string;
  },
  memory: Sage,
): void {
  const from = memoryNodeId(memory.id);
  const deleted = deps
    .stmt(
      "DELETE FROM edges WHERE from_node = ? AND relation GLOB 'about_*' RETURNING to_node, relation, created_at",
    )
    .all(from) as Array<{ to_node: string; relation: string; created_at: string }>;
  const createdAtByEdge = new Map(
    deleted.map((edge) => [`${edge.to_node}\0${edge.relation}`, edge.created_at]),
  );
  if (memory.status !== 'active' && memory.status !== 'stale') return;
  const insert = deps.stmt(
    `INSERT INTO edges (from_node, to_node, relation, weight, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(from_node, to_node, relation) DO UPDATE SET
       weight = MAX(weight, excluded.weight)`,
  );
  for (const anchor of memory.anchors) {
    const target = sqliteAnchorNode(anchor);
    const relation = sqliteAnchorRelation(anchor);
    if (target && relation) {
      const createdAt = createdAtByEdge.get(`${target}\0${relation}`) ?? deps.nowIso();
      insert.run(from, target, relation, memory.confidence, createdAt);
    }

    if (!anchor.path) continue;
    const anchoredPath = normalizeSlashes(anchor.path);
    const isDirectory = anchor.type === 'directory' || anchor.type === 'package';
    const fileNode = `file:${anchoredPath}`;
    const directoryPath = isDirectory
      ? anchoredPath
      : normalizeSlashes(path.posix.dirname(anchoredPath));
    const now = deps.nowIso();
    if (anchor.type === 'symbol' && anchor.symbol) {
      insert.run(
        `symbol:${anchoredPath}#${anchor.symbol}`,
        fileNode,
        'related_to',
        memory.confidence,
        now,
      );
    }
    if (!isDirectory) {
      insert.run(fileNode, `dir:${directoryPath}`, 'related_to', memory.confidence, now);
    }
    const directories = ancestorPaths(directoryPath);
    for (let i = 0; i < directories.length - 1; i++) {
      insert.run(
        `dir:${directories[i]}`,
        `dir:${directories[i + 1]}`,
        'related_to',
        memory.confidence,
        now,
      );
    }
  }
}
