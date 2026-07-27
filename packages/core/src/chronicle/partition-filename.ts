import * as path from 'node:path';

/** Matches both rotated (`*.events.NNNNN.jsonl`) and unrotated (`*.events.jsonl`) partition files. */
export const PARTITION_FILE_PATTERN = /^(.*\.events)(?:\.(\d{5}))?\.jsonl$/;

/** Directory + family name, so files with the same basename family in different directories don't collide. */
export function partitionFamily(filePath: string): string {
  const match = PARTITION_FILE_PATTERN.exec(path.basename(filePath));
  return path.join(path.dirname(filePath), match?.[1] ?? path.basename(filePath));
}

export function partitionSequence(filePath: string): number {
  const match = PARTITION_FILE_PATTERN.exec(path.basename(filePath));
  return Number(match?.[2] ?? 0);
}

/** Orders partitions by family, then by rotation sequence — the unrotated file (no sequence) sorts first. */
export function comparePartitionPaths(left: string, right: string): number {
  const familyOrder = partitionFamily(left).localeCompare(partitionFamily(right));
  return familyOrder || partitionSequence(left) - partitionSequence(right);
}
