/**
 * One-shot import of the legacy JSONL journal into SQLite
 * (phase 2 of `chronicle-sqlite-journal-v1`).
 *
 * The events being moved are an audit record, so this is deliberately strict:
 * every event is verified against the running chain *before* it is inserted,
 * and a single break aborts the whole import inside one rolled-back
 * transaction. Repairing a broken chain silently would defeat the purpose of
 * having one — the operator is told exactly where it broke and decides.
 *
 * Chains are scoped to a day family (`<day>.events.jsonl` plus its `.NNNNN`
 * rotations), not to the journal as a whole: `sequence` restarts at 1 each day.
 * Each family is therefore imported as its own chain, seeded from that family's
 * `*.retention.json` checkpoint when its prefix was already purged.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { chronicleEventHash, GENESIS_HASH } from './event-hash.js';
import { collectPartitions, readRetentionCheckpoint, streamEntriesStrict } from './journal.js';
import { PARTITION_FILE_PATTERN } from './partition-filename.js';
import type { ChronicleSqliteJournal } from './sqlite-journal.js';

export interface ChronicleLegacyImportResult {
  /** True when the marker was already set and nothing was read. */
  alreadyImported: boolean;
  /** Day families imported. */
  families: number;
  /** Events imported across all families. */
  events: number;
}

/** A chain break found while importing; carries enough context to act on. */
export class ChronicleImportError extends Error {
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
    return { alreadyImported: true, families: 0, events: 0 };
  }

  const families = await discoverFamilies(directory);
  let importedEvents = 0;
  let importedFamilies = 0;

  await journal.runImport(async (sink) => {
    for (const familyBase of families) {
      const day = dayOfFamily(familyBase);
      const basePath = path.join(directory, `${familyBase}.jsonl`);

      const checkpointResult = await readRetentionCheckpoint(basePath);
      if (checkpointResult.error) {
        throw new ChronicleImportError(checkpointResult.error, day, 0);
      }
      const checkpoint = checkpointResult.checkpoint;
      if (checkpoint) sink.checkpoint(day, checkpoint.sequence, checkpoint.hash);

      let expectedSequence = (checkpoint?.sequence ?? 0) + 1;
      let previousHash = checkpoint?.hash ?? GENESIS_HASH;
      let familyEvents = 0;

      for (const partition of await collectPartitions(basePath)) {
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

      if (familyEvents > 0) importedFamilies += 1;
      importedEvents += familyEvents;
    }
  });

  return { alreadyImported: false, families: importedFamilies, events: importedEvents };
}
