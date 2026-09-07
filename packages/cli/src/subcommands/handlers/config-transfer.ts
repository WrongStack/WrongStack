import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { color, toErrorMessage } from '@wrongstack/core/utils';
import {
  extractBehaviorSettings,
  mergeBehaviorSettings,
} from '../../settings-behavior-sections.js';
import type { SubcommandHandler } from '../contracts.js';

const FILE_NAME = 'wstack-config.json';
const SAFETY_NOTE =
  'No providers, API keys, fallbacks, or model/fallback routing data is included.';

/** `wstack config-export` — write portable behavior settings to ./wstack-config.json. */
export const configExportCmd: SubcommandHandler = async (_args, deps) => {
  const settings = extractBehaviorSettings(deps.config as unknown as Record<string, unknown>);
  const payload = {
    kind: 'wstack-config',
    version: 1,
    exportedAt: new Date().toISOString(),
    profile: String(
      (deps.config as unknown as Record<string, unknown>)['activeProfile'] ?? 'default',
    ),
    settings,
  };
  const target = path.resolve(deps.cwd, FILE_NAME);
  try {
    await fs.writeFile(target, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  } catch (err) {
    deps.renderer.writeError(`Export failed: ${toErrorMessage(err)}`);
    return 1;
  }
  deps.renderer.write(`${color.green('✓')} Wrote ${color.cyan(target)}\n`);
  deps.renderer.write(`  Sections: ${color.cyan(Object.keys(settings).join(', '))}\n`);
  deps.renderer.write(`  ${color.dim(SAFETY_NOTE)}\n`);
  return 0;
};

/** `wstack config-import` — apply ./wstack-config.json behavior settings to the active profile. */
export const configImportCmd: SubcommandHandler = async (_args, deps) => {
  const target = path.resolve(deps.cwd, FILE_NAME);
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(await fs.readFile(target, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    deps.renderer.writeError(
      `Import failed: cannot read ${FILE_NAME} in ${deps.cwd} — ${toErrorMessage(err)}`,
    );
    return 1;
  }
  if (payload['kind'] !== 'wstack-config') {
    deps.renderer.writeError(
      `Import failed: ${FILE_NAME} is not a wstack config export (missing "kind": "wstack-config").`,
    );
    return 1;
  }
  const settings = payload['settings'];
  if (settings === null || typeof settings !== 'object') {
    deps.renderer.writeError('Import failed: the export carries no settings object.');
    return 1;
  }

  // Read the persisted profile — not the materialized config — so identity
  // fields (providers, API keys, fallbacks) written only on disk survive.
  const profile = String(
    (deps.config as unknown as Record<string, unknown>)['activeProfile'] ?? 'default',
  );
  const profilePath = deps.paths.profileConfig(profile);
  let disk: Record<string, unknown> = {};
  try {
    disk = JSON.parse(await fs.readFile(profilePath, 'utf8')) as Record<string, unknown>;
  } catch {
    // Fresh/missing profile: start empty — the loader re-materializes defaults.
  }

  // Only the known behavior sections are applied; anything else the export
  // file may carry (providers, fallbacks, custom keys) is ignored by design.
  const applied = mergeBehaviorSettings(disk, settings as Record<string, unknown>);
  if (applied.length === 0) {
    deps.renderer.write(
      `${color.amber('Nothing to import')} — the export carries none of the known behavior sections.\n`,
    );
    return 0;
  }
  try {
    await fs.writeFile(profilePath, `${JSON.stringify(disk, null, 2)}\n`, 'utf8');
  } catch (err) {
    deps.renderer.writeError(`Import failed while writing profile: ${toErrorMessage(err)}`);
    return 1;
  }
  deps.renderer.write(
    `${color.green('✓')} Imported ${applied.length} section(s) into profile ${color.cyan(profile)}: ${color.cyan(applied.join(', '))}\n`,
  );
  deps.renderer.write(`  ${color.dim(SAFETY_NOTE)}\n`);
  deps.renderer.write(`  ${color.dim('Restart wstack so imported settings take effect.')}\n`);
  return 0;
};
