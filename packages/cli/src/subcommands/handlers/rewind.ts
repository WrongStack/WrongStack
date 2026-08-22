import {
  DefaultSessionRewinder,
  DefaultSessionStore,
  type MaintenanceLease,
  SessionCatalogProjectClient,
} from '@wrongstack/core/storage';
import { color, expectDefined, resolveWstackPaths, toErrorMessage } from '@wrongstack/core/utils';
import type { SubcommandHandler } from '../contracts.js';
import { restoreFlags } from '../flags.js';

interface RewindFlags {
  all?: boolean | undefined;
  last?: string | undefined;
  to?: string | undefined;
  list?: boolean | undefined;
  resume?: boolean | undefined;
}

function parseRewindFlags(args: string[]): RewindFlags {
  const flags: RewindFlags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--all') flags.all = true;
    else if (a === '--last') flags.last = args[++i] ?? '1';
    else if (a === '--to') flags.to = args[++i] ?? '';
    else if (a === '--list') flags.list = true;
    else if (a === '--resume') flags.resume = true;
  }
  return flags;
}

/**
 * Find the session-id positional, skipping over flag values (`--last 2`
 * must NOT pick up "2" as the session id). Mirrors the flag-consumption
 * shape of parseRewindFlags so the two stay in sync.
 */
function findSessionId(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = expectDefined(args[i]);
    if (a === '--last' || a === '--to') {
      i++; // skip the next token (the flag's value)
      continue;
    }
    if (!a.startsWith('--')) return a;
  }
  return undefined;
}

