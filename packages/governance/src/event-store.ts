import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { loadRuntimeDatabaseSync } from '@wrongstack/persistence';

import {
  applyGovernanceEvent,
  decideGovernanceCommand,
  type GovernanceCommand,
  type GovernanceCommandDecision,
  type GovernanceDecisionContext,
  type GovernanceEvent,
  replayTaskEvents,
  type TaskAggregate,
} from './task-aggregate.js';
import type {
  ConsumeVerificationExecutionLeaseResult,
  IssueVerificationExecutionLeaseResult,
  VerificationExecutionBinding,
  VerificationExecutionLeaseCredential,
  VerificationExecutionLeaseStatus,
  VerificationLeaseIssuancePrecondition,
} from './verification-execution-lease.js';
import { SqliteVerificationLedger } from './verification-ledger-store.js';
import type { VerificationRunContract } from './verification-run-contract.js';
import type {
  RecordWorkspaceSnapshotResult,
  WorkspaceSnapshotFenceDescriptor,
} from './workspace-snapshot-fence.js';

const GOVERNANCE_EVENT_STORE_SCHEMA_VERSION = 2;

interface EventRow {
  task_id: string;
  revision: number;
  event_json: string;
}

interface ReceiptRow {
  command_id: string;
  task_id: string;
  command_hash: string;
  command_json: string;
  context_json: string;
  decision_json: string;
  result_revision: number;
  recorded_at: string;
}

interface ObservationRow {
  sequence: number;
  observation_id: string;
  project_id: string;
  task_id: string | null;
  source: string;
  category: GovernanceObservationCategory;
  observation_json: string;
  observation_hash: string;
  observed_at: string;
  recorded_at: string;
}

export const GOVERNANCE_OBSERVATION_CATEGORIES = [
  'task_created',
  'status_changed',
  'plan_updated',
  'tool_invoked',
  'evidence_candidate',
  'verification_reported',
  'review_reported',
  'completion_claimed',
  'failure_reported',
  'capability_grant_issued',
  'capability_grant_revoked',
  'capability_grant_expired',
  'capability_grant_rotated',
  'daemon_attachment_broker_lifecycle',
  'daemon_shutdown_requested',
] as const;

export type GovernanceObservationCategory = (typeof GOVERNANCE_OBSERVATION_CATEGORIES)[number];

export const GOVERNANCE_OBSERVATION_DEFAULT_PAGE_SIZE = 50;
export const GOVERNANCE_OBSERVATION_MAX_PAGE_SIZE = 100;

interface ReadGovernanceObservationsPageOptions {
  readonly projectId: string;
  readonly taskId?: string | undefined;
  /**
   * Exact set of categories to return. Callers pass the closed enum subset they
   * are entitled to rather than filtering after the fact, so the database never
   * hands back rows that are about to be discarded.
   */
  readonly categories: readonly GovernanceObservationCategory[];
  readonly afterSequence: number;
  readonly limit: number;
}

