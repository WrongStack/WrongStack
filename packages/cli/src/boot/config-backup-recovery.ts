import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWrite, backupConfigFile, color, toErrorMessage } from '@wrongstack/core/utils';
import type { ReadlineInputReader } from '../input-reader.js';
import type { TerminalRenderer } from '../renderer.js';

interface ProviderConfigBackup {
  filePath: string;
  fileName: string;
  raw: string;
  providerIds: string[];
  modifiedAtMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function providerIds(value: unknown): string[] {
  if (!isRecord(value)) return [];
  const providers = value['providers'];
  return isRecord(providers) ? Object.keys(providers) : [];
}

/**
 * Recovery is intentionally based on the profile file itself, not the merged
 * runtime config. Project-local overrides must not hide an empty default
 * profile and prevent the user from recovering their global settings.
 */
export async function defaultProfileProvidersAreEmpty(profilePath: string): Promise<boolean> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(profilePath, 'utf8'));
    return providerIds(parsed).length === 0;
  } catch {
    return false;
  }
}

function profileSnapshotTimestamp(fileName: string, fallback: number): number {
  const match =
    /^profiles-default-config-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})\.json$/i.exec(
      fileName,
    );
  if (!match) return fallback;
  const [, year, month, day, hour, minute, second, millisecond] = match;
  return Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Number(millisecond),
  );
}

/**
 * Find the newest valid default-profile snapshot that actually contains
 * providers. Profile config history uses names such as
 * `profiles-default-config-2026-07-19T12-34-56-789.json`.
 */
export async function findLatestProviderBackup(
  globalRoot: string,
): Promise<ProviderConfigBackup | undefined> {
  const directory = path.join(globalRoot, 'config-history');
  const candidates: Array<{ filePath: string; fileName: string; modifiedAtMs: number }> = [];

  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (
      !entry.isFile() ||
      !/^profiles-default-config-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}\.json$/i.test(entry.name)
    ) {
      continue;
    }
    const filePath = path.join(directory, entry.name);
    try {
      const stat = await fs.stat(filePath);
      candidates.push({
        filePath,
        fileName: entry.name,
        modifiedAtMs: profileSnapshotTimestamp(entry.name, stat.mtimeMs),
      });
    } catch {
      // File disappeared between readdir and stat; skip it.
    }
  }

  candidates.sort((a, b) => b.modifiedAtMs - a.modifiedAtMs);
  for (const candidate of candidates) {
    try {
      const raw = await fs.readFile(candidate.filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      const ids = providerIds(parsed);
      if (ids.length === 0) continue;
      return { ...candidate, raw, providerIds: ids };
    } catch {
      // A broken/newer backup must not prevent using the next valid snapshot.
    }
  }
  return undefined;
}

 async function restoreDefaultProfileBackup(opts: {
  backup: ProviderConfigBackup;
  globalRoot: string;
  profilePath: string;
}): Promise<void> {
  await backupConfigFile(opts.profilePath, { globalRoot: opts.globalRoot });
  await fs.mkdir(path.dirname(opts.profilePath), { recursive: true });
  await atomicWrite(opts.profilePath, opts.backup.raw, { mode: 0o600 });
}

/** Prompt once during an ordinary interactive boot. Enter accepts recovery. */
export async function maybeRestoreDefaultProfileFromBackup(opts: {
  globalRoot: string;
  profilePath: string;
  renderer: TerminalRenderer;
  reader: ReadlineInputReader;
}): Promise<boolean> {
  if (!(await defaultProfileProvidersAreEmpty(opts.profilePath))) return false;

  const backup = await findLatestProviderBackup(opts.globalRoot);
  if (!backup) return false;

  const shownProviders = backup.providerIds.slice(0, 5).join(', ');
  const remainder = backup.providerIds.length - 5;
  const providerSummary = remainder > 0 ? `${shownProviders} +${remainder}` : shownProviders;
  opts.renderer.write(
    `\n  ${color.amber('○')} ${color.bold('default')} profile has no saved providers.\n` +
      `  ${color.dim('Latest usable backup:')} ${color.bold(backup.fileName)} ` +
      `${color.dim(`(${backup.providerIds.length} provider: ${providerSummary})`)}\n`,
  );

  const answer = (
    await opts.reader.readLine(
      `  ${color.amber('?')} Restore all settings from this backup? ${color.dim('[Y/n]')} `,
    )
  )
    .trim()
    .toLowerCase();
  if (answer === 'n' || answer === 'no') return false;

  try {
    await restoreDefaultProfileBackup({
      backup,
      globalRoot: opts.globalRoot,
      profilePath: opts.profilePath,
    });
    opts.renderer.write(
      `  ${color.green('✓')} Restored all settings from ${color.dim(backup.fileName)}\n`,
    );
    return true;
  } catch (err) {
    opts.renderer.writeWarning(`Could not restore config backup: ${toErrorMessage(err)}\n`);
    return false;
  }
}