export const rewindCmd: SubcommandHandler = async (args, deps) => {
  // `parseArgs` strips these before the dispatcher calls us — see restoreFlags.
  args = restoreFlags(args, deps, ['all', 'last', 'to', 'list', 'resume']);
  const flags = parseRewindFlags(args);

  // Sessions are project-scoped under ~/.wrongstack/projects/<slug>/sessions.
  // The legacy globalRoot/sessions path misses every modern date-sharded log.
  const wpaths = resolveWstackPaths({ projectRoot: deps.projectRoot });
  const sessionsDir = wpaths.projectSessions;

  const rewind = new DefaultSessionRewinder(sessionsDir, deps.projectRoot);

  // Get session ID — explicit positional wins; fall back to latest session.
  let sessionId = findSessionId(args);
  if (!sessionId) {
    if (!deps.sessionStore) {
      deps.renderer.writeError('No session store available.');
      return 1;
    }
    const sessions = await deps.sessionStore.list(1);
    if (sessions.length === 0) {
      deps.renderer.writeError('No sessions found.');
      return 1;
    }
    sessionId = sessions[0]?.id;
  }
  if (!sessionId) {
    deps.renderer.writeError('No sessions found.');
    return 1;
  }
  const targetSessionId = sessionId;

  // List checkpoints
  if (flags.list) {
    deps.renderer.write(`Session: ${color.bold(targetSessionId)}\n\n`);
    const checkpoints = await rewind.listCheckpoints(targetSessionId);
    if (checkpoints.length === 0) {
      deps.renderer.write('No checkpoints in this session.\n');
      return 0;
    }
    for (const cp of checkpoints) {
      deps.renderer.write(
        `  [${cp.promptIndex}] ${color.dim(cp.ts)}  ${cp.promptPreview}${cp.fileCount > 0 ? color.dim(` (${cp.fileCount} file${cp.fileCount === 1 ? '' : 's'})`) : ''}\n`,
      );
    }
    return 0;
  }

  let maintenance: { client: SessionCatalogProjectClient; lease: MaintenanceLease } | undefined;
  const claimForHistoryMutation = async (): Promise<void> => {
    if (!flags.resume) return;
    const client = new SessionCatalogProjectClient({
      projectDir: wpaths.projectDir,
      projectRoot: deps.projectRoot,
    });
    const lease = await client.call('acquire_maintenance', {
      sessionId: targetSessionId,
      operation: 'rewind',
      holderId: `rewind:${process.pid}`,
    });
    maintenance = { client, lease };
  };

  // Perform rewind
  try {
    let result;
    if (flags.all) {
      await claimForHistoryMutation();
      deps.renderer.write('Rewinding to session start...\n');
      result = await rewind.rewindToStart(targetSessionId);
    } else if (flags.last) {
      const n = Number.parseInt(flags.last, 10);
      if (Number.isNaN(n) || n < 1) {
        deps.renderer.writeError('--last requires a positive number');
        return 1;
      }
      await claimForHistoryMutation();
      deps.renderer.write(`Rewinding last ${n} prompt(s)...\n`);
      result = await rewind.rewindLastN(targetSessionId, n);
    } else if (flags.to) {
      const idx = Number.parseInt(flags.to, 10);
      if (Number.isNaN(idx) || idx < 0) {
        deps.renderer.writeError('--to requires a non-negative number');
        return 1;
      }
      await claimForHistoryMutation();
      deps.renderer.write(`Rewinding to checkpoint ${idx}...\n`);
      result = await rewind.rewindToCheckpoint(targetSessionId, idx);
    } else {
      deps.renderer.write('Usage: ws rewind --all | --last N | --to <index> [--list] [--resume]\n');
      deps.renderer.write('  --all      Rewind to session start\n');
      deps.renderer.write('  --last N   Rewind last N prompts\n');
      deps.renderer.write('  --to N     Rewind to checkpoint N\n');
      deps.renderer.write('  --list     List checkpoints\n');
      deps.renderer.write('  --resume   After rewind, truncate session history at checkpoint\n');
      return 1;
    }

    if (result.revertedFiles.length === 0) {
      deps.renderer.write('No files to revert.\n');
      if (flags.resume) {
        // Still truncate even if no files changed
        const store = new DefaultSessionStore({ dir: sessionsDir, projectRoot: deps.projectRoot });
        const resumed = await store.resume(targetSessionId);
        const toIdx = result.toPromptIndex;
        await resumed.writer.truncateToCheckpoint(toIdx);
        await resumed.writer.close();
        deps.renderer.write(`  ${color.green('✓')} Session truncated at checkpoint ${toIdx}\n`);
      }
      return 0;
    }

    deps.renderer.write(`\nReverted ${result.revertedFiles.length} file(s):\n`);
    for (const f of result.revertedFiles) {
      deps.renderer.write(`  ${color.green('✓')} ${f}\n`);
    }

    if (flags.resume) {
      const store = new DefaultSessionStore({ dir: sessionsDir, projectRoot: deps.projectRoot });
      const resumed = await store.resume(targetSessionId);
      const toIdx = result.toPromptIndex;
      const removed = await resumed.writer.truncateToCheckpoint(toIdx);
      await resumed.writer.close();
      deps.renderer.write(
        `\n  ${color.green('✓')} Session truncated — ${removed} event(s) removed\n`,
      );
    } else {
      // Files moved back but the conversation did not. Resuming this session
      // replays a history that describes edits no longer on disk, and the model
      // will act on them. Say so rather than reporting a clean success.
      deps.renderer.write(
        `\n  ${color.yellow('!')} Conversation history left intact — it still describes the reverted edits.\n` +
          `    Re-run with --resume to truncate it at checkpoint ${result.toPromptIndex}.\n`,
      );
    }

    if (result.errors.length > 0) {
      deps.renderer.write(`\n${result.errors.length} error(s):\n`);
      for (const e of result.errors) {
        deps.renderer.write(`  ${color.red('✗')} ${e}\n`);
      }
      return 1;
    }
    return 0;
  } catch (err) {
    deps.renderer.writeError(toErrorMessage(err));
    return 1;
  } finally {
    if (maintenance) {
      await maintenance.client
        .call('release_maintenance', { lease: maintenance.lease })
        .catch(() => undefined);
      await maintenance.client.close().catch(() => undefined);
    }
  }
};
