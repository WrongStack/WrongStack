import { ReplayLogStore } from '@wrongstack/core/storage';
import { color, resolveWstackPaths } from '@wrongstack/core/utils';
import type { SubcommandHandler } from '../contracts.js';
import { restoreFlags } from '../flags.js';

/**
 * `wstack replay <sessionId>` — convenience wrapper around
 * `wstack --replay <sessionId>`. Lists the recorded entries for
 * the session and shows a hint for the user to re-run with
 * the actual replay flag. Keeps the flag-based path canonical
 * (so the boot container wiring stays simple) while exposing
 * a discoverable subcommand for users who type `wstack replay`
 * expecting it to exist.
 */
export const replayCmd: SubcommandHandler = async (args, deps) => {
  args = restoreFlags(args, deps, ['list', 'l']);
  const wpaths = resolveWstackPaths({
    projectRoot: deps.projectRoot,
    userHome: deps.userHome,
  });
  const store = new ReplayLogStore({ dir: wpaths.projectSessions });

  // `wstack replay --list` — show every session that has a replay log.
  if (args[0] === '--list' || args[0] === '-l') {
    const all = await store.list();
    if (all.length === 0) {
      deps.renderer.write(
        color.dim('No replay logs recorded yet. Run with --record to start one.') + '\n',
      );
      return 0;
    }
    const lines: string[] = [
      color.bold(`${all.length} replay log(s)`),
      color.dim('  Sorted by session id. Each entry has at least one recorded request/response.'),
      '',
    ];
    for (const r of all) {
      lines.push(
        `  ${color.cyan(r.sessionId)}  ${color.dim(`${r.entryCount} entries`)}  ${color.dim(r.path)}`,
      );
    }
    lines.push('');
    lines.push(color.dim('  Inspect:  wstack replay <sessionId>'));
    lines.push(color.dim('  Replay:   wstack --replay <sessionId>'));
    deps.renderer.write(lines.join('\n') + '\n');
    return 0;
  }

  const sessionId = args[0];
  if (!sessionId) {
    deps.renderer.writeError(
      'Usage: wstack replay <sessionId>\n' +
        '       wstack replay --list\n\n' +
        'Lists recorded provider responses for the session. To actually\n' +
        're-run the agent with frozen responses, use:\n' +
        '  wstack --replay ' +
        color.cyan('<sessionId>') +
        '\n' +
        '  wstack --record                   # start a fresh recording\n',
    );
    return 1;
  }
  const entries = await store.load(sessionId);
  if (entries.length === 0) {
    deps.renderer.write(
      color.yellow(
        `No replay entries recorded for session ${sessionId}.\n` +
          `Run a session with --record first, then --replay to re-execute it.`,
      ) + '\n',
    );
    return 0;
  }
  const lines: string[] = [
    color.bold(`Replay log for ${sessionId}`),
    `  ${entries.length} recorded request/response pair(s)`,
    `  Log file: ${color.dim(`${sessionId}.replay.jsonl`)}`,
    '',
    'To replay this session deterministically:',
    `  ${color.cyan(`wstack --replay ${sessionId}`)}`,
    '',
    'Recorded timestamps (oldest first):',
  ];
  for (const e of entries.slice(-10)) {
    lines.push(`  ${color.dim(e.ts.slice(11, 19))}  ${e.hash.slice(0, 16)}…  ${e.request.model}`);
  }
  if (entries.length > 10) {
    lines.push(color.dim(`  … and ${entries.length - 10} more`));
  }
  deps.renderer.write(lines.join('\n') + '\n');
  return 0;
};
