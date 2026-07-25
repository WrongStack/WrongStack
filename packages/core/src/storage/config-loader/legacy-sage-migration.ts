import { isPlainRecord } from './default-repair.js';

/**
 * Migrate the retired `superMemory` config key (pre-SAGE-rename user configs)
 * into `Sage`. Existing `Sage` values win on conflict; top-level sub-keys the
 * user only ever set under `superMemory` are preserved so a rename release
 * does not silently drop their storage/injection/hygiene settings.
 */
export function migrateLegacySuperMemoryKey(config: Record<string, unknown>): boolean {
  const legacy = config['superMemory'];
  if (legacy === undefined) return false;
  if (isPlainRecord(legacy)) {
    const current = config['Sage'];
    config['Sage'] = isPlainRecord(current) ? { ...legacy, ...current } : { ...legacy };
  }
  delete config['superMemory'];
  return true;
}

/** Remove the retired backend selector from legacy/user-supplied configs. */
export function removeLegacySageEngine(config: Record<string, unknown>): boolean {
  const migratedKey = migrateLegacySuperMemoryKey(config);
  const Sage = config['Sage'];
  if (!isPlainRecord(Sage)) return migratedKey;
  const storage = Sage['storage'];
  if (!isPlainRecord(storage) || !Object.hasOwn(storage, 'engine')) {
    return migratedKey;
  }
  delete storage['engine'];
  return true;
}
