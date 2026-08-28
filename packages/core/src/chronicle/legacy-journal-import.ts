/**
 * One-shot import of the legacy JSONL journal into SQLite
 * (phase 2 of `chronicle-sqlite-journal-v1`).
 *
 * The events being moved are an audit record, so this is deliberately strict:
 * every event is verified against the running chain *before* it is inserted,
 * and a single break aborts that day inside a rolled-back transaction.
 * Repairing a broken chain silently would defeat the purpose of having one —
 * the operator is told exactly where it broke and decides.
 *
 * Chains are scoped to a day family (`<day>.events.jsonl` plus its `.NNNNN`
 * rotations), not to the journal as a whole: `sequence` restarts at 1 each day.
 * Each family is therefore imported as its own chain and its own transaction,
 * seeded from that family's `*.retention.json` checkpoint when its prefix was
 * already purged.
 *
 * A family that fails verification is quarantined — never imported, never
 * repaired, recorded by day so health can report it — and the remaining days
 * still move. Scoping the abort to the journal instead made every future day
 * hostage to the worst day on disk: one multi-writer partition from before the
 * single-daemon invariant, and the store could never finish opening, so
 * Chronicle recorded nothing at all from then on.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { chronicleEventHash, GENESIS_HASH } from './event-hash.js';
import { collectPartitions, readRetentionCheckpoint, streamEntriesStrict } from './journal.js';
import { PARTITION_FILE_PATTERN } from './partition-filename.js';
import type {
  ChronicleQuarantinedFamily,
  ChronicleSqliteJournal,
} from './sqlite-journal.js';

export interface ChronicleLegacyImportResult {
  /** True when the marker was already set and nothing was read. */
  alreadyImported: boolean;
  /** Day families imported. */
  families: number;
  /** Events imported across all families. */
  events: number;
  /** Day families refused for a broken chain; none of their events landed. */
  quarantined: ChronicleQuarantinedFamily[];
}

/** A chain break found while importing; carries enough context to act on. */
 class ChronicleImportError extends Error {
  constructor(
    message: string,
    readonly day: string,
    readonly sequence: number,
  ) {
    super(message);
    this.name = 'ChronicleImportError';
  }
}

/**
 * Discover the day families in a chronicle directory.
 *
 * `PARTITION_FILE_PATTERN` captures the family base (`<day>.events`) separately
 * from the rotation index, so rotations collapse onto the family they belong
 * to instead of being mistaken for separate days.
 */
async function discoverFamilies(directory: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(directory);
  } catch {
    return [];
  }
  const bases = new Set<string>();
  for (const entry of entries) {
    const match = PARTITION_FILE_PATTERN.exec(entry);
    if (match?.[1]) bases.add(match[1]);
  }
  return [...bases].sort();
}

/** `2026-07-28.events` → `2026-07-28`. */
function dayOfFamily(familyBase: string): string {
  return familyBase.replace(/\.events$/u, '');
}

export async function importLegacyChronicleJournal(
  journal: ChronicleSqliteJournal,
  directory: string,
): Promise<ChronicleLegacyImportResult> {
  if (journal.hasImportedLegacyJournal()) {
    return {
      alreadyImported: true,
      families: 0,
      events: 0,
      quarantined: journal.quarantinedFamilies(),
    };
  }

  const families = await discoverFamilies(directory);
  const quarantined: ChronicleQuarantinedFamily[] = [];
  const boundary: Record<string, number> = {};
  let importedEvents = 0;
  let importedFamilies = 0;

  for (const familyBase of families) {
    const day = dayOfFamily(familyBase);
    const basePath = path.join(directory, `${familyBase}.jsonl`);
    let familyEvents = 0;
    // Per-family boundary: only partitions whose family COMMITS belong in the
    // shared map. A quarantined family rolls back, so recording its files here
    // would make the metrics ingester treat them as already-migrated and skip
    // them — events counted nowhere (not in SQLite, not in the fold).
    const familyBoundary: Record<string, number> = {};

    // Resume rather than restart. Families commit one at a time, so a run cut
    // short — the daemon restarted, the machine rebooted — leaves whole days
    // already stored. Re-reading them would abort on the `(day, sequence)`
    // primary key and put the import back to square one every time.
    if (journal.hasImportedDay(day)) continue;

    try {
      // One transaction per family: a break below rolls back this day only,
      // leaving the days already committed — and every future day — intact.
      await journal.runFamilyImport(async (sink) => {
        familyEvents = 0;

        const checkpointResult = await readRetentionCheckpoint(basePath);
        if (checkpointResult.error) {
          throw new ChronicleImportError(checkpointResult.error, day, 0);
        }
        const checkpoint = checkpointResult.checkpoint;
        if (checkpoint) sink.checkpoint(day, checkpoint.sequence, checkpoint.hash);

        let expectedSequence = (checkpoint?.sequence ?? 0) + 1;
        let previousHash = checkpoint?.hash ?? GENESIS_HASH;

        for (const partition of await collectPartitions(basePath)) {
          // Per-file boundary: the metrics ingester folds only post-migration
          // appends beyond each partition's own import-time size. A family-wide
          // total would over-skip the active rotation after a rotation.
          familyBoundary[path.relative(directory, partition).replaceAll('\\', '/')] =
            (await fs.stat(partition)).size;
          for await (const event of streamEntriesStrict(partition)) {
            if (event.sequence !== expectedSequence) {
              throw new ChronicleImportError(
                `sequence gap in ${day}: expected ${expectedSequence}, found ${event.sequence}`,
                day,
                event.sequence,
              );
            }
            if (event.previousHash !== previousHash) {
              throw new ChronicleImportError(
                `previous hash mismatch in ${day} at sequence ${event.sequence}`,
                day,
                event.sequence,
              );
            }
            if (chronicleEventHash(event) !== event.hash) {
              throw new ChronicleImportError(
                `entry hash mismatch in ${day} at sequence ${event.sequence}`,
                day,
                event.sequence,
              );
            }
            sink.insert(day, event);
            familyEvents += 1;
            expectedSequence = event.sequence + 1;
            previousHash = event.hash;
          }
        }
      });
    } catch (error) {
      // A broken chain is data the operator has to decide about, so it is
      // quarantined and reported. Anything else — an unreadable file, a full
      // disk, SQLite refusing to write — is an infrastructure failure that
      // would corrupt the import if treated as "just skip that day".
      if (!(error instanceof ChronicleImportError)) throw error;
      quarantined.push({ day, sequence: error.sequence, reason: error.message });
      continue;
    }

    // The family committed — its files are now migrated and can join the map.
    Object.assign(boundary, familyBoundary);
    if (familyEvents > 0) importedFamilies += 1;
    importedEvents += familyEvents;
    // Persist as the family commits: a crash after this family (resume) keeps
    // its boundary instead of folding it from both SQLite and JSONL later.
    journal.recordLegacyJsonlBoundary(boundary);
  }

  journal.recordQuarantinedFamilies(quarantined);
  // Always persist the boundary row — even when every family was quarantined —
  // so the metrics ingester can tell a boundary-recording migration (empty row
  // → fold quarantined families from JSONL) from a pre-boundary-feature one
  // (no row → skip the partitions entirely).
  journal.recordLegacyJsonlBoundary(boundary);
  journal.markLegacyJournalImported();

  return {
    alreadyImported: false,
    families: importedFamilies,
    events: importedEvents,
    quarantined,
  };
}
