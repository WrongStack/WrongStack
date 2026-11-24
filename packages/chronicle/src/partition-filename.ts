import * as path from 'node:path';

/** Matches both rotated (`*.events.NNNNN.jsonl`) and unrotated (`*.events.jsonl`) partition files. */
export const PARTITION_FILE_PATTERN = /^(.*\.events)(?:\.(\d{5}))?\.jsonl$/;

function partitionFamily(filePath: string): string {
  const match = PARTITION_FILE_PATTERN.exec(path.basename(filePath));
  return path.join(path.dirname(filePath), match?.[1] ?? path.basename(filePath));
}

function partitionSequence(filePath: string): number {
  const match = PARTITION_FILE_PATTERN.exec(path.basename(filePath));
  return Number(match?.[2] ?? 0);
}

/** Orders partitions by family, then by rotation sequence — the unrotated file (no sequence) sorts first. */
export function comparePartitionPaths(left: string, right: string): number {
  // F103: code-unit order — localeCompare collapses distinct canonically
  // equivalent family names ('café' vs 'cafe\u0301') into an unstable sort.
  const lf = partitionFamily(left);
  const rf = partitionFamily(right);
  const familyOrder = lf < rf ? -1 : lf > rf ? 1 : 0;
  return familyOrder || partitionSequence(left) - partitionSequence(right);
}