export interface GovernanceObservation {
  readonly observationId: string;
  readonly projectId: string;
  readonly taskId: string | null;
  readonly source: string;
  readonly category: GovernanceObservationCategory;
  readonly observedAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface StoredGovernanceObservation extends GovernanceObservation {
  readonly sequence: number;
  readonly recordedAt: string;
}

export type AppendGovernanceObservationResult =
  | {
      readonly handled: true;
      readonly idempotentReplay: boolean;
      readonly observation: StoredGovernanceObservation;
    }
  | {
      readonly handled: false;
      readonly code: 'observation_id_conflict';
      readonly message: string;
    };

export interface GovernanceCommandReceipt {
  readonly commandId: string;
  readonly taskId: string;
  readonly command: GovernanceCommand;
  readonly decisionContext: GovernanceDecisionContext;
  readonly decision: GovernanceCommandDecision;
  readonly resultRevision: number;
  readonly recordedAt: string;
}

export type GovernanceCommandExecution =
  | {
      readonly handled: true;
      readonly idempotentReplay: boolean;
      readonly decision: GovernanceCommandDecision;
      readonly aggregate: TaskAggregate | null;
    }
  | {
      readonly handled: false;
      readonly code: 'command_id_conflict';
      readonly message: string;
    };

export interface GovernanceEventStore {
  execute(
    command: GovernanceCommand,
    context?: GovernanceDecisionContext,
  ): GovernanceCommandExecution;
  readTask(taskId: string): TaskAggregate | null;
  readEvents(taskId: string): readonly GovernanceEvent[];
  readReceipt(commandId: string): GovernanceCommandReceipt | null;
  appendObservation(observation: GovernanceObservation): AppendGovernanceObservationResult;
  readObservationsPage(
    options: ReadGovernanceObservationsPageOptions,
  ): readonly StoredGovernanceObservation[];
  readEvidenceCandidateObservations(
    projectId: string,
    taskId: string,
    options: { readonly afterSequence: number; readonly limit: number },
  ): readonly StoredGovernanceObservation[];
  recordWorkspaceSnapshot(projectId: string, manifestHash: string): RecordWorkspaceSnapshotResult;
  readLatestWorkspaceSnapshot(projectId: string): WorkspaceSnapshotFenceDescriptor | null;
  issueVerificationExecutionLease(
    run: VerificationRunContract,
  ): IssueVerificationExecutionLeaseResult;
  issueVerificationExecutionLeaseIfCurrent(
    run: VerificationRunContract,
    precondition: VerificationLeaseIssuancePrecondition,
  ): IssueVerificationExecutionLeaseResult;
  consumeVerificationExecutionLease(
    credential: VerificationExecutionLeaseCredential,
    binding: VerificationExecutionBinding,
  ): ConsumeVerificationExecutionLeaseResult;
  readVerificationExecutionLeaseStatus(leaseId: string): VerificationExecutionLeaseStatus;
  close(): void;
}

interface SqliteGovernanceEventStoreOptions {
  readonly now?: (() => string) | undefined;
  readonly verificationLeaseSecret?: (() => string) | undefined;
}

class GovernanceStoreCorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GovernanceStoreCorruptionError';
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => [key, canonicalize(entryValue)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function commandHash(command: GovernanceCommand): string {
  return createHash('sha256').update(canonicalJson(command)).digest('hex');
}

function observationHash(observation: GovernanceObservation): string {
  return createHash('sha256').update(canonicalJson(observation)).digest('hex');
}

function parseJson<T>(json: string, description: string): T {
  try {
    return JSON.parse(json) as T;
  } catch (error) {
    throw new GovernanceStoreCorruptionError(
      `Cannot parse stored ${description}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export class SqliteGovernanceEventStore implements GovernanceEventStore {
  readonly databasePath: string;

  private readonly db: DatabaseSync;
  private readonly now: () => string;
  private readonly verificationLedger: SqliteVerificationLedger;
  private closed = false;

  private constructor(databasePath: string, options: SqliteGovernanceEventStoreOptions) {
    this.databasePath = databasePath;
    this.now = options.now ?? (() => new Date().toISOString());
    const Database = loadRuntimeDatabaseSync();
    this.db = new Database(databasePath);
    this.verificationLedger = new SqliteVerificationLedger(this.db, {
      now: this.now,
      verificationLeaseSecret: options.verificationLeaseSecret,
    });
    try {
      this.initializeSchema();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  static open(
    databasePath: string,
    options: SqliteGovernanceEventStoreOptions = {},
  ): SqliteGovernanceEventStore {
    return new SqliteGovernanceEventStore(databasePath, options);
  }

  execute(
    command: GovernanceCommand,
    context: GovernanceDecisionContext = {},
  ): GovernanceCommandExecution {
    this.assertOpen();
    const hash = commandHash(command);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.readReceiptRow(command.commandId);
      if (existing) {
        if (existing.command_hash !== hash) {
          this.db.exec('COMMIT');
          return {
            handled: false,
            code: 'command_id_conflict',
            message: `Command id ${command.commandId} was already used for a different command payload.`,
          };
        }
        const execution = this.executionFromReceipt(existing, true);
        this.db.exec('COMMIT');
        return execution;
      }

      const aggregate = this.readTaskUnlocked(command.taskId);
      const decision = decideGovernanceCommand(aggregate, command, context);
      let resultAggregate = aggregate;
      if (decision.accepted) {
        const applied = applyGovernanceEvent(aggregate, decision.event);
        if (!applied.applied) {
          throw new GovernanceStoreCorruptionError(
            `Accepted command produced an invalid event: ${applied.code}: ${applied.message}`,
          );
        }
        this.db
          .prepare(
            `INSERT INTO governance_events
               (task_id, revision, event_id, command_id, event_json, occurred_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            decision.event.taskId,
            decision.event.revision,
            decision.event.eventId,
            decision.event.commandId,
            canonicalJson(decision.event),
            decision.event.occurredAt,
          );
        resultAggregate = applied.aggregate;
      }

      const resultRevision = resultAggregate?.revision ?? 0;
      this.db
        .prepare(
          `INSERT INTO governance_command_receipts
             (command_id, task_id, command_hash, command_json, context_json, decision_json,
              result_revision, recorded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          command.commandId,
          command.taskId,
          hash,
          canonicalJson(command),
          canonicalJson(context),
          canonicalJson(decision),
          resultRevision,
          this.now(),
        );
      this.db.exec('COMMIT');
      return {
        handled: true,
        idempotentReplay: false,
        decision,
        aggregate: resultAggregate,
      };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  readTask(taskId: string): TaskAggregate | null {
    this.assertOpen();
    return this.readTaskUnlocked(taskId);
  }

  readEvents(taskId: string): readonly GovernanceEvent[] {
    this.assertOpen();
    return Object.freeze(this.readEventsUnlocked(taskId));
  }

  readReceipt(commandId: string): GovernanceCommandReceipt | null {
    this.assertOpen();
    const row = this.readReceiptRow(commandId);
    return row ? this.receiptFromRow(row) : null;
  }

  appendObservation(observation: GovernanceObservation): AppendGovernanceObservationResult {
    this.assertOpen();
    const hash = observationHash(observation);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.readObservationRow(observation.observationId);
      if (existing) {
        if (existing.observation_hash !== hash) {
          this.db.exec('COMMIT');
          return {
            handled: false,
            code: 'observation_id_conflict',
            message: `Observation id ${observation.observationId} was already used for a different payload.`,
          };
        }
        this.db.exec('COMMIT');
        return {
          handled: true,
          idempotentReplay: true,
          observation: this.observationFromRow(existing),
        };
      }

      const recordedAt = this.now();
      const result = this.db
        .prepare(
          `INSERT INTO governance_observations
             (observation_id, project_id, task_id, source, category, observation_json,
              observation_hash, observed_at, recorded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          observation.observationId,
          observation.projectId,
          observation.taskId,
          observation.source,
          observation.category,
          canonicalJson(observation),
          hash,
          observation.observedAt,
          recordedAt,
        );
      const stored = deepFreeze({
        ...observation,
        sequence: Number(result.lastInsertRowid),
        recordedAt,
      });
      this.db.exec('COMMIT');
      return { handled: true, idempotentReplay: false, observation: stored };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Paginated, category-filtered observation read.
   *
   * The observations table is append-only — its UPDATE and DELETE triggers say
   * so — and therefore grows without bound for the lifetime of a project. The
   * previous unpaginated read loaded every row a project had ever recorded and
   * left the caller to filter in JavaScript, which cost 148 MB and 400 ms at
   * 100 000 rows and produced a 8.9 MB response: already past the 8 MB IPC
   * frame cap, so the endpoint could not succeed at all past that point. Both
   * the category filter and the page window belong in SQL, matching what
   * `readEvidenceCandidateObservations` already does.
   */
  readObservationsPage(
    options: ReadGovernanceObservationsPageOptions,
  ): readonly StoredGovernanceObservation[] {
    this.assertOpen();
    if (!Number.isSafeInteger(options.afterSequence) || options.afterSequence < 0) {
      throw new Error('Observation cursor must be a non-negative safe integer.');
    }
    if (
      !Number.isSafeInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > GOVERNANCE_OBSERVATION_MAX_PAGE_SIZE + 1
    ) {
      throw new Error(
        `Observation query limit must be between 1 and ${GOVERNANCE_OBSERVATION_MAX_PAGE_SIZE + 1}.`,
      );
    }
    if (options.categories.length === 0) return Object.freeze([]);

    const parameters: (string | number)[] = [options.projectId];
    let where = 'project_id = ?';
    if (options.taskId !== undefined) {
      where += ' AND task_id = ?';
      parameters.push(options.taskId);
    }
    // The categories are a closed enum, so an IN list is exact. A LIKE on the
    // `capability_grant_`/`daemon_` prefixes would need escaping — `_` is a
    // single-character wildcard in LIKE — and would silently widen the match.
    where += ` AND category IN (${options.categories.map(() => '?').join(',')})`;
    parameters.push(...options.categories);
    where += ' AND sequence > ?';
    parameters.push(options.afterSequence, options.limit);

    const rows = this.db
      .prepare(
        `SELECT sequence, observation_id, project_id, task_id, source, category,
                observation_json, observation_hash, observed_at, recorded_at
         FROM governance_observations
         WHERE ${where}
         ORDER BY sequence
         LIMIT ?`,
      )
      .all(...parameters) as unknown as ObservationRow[];
    return Object.freeze(rows.map((row) => this.observationFromRow(row)));
  }

  readEvidenceCandidateObservations(
    projectId: string,
    taskId: string,
    options: { readonly afterSequence: number; readonly limit: number },
  ): readonly StoredGovernanceObservation[] {
    this.assertOpen();
    if (!Number.isSafeInteger(options.afterSequence) || options.afterSequence < 0) {
      throw new Error('Evidence candidate cursor must be a non-negative safe integer.');
    }
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 101) {
      throw new Error('Evidence candidate query limit must be between 1 and 101.');
    }
    const rows = this.db
      .prepare(
        `SELECT sequence, observation_id, project_id, task_id, source, category,
                observation_json, observation_hash, observed_at, recorded_at
         FROM governance_observations
         WHERE project_id = ? AND task_id = ? AND category = 'evidence_candidate' AND sequence > ?
         ORDER BY sequence
         LIMIT ?`,
      )
      .all(projectId, taskId, options.afterSequence, options.limit) as unknown as ObservationRow[];
    return Object.freeze(rows.map((row) => this.observationFromRow(row)));
  }

  issueVerificationExecutionLease(
    run: VerificationRunContract,
  ): IssueVerificationExecutionLeaseResult {
    this.assertOpen();
    return this.verificationLedger.issue(run);
  }

  recordWorkspaceSnapshot(projectId: string, manifestHash: string): RecordWorkspaceSnapshotResult {
    this.assertOpen();
    return this.verificationLedger.recordWorkspaceSnapshot(projectId, manifestHash);
  }

  readLatestWorkspaceSnapshot(projectId: string): WorkspaceSnapshotFenceDescriptor | null {
    this.assertOpen();
    return this.verificationLedger.readLatestWorkspaceSnapshot(projectId);
  }

  issueVerificationExecutionLeaseIfCurrent(
    run: VerificationRunContract,
    precondition: VerificationLeaseIssuancePrecondition,
  ): IssueVerificationExecutionLeaseResult {
    this.assertOpen();
    return this.verificationLedger.issueIfCurrent(run, precondition);
  }

  consumeVerificationExecutionLease(
    credential: VerificationExecutionLeaseCredential,
    binding: VerificationExecutionBinding,
  ): ConsumeVerificationExecutionLeaseResult {
    this.assertOpen();
    return this.verificationLedger.consume(credential, binding);
  }

  readVerificationExecutionLeaseStatus(leaseId: string): VerificationExecutionLeaseStatus {
    this.assertOpen();
    return this.verificationLedger.readStatus(leaseId);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private initializeSchema(): void {
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = FULL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec('PRAGMA foreign_keys = ON');
    const version = (
      this.db.prepare('PRAGMA user_version').get() as unknown as { user_version: number }
    ).user_version;
    if (version !== 0 && version !== 1 && version !== GOVERNANCE_EVENT_STORE_SCHEMA_VERSION) {
      throw new Error(
        `Unsupported governance event store schema version ${version}; expected ${GOVERNANCE_EVENT_STORE_SCHEMA_VERSION}.`,
      );
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS governance_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        event_id TEXT NOT NULL UNIQUE,
        command_id TEXT NOT NULL UNIQUE,
        event_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        UNIQUE (task_id, revision)
      );

      CREATE TABLE IF NOT EXISTS governance_command_receipts (
        command_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        command_hash TEXT NOT NULL,
        command_json TEXT NOT NULL,
        context_json TEXT NOT NULL,
        decision_json TEXT NOT NULL,
        result_revision INTEGER NOT NULL CHECK (result_revision >= 0),
        recorded_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS governance_observations (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        observation_id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL,
        task_id TEXT,
        source TEXT NOT NULL,
        category TEXT NOT NULL,
        observation_json TEXT NOT NULL,
        observation_hash TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );


      CREATE INDEX IF NOT EXISTS governance_receipts_task_idx
        ON governance_command_receipts (task_id, recorded_at);

      CREATE INDEX IF NOT EXISTS governance_observations_project_task_idx
        ON governance_observations (project_id, task_id, sequence);


      CREATE TRIGGER IF NOT EXISTS governance_events_no_update
      BEFORE UPDATE ON governance_events
      BEGIN
        SELECT RAISE(ABORT, 'governance_events is append-only');
      END;

      CREATE TRIGGER IF NOT EXISTS governance_events_no_delete
      BEFORE DELETE ON governance_events
      BEGIN
        SELECT RAISE(ABORT, 'governance_events is append-only');
      END;

      CREATE TRIGGER IF NOT EXISTS governance_receipts_no_update
      BEFORE UPDATE ON governance_command_receipts
      BEGIN
        SELECT RAISE(ABORT, 'governance_command_receipts is append-only');
      END;

      CREATE TRIGGER IF NOT EXISTS governance_receipts_no_delete
      BEFORE DELETE ON governance_command_receipts
      BEGIN
        SELECT RAISE(ABORT, 'governance_command_receipts is append-only');
      END;

      CREATE TRIGGER IF NOT EXISTS governance_observations_no_update
      BEFORE UPDATE ON governance_observations
      BEGIN
        SELECT RAISE(ABORT, 'governance_observations is append-only');
      END;

      CREATE TRIGGER IF NOT EXISTS governance_observations_no_delete
      BEFORE DELETE ON governance_observations
      BEGIN
        SELECT RAISE(ABORT, 'governance_observations is append-only');
      END;


    `);
    this.verificationLedger.initializeSchema();
    this.db.exec(`PRAGMA user_version = ${GOVERNANCE_EVENT_STORE_SCHEMA_VERSION}`);
  }

  private readEventsUnlocked(taskId: string, upToRevision?: number): GovernanceEvent[] {
    const rows = (upToRevision === undefined
      ? this.db
          .prepare(
            `SELECT task_id, revision, event_json
             FROM governance_events
             WHERE task_id = ?
             ORDER BY revision`,
          )
          .all(taskId)
      : this.db
          .prepare(
            `SELECT task_id, revision, event_json
             FROM governance_events
             WHERE task_id = ? AND revision <= ?
             ORDER BY revision`,
          )
          .all(taskId, upToRevision)) as unknown as EventRow[];
    return rows.map((row) => {
      const event = parseJson<GovernanceEvent>(row.event_json, 'governance event');
      if (event.taskId !== row.task_id || event.revision !== row.revision) {
        throw new GovernanceStoreCorruptionError(
          `Stored event columns do not match payload for task ${row.task_id} revision ${row.revision}.`,
        );
      }
      return deepFreeze(event);
    });
  }

  private readTaskUnlocked(taskId: string, upToRevision?: number): TaskAggregate | null {
    const events = this.readEventsUnlocked(taskId, upToRevision);
    if (events.length === 0) return null;
    const replay = replayTaskEvents(events);
    if (!replay.replayed) {
      throw new GovernanceStoreCorruptionError(
        `Cannot replay task ${taskId} at event ${replay.eventIndex}: ${replay.code}: ${replay.message}`,
      );
    }
    return replay.aggregate;
  }

  private readReceiptRow(commandId: string): ReceiptRow | undefined {
    return this.db
      .prepare(
        `SELECT command_id, task_id, command_hash, command_json, context_json, decision_json,
                result_revision, recorded_at
         FROM governance_command_receipts
         WHERE command_id = ?`,
      )
      .get(commandId) as unknown as ReceiptRow | undefined;
  }

  private readObservationRow(observationId: string): ObservationRow | undefined {
    return this.db
      .prepare(
        `SELECT sequence, observation_id, project_id, task_id, source, category,
                observation_json, observation_hash, observed_at, recorded_at
         FROM governance_observations
         WHERE observation_id = ?`,
      )
      .get(observationId) as unknown as ObservationRow | undefined;
  }

  private receiptFromRow(row: ReceiptRow): GovernanceCommandReceipt {
    return deepFreeze({
      commandId: row.command_id,
      taskId: row.task_id,
      command: parseJson<GovernanceCommand>(row.command_json, 'governance command'),
      decisionContext: parseJson<GovernanceDecisionContext>(
        row.context_json,
        'governance decision context',
      ),
      decision: parseJson<GovernanceCommandDecision>(row.decision_json, 'governance decision'),
      resultRevision: row.result_revision,
      recordedAt: row.recorded_at,
    });
  }

  private observationFromRow(row: ObservationRow): StoredGovernanceObservation {
    const observation = parseJson<GovernanceObservation>(
      row.observation_json,
      'governance observation',
    );
    if (
      observation.observationId !== row.observation_id ||
      observation.projectId !== row.project_id ||
      observation.taskId !== row.task_id ||
      observation.source !== row.source ||
      observation.category !== row.category ||
      observation.observedAt !== row.observed_at
    ) {
      throw new GovernanceStoreCorruptionError(
        `Stored observation columns do not match payload for ${row.observation_id}.`,
      );
    }
    return deepFreeze({ ...observation, sequence: row.sequence, recordedAt: row.recorded_at });
  }

  private executionFromReceipt(
    row: ReceiptRow,
    idempotentReplay: boolean,
  ): GovernanceCommandExecution {
    const receipt = this.receiptFromRow(row);
    return {
      handled: true,
      idempotentReplay,
      decision: receipt.decision,
      aggregate: this.readTaskUnlocked(receipt.taskId, receipt.resultRevision),
    };
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Governance event store is closed.');
  }
}
