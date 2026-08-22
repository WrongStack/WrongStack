import { color, expectDefined } from '@wrongstack/core/utils';
import {
  getHistoryEntry,
  listHistory,
  restoreFromHistory,
  restoreLast,
} from '../../config-history.js';
import type { SubcommandHandler } from '../contracts.js';
/**
 * `wrongstack config history` — list history entries or show details.
 */
export const historyCmd: SubcommandHandler = async (args, deps) => {
  const idFlag = extractArg(args, '--id');

  if (idFlag) {
    const entry = await getHistoryEntry(idFlag);
    if (!entry) {
      deps.renderer.write(`History entry '${idFlag}' not found.\n`);
      return 1;
    }
    deps.renderer.write(
      [
        `ID:       ${entry.id}`,
        `Time:     ${new Date(entry.timestamp).toLocaleString()}`,
        `Change:   ${entry.description}`,
        `Diff:     ${entry.diffSummary}`,
        '',
        'Snapshot (secrets masked):',
        JSON.stringify(entry.snapshotMasked, null, 2),
      ].join('\n') + '\n',
    );
    return 0;
  }

  const entries = await listHistory();
  if (entries.length === 0) {
    deps.renderer.write('No config history yet.\n');
    return 0;
  }

  deps.renderer.write(
    [
      color.bold('Config History'),
      '',
      ...entries.map((e, i) => {
        const short = `[${i + 1}] ${e.id}  ${new Date(e.timestamp).toLocaleString()}`;
        const desc = e.description.length > 60 ? e.description.slice(0, 60) + '…' : e.description;
        return `  ${short}\n     ${desc}`;
      }),
      '',
      `Run \`wrongstack config history --id <id>\` for details.`,
      `Run \`wrongstack config restore <id>\` to restore.`,
    ].join('\n') + '\n',
  );

  return 0;
};

/**
 * `wrongstack config restore <id>` or `wrongstack config restore --latest`
 */
export const restoreCmd: SubcommandHandler = async (args, deps) => {
  const latest = args.includes('--latest') || args.includes('-l');
  const id = extractArg(args, '--id') ?? args[0];

  if (latest) {
    const result = await restoreLast();
    if (!result.ok) {
      deps.renderer.write(`Restore failed: ${result.error}\n`);
      return 1;
    }
    deps.renderer.write(`Restored from config.json.last.\n`);
    return 0;
  }

  if (!id) {
    deps.renderer.write('Usage: wrongstack config restore <id> | --latest\n');
    return 1;
  }

  const result = await restoreFromHistory(id);
  if (!result.ok) {
    deps.renderer.write(`Restore failed: ${result.error}\n`);
    return 1;
  }

  deps.renderer.write(`Restored to history entry '${id}'. Backup created.\n`);
  return 0;
};

/** Extract `--key value` from args, returning value or null */
function extractArg(args: string[], key: string): string | null {
  const idx = args.indexOf(key);
  if (idx !== -1 && args[idx + 1] !== undefined) return expectDefined(args[idx + 1]);
  // Support --key=value
  const eq = key.startsWith('--') ? args.find((a) => a.startsWith(`${key}=`)) : null;
  if (eq) return eq.slice(eq.indexOf('=') + 1);
  return null;
}
