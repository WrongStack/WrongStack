import type { CheckpointGcResult } from '@wrongstack/core/storage';
import type { SlashCommand } from '@wrongstack/core/types';
import { color } from '@wrongstack/core/utils';
import type { SlashCommandContext } from './command-context.js';

/** Shared by session pruning and the checkpoint sweep; default 30 days. */
function parseMaxAgeDays(parts: readonly string[]): number {
  const numPart = parts.find((p) => /^\d+$/.test(p));
  if (!numPart) return 30;
  return Math.max(1, Math.min(365, Number.parseInt(numPart, 10)));
}

export function buildPruneCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'prune',
    category: 'Session',
    description:
      'Delete old sessions. /prune (default 30d). To compress instead of delete, use /sessions archive.',
    help:
      'Usage:\n' +
      '  /prune               Delete sessions older than 30 days.\n' +
      '  /prune 14            Delete sessions older than 14 days.\n' +
      '  /prune --dry-run     Show what would be deleted without deleting.\n' +
      '  /prune --rebuild-index  Rebuild the session index from disk.\n' +
      '  /prune --checkpoints Reclaim workspace checkpoints no session references.',
    async run(args) {
      const parts = args.split(/\s+/).filter(Boolean);
      const rebuildIndex = parts.includes('--rebuild-index') || parts.includes('--rebuild');
      const dryRun = parts.includes('--dry-run');
      const checkpoints = parts.includes('--checkpoints');

      if (checkpoints) {
        // Deleting a session removed its transcript but never the workspace
        // checkpoints it pointed at, so the CAS only ever grew. This is a
        // separate, explicit sweep because it has to read every surviving
        // transcript to know what is still referenced — 101 seconds on a real
        // store, which is why it is not part of boot or of a plain /prune.
        const store = opts.sessionStore as
          | { collectCheckpointGarbage?: (maxAgeDays: number) => Promise<CheckpointGcResult> }
          | undefined;
        if (!store?.collectCheckpointGarbage) {
          return { message: color.yellow('Session store does not support checkpoint GC.') };
        }
        const ageDays = parseMaxAgeDays(parts);
        const gc = await store.collectCheckpointGarbage(ageDays);
        if (gc.manifestsDeleted === 0 && gc.objectsDeleted === 0) {
          return {
            message: color.dim(
              `No unreferenced checkpoints older than ${ageDays} day${ageDays === 1 ? '' : 's'} ` +
                `(${gc.manifestsScanned} manifest${gc.manifestsScanned === 1 ? '' : 's'}, ` +
                `${gc.objectsScanned} object${gc.objectsScanned === 1 ? '' : 's'} checked).`,
            ),
          };
        }
        const mib = (gc.bytesReclaimed / (1024 * 1024)).toFixed(1);
        const lines = [
          `Reclaimed ${color.green(`${mib} MiB`)} from the checkpoint store: ` +
            `${color.cyan(String(gc.manifestsDeleted))}/${gc.manifestsScanned} manifests and ` +
            `${color.cyan(String(gc.objectsDeleted))}/${gc.objectsScanned} objects.`,
        ];
        if (gc.errors.length > 0) {
          lines.push(
            color.dim(
              `${gc.errors.length} item${gc.errors.length === 1 ? '' : 's'} were kept because they could not be read.`,
            ),
          );
        }
        return { message: lines.join('\n') };
      }

      if (rebuildIndex) {
        if (!opts.sessionStore?.rebuildIndex) {
          return {
            message: color.yellow('Session store does not support index rebuild.'),
          };
        }
        const count = await opts.sessionStore.rebuildIndex();
        return {
          message:
            count === 0
              ? color.dim('No sessions found to index.')
              : `Session index rebuilt: ${color.green(String(count))} session${count === 1 ? '' : 's'} indexed.`,
        };
      }

      const maxAgeDays = parseMaxAgeDays(parts);

      if (dryRun) {
        if (!opts.sessionStore) {
          return { message: color.yellow('No session store configured.') };
        }
        // For dry-run, list sessions that would be pruned.
        const cutoff = Date.now() - maxAgeDays * 86_400_000;
        const list = await opts.sessionStore.list(1000);
        const stale = list.filter((s) => new Date(s.startedAt).getTime() < cutoff);
        if (stale.length === 0) {
          return {
            message: color.dim(
              `No sessions older than ${maxAgeDays} day${maxAgeDays === 1 ? '' : 's'}.`,
            ),
          };
        }
        const lines = stale.map(
          (s) => `  ${color.dim(s.id)}  ${color.dim(s.startedAt.slice(0, 10))}  ${s.title}`,
        );
        return {
          message: [
            color.bold(
              `Would delete ${stale.length} session${stale.length === 1 ? '' : 's'} (dry run, maxAge=${maxAgeDays}d):`,
            ),
            ...lines,
            '',
            color.dim('Run /prune without --dry-run to actually delete.'),
          ].join('\n'),
        };
      }

      if (!opts.sessionStore) {
        return { message: color.yellow('No session store configured.') };
      }
      const deleted = await opts.sessionStore.prune(maxAgeDays);
      if (deleted === 0) {
        return {
          message: color.dim(
            `No sessions older than ${maxAgeDays} day${maxAgeDays === 1 ? '' : 's'}.`,
          ),
        };
      }
      return {
        message: `Pruned ${color.green(String(deleted))} session${deleted === 1 ? '' : 's'} older than ${color.cyan(String(maxAgeDays))} day${maxAgeDays === 1 ? '' : 's'}.`,
      };
    },
  };
}
