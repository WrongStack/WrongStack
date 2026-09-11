export class UsageError extends Error {}

export class VerificationTimeoutError extends Error {}

export interface PublishOptions {
  plan: boolean;
  dryRun: boolean;
  verifyOnly: boolean;
  verify: boolean;
  pack: boolean;
  packDestination: string;
  tarballsDir: string | null;
  help: boolean;
  registry: string;
  timeoutMs: number;
  intervalMs: number;
  settleMs: number;
  passthrough: string[];
}

export function parseArgs(argv: string[]): PublishOptions;

export function checkPublished(
  registry: string,
  name: string,
  version: string,
  deps?: { fetch?: typeof globalThis.fetch },
): Promise<{ ok: true } | { ok: false; reason: string }>;

export function partitionLive<T extends { name: string; version: string }>(
  layer: T[],
  options: { registry: string },
  deps?: { checkPublished?: typeof checkPublished },
): Promise<{ live: T[]; pending: T[] }>;

export function main(argv: string[]): Promise<number>;
