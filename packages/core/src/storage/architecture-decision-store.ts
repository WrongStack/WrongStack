import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { loadDatabaseSync } from '../utils/sqlite-database.js';
import { resolveWstackPaths } from '../utils/wstack-paths.js';
import {
  type ArchitectureDecision,
  type ArchitectureDecisionContent,
  type ArchitectureDecisionReview,
  decisionContentHash,
  validateDecisionContent,
} from './architecture-decision.js';

/** Independent of SAGE retention, ranking and the optional governance runtime. */
export class ArchitectureDecisionStore {
  readonly file: string;
  readonly projectId: string;

  constructor(readonly projectRoot: string) {
    this.projectId = resolveWstackPaths({ projectRoot }).projectHash;
    this.file = path.join(
      resolveWstackPaths({ projectRoot }).projectDir,
      'decisions',
      'decisions.sqlite',
    );
  }

  private open(create: boolean): DatabaseSync | undefined {
    if (!create && !existsSync(this.file)) return undefined;
    if (create) mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const db = new (loadDatabaseSync())(this.file, { readOnly: !create });
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      const schemaVersion = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
      if (schemaVersion > 1)
        throw new Error('ADR database uses a newer schema. Update WrongStack before opening it.');
      if (create) db.exec('PRAGMA journal_mode = WAL');
      if (schemaVersion === 0) {
        if (!create)
          throw new Error('ADR database is uninitialized. Create a proposal to initialize it.');
        db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS architecture_decisions (
        id TEXT PRIMARY KEY, record_json TEXT NOT NULL
      ); CREATE TABLE IF NOT EXISTS architecture_decision_history (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL, revision INTEGER NOT NULL, record_json TEXT NOT NULL,
        UNIQUE(id, revision)
      ); PRAGMA user_version = 1; COMMIT;`);
      }
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  private read(db: DatabaseSync, id: string): ArchitectureDecision | undefined {
    const row = db.prepare('SELECT record_json FROM architecture_decisions WHERE id = ?').get(id);
    return row ? this.decode(row.record_json) : undefined;
  }

  private decode(json: unknown): ArchitectureDecision {
    const record = JSON.parse(String(json)) as ArchitectureDecision;
    if (record.projectId !== this.projectId)
      throw new Error('ADR record belongs to a different project. Import it as a new proposal.');
    if (decisionContentHash(record) !== record.contentHash)
      throw new Error(
        'ADR content integrity check failed. Restore the registry from a trusted backup.',
      );
    return record;
  }

  private write(db: DatabaseSync, record: ArchitectureDecision): void {
    const json = JSON.stringify(record);
    db.prepare(
      'INSERT INTO architecture_decision_history(id, revision, record_json) VALUES (?, ?, ?)',
    ).run(record.id, record.revision, json);
    db.prepare(
      'INSERT INTO architecture_decisions(id, record_json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET record_json = excluded.record_json',
    ).run(record.id, json);
  }

  private transaction<T>(fn: (db: DatabaseSync) => T): T {
    const db = this.open(true)!;
    try {
      db.exec('BEGIN IMMEDIATE');
      const result = fn(db);
      db.exec('COMMIT');
      return result;
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    } finally {
      db.close();
    }
  }

  list(): ArchitectureDecision[] {
    const db = this.open(false);
    if (!db) return [];
    try {
      return db
        .prepare('SELECT record_json FROM architecture_decisions ORDER BY id')
        .all()
        .map((row) => this.decode(row.record_json));
    } finally {
      db.close();
    }
  }

  get(id: string): ArchitectureDecision | undefined {
    const db = this.open(false);
    if (!db) return undefined;
    try {
      return this.read(db, id);
    } finally {
      db.close();
    }
  }

  history(id: string): ArchitectureDecision[] {
    const db = this.open(false);
    if (!db) return [];
    try {
      return db
        .prepare(
          'SELECT record_json FROM architecture_decision_history WHERE id = ? ORDER BY revision',
        )
        .all(id)
        .map((row) => this.decode(row.record_json));
    } finally {
      db.close();
    }
  }

  getRevision(id: string, revision: number): ArchitectureDecision | undefined {
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('Invalid ADR revision.');
    const db = this.open(false);
    if (!db) return undefined;
    try {
      const row = db
        .prepare(
          'SELECT record_json FROM architecture_decision_history WHERE id = ? AND revision = ?',
        )
        .get(id, revision);
      return row ? this.decode(row.record_json) : undefined;
    } finally {
      db.close();
    }
  }

  /** Immutable revision cursor: new writes do not shift previously loaded pages. */
  historyPage(
    id: string,
    beforeRevision?: number,
  ): { records: ArchitectureDecision[]; nextBeforeRevision: number | null } {
    if (
      beforeRevision !== undefined &&
      (!Number.isSafeInteger(beforeRevision) || beforeRevision < 1)
    )
      throw new Error('Invalid ADR history cursor.');
    const db = this.open(false);
    if (!db) return { records: [], nextBeforeRevision: null };
    try {
      const rows =
        beforeRevision === undefined
          ? db
              .prepare(
                'SELECT record_json FROM architecture_decision_history WHERE id = ? ORDER BY revision DESC LIMIT 51',
              )
              .all(id)
          : db
              .prepare(
                'SELECT record_json FROM architecture_decision_history WHERE id = ? AND revision < ? ORDER BY revision DESC LIMIT 51',
              )
              .all(id, beforeRevision);
      const records = rows.slice(0, 50).map((row) => this.decode(row.record_json));
      return { records, nextBeforeRevision: rows.length > 50 ? records.at(-1)!.revision : null };
    } finally {
      db.close();
    }
  }

  propose(input: ArchitectureDecisionContent, actor: string): ArchitectureDecision {
    const content = validateDecisionContent(input);
    if (!actor.trim() || actor.length > 200) throw new Error('ADR proposer identity is required.');
    return this.transaction((db) => {
      // Identical proposals from concurrent agents converge instead of creating review spam.
      const hash = decisionContentHash(content);
      const duplicate = db
        .prepare('SELECT record_json FROM architecture_decisions')
        .all()
        .map((row) => this.decode(row.record_json))
        .find(
          (record) =>
            record.contentHash === hash &&
            record.status !== 'deprecated' &&
            record.status !== 'superseded',
        );
      if (duplicate) return duplicate;
      const predecessor = content.supersedes ? this.read(db, content.supersedes) : undefined;
      if (content.supersedes && predecessor?.status !== 'accepted')
        throw new Error('Only an accepted ADR can be superseded.');
      const now = new Date().toISOString();
      const record: ArchitectureDecision = {
        ...content,
        projectId: this.projectId,
        id: `ADR-${randomUUID()}`,
        revision: 1,
        contentHash: hash,
        status: 'proposed',
        createdAt: now,
        updatedAt: now,
        proposedBy: actor,
        ...(predecessor ? { predecessorRevision: predecessor.revision } : {}),
      };
      this.write(db, record);
      return record;
    });
  }

  revise(
    id: string,
    revision: number,
    contentHash: string,
    input: ArchitectureDecisionContent,
    actor: string,
  ): ArchitectureDecision {
    const content = validateDecisionContent(input);
    if (!actor.trim() || actor.length > 200) throw new Error('ADR proposer identity is required.');
    return this.transaction((db) => {
      const current = this.read(db, id);
      if (current?.status !== 'proposed')
        throw new Error('Only proposed ADR content may be revised.');
      if (current.revision !== revision || current.contentHash !== contentHash)
        throw new Error('ADR changed since review. Reload before revising.');
      const predecessor = content.supersedes ? this.read(db, content.supersedes) : undefined;
      if (content.supersedes && predecessor?.status !== 'accepted')
        throw new Error('Only an accepted ADR can be superseded.');
      const record: ArchitectureDecision = {
        ...content,
        projectId: this.projectId,
        id,
        revision: revision + 1,
        contentHash: decisionContentHash(content),
        status: 'proposed',
        createdAt: current.createdAt,
        updatedAt: new Date().toISOString(),
        proposedBy: actor,
        ...(predecessor ? { predecessorRevision: predecessor.revision } : {}),
      };
      this.write(db, record);
      return record;
    });
  }

  /** Host user-command / authenticated UI boundary only; never register as a model tool. */
  review(input: ArchitectureDecisionReview, user: string): ArchitectureDecision {
    if (input?.projectId !== this.projectId)
      throw new Error('ADR review belongs to a different project. Reload the current project.');
    if (!user.trim() || user.length > 200) throw new Error('ADR reviewer identity is required.');
    if (!input.reason?.trim() || input.reason.length > 4000)
      throw new Error('ADR review requires a reason up to 4000 characters.');
    if (!['accept', 'reject', 'deprecate'].includes(input.action))
      throw new Error('Unknown ADR review action.');
    return this.transaction((db) => {
      const current = this.read(db, input.id);
      if (!current) throw new Error('ADR not found.');
      if (current.revision !== input.revision || current.contentHash !== input.contentHash)
        throw new Error('ADR changed since review. Reload and review the current revision.');
      if (
        (input.action === 'deprecate' && current.status !== 'accepted') ||
        (input.action !== 'deprecate' && current.status !== 'proposed')
      )
        throw new Error('ADR is no longer in a reviewable state.');
      const now = new Date().toISOString();
      if (input.action === 'accept' && current.supersedes) {
        const predecessor = this.read(db, current.supersedes);
        if (
          predecessor?.status !== 'accepted' ||
          predecessor.revision !== current.predecessorRevision
        )
          throw new Error(
            'Predecessor ADR changed. Create a new proposal against the active decision.',
          );
        this.write(db, {
          ...predecessor,
          revision: predecessor.revision + 1,
          status: 'superseded',
          supersededBy: current.id,
          updatedAt: now,
        });
      }
      const record: ArchitectureDecision = {
        ...current,
        revision: current.revision + 1,
        status:
          input.action === 'accept'
            ? 'accepted'
            : input.action === 'reject'
              ? 'rejected'
              : 'deprecated',
        resolvedBy: user,
        resolutionReason: input.reason.trim(),
        updatedAt: now,
      };
      this.write(db, record);
      return record;
    });
  }
}
