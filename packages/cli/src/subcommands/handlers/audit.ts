import { ToolAuditLog } from '@wrongstack/core/storage';
import { color, resolveWstackPaths } from '@wrongstack/core/utils';
import type { SubcommandHandler } from '../contracts.js';
import { restoreFlags } from '../flags.js';

/**
 * `wstack audit <sessionId>` — inspect a session's tamper-evident
 * tool audit log. Shows the chained hash entries and runs
 * `ToolAuditLog.verify()` to surface any post-hoc modifications.
 *
 * Subcommands:
 *   - `wstack audit <sessionId>`  — show entries + verify
 *   - `wstack audit --list`       — list all sessions with audit logs
 */
export const auditCmd: SubcommandHandler = async (args, deps) => {
  args = restoreFlags(args, deps, ['list', 'l']);
  const wpaths = resolveWstackPaths({
    projectRoot: deps.projectRoot,
    userHome: deps.userHome,
  });
  const log = new ToolAuditLog({ dir: wpaths.projectSessions });

  if (args[0] === '--list' || args[0] === '-l') {
    return listAudits(log, wpaths.projectSessions, deps);
  }

  const sessionId = args[0];
  if (!sessionId) {
    deps.renderer.writeError(
      'Usage: wstack audit <sessionId>\n' +
        '       wstack audit --list\n\n' +
        "Inspects a session's tamper-evident tool audit log. Each entry\n" +
        'is chained to the previous via SHA-256; any post-hoc modification\n' +
        'breaks the chain. Use this to verify a session was not tampered\n' +
        'with after recording.\n',
    );
    return 1;
  }

  const entries = await log.load(sessionId);
  if (entries.length === 0) {
    deps.renderer.write(
      color.yellow(
        `No audit entries for session ${sessionId}. ` +
          `(The audit log is written when tools are recorded — check that the session ran with audit enabled.)`,
      ) + '\n',
    );
    return 0;
  }
  const verify = await log.verify(sessionId);
  const lines: string[] = [
    color.bold(`Audit log for ${sessionId}`),
    verify.ok
      ? `  ${color.green('✓ Verified')}  ${entries.length} entries, chain intact`
      : `  ${color.red('✗ BROKEN')}  at entry ${(verify as { brokenAt: number }).brokenAt}: ${(verify as { reason: string }).reason}`,
    '',
    '  Entries (oldest first):',
  ];
  const cap = 12;
  for (const e of entries.slice(0, cap)) {
    const t = color.dim(e.ts.slice(11, 19));
    const idx = color.dim(`#${e.index}`.padStart(4));
    const tool = e.toolName;
    const err = e.isError ? color.red('(error)') : '';
    lines.push(
      `    ${t}  ${idx}  ${color.cyan(tool.padEnd(14))} ${err}  ${color.dim(e.hash.slice(0, 12) + '…')}`,
    );
  }
  if (entries.length > cap) {
    lines.push(color.dim(`    … and ${entries.length - cap} more`));
  }
  deps.renderer.write(lines.join('\n') + '\n');
  return verify.ok ? 0 : 1;
};

async function listAudits(
  log: ToolAuditLog,
  dir: string,
  deps: import('../index.js').SubcommandDeps,
): Promise<number> {
  // Sidecar files end in .audit.jsonl. They sit next to their session
  // JSONL — flat at the root for legacy ids, inside a date-shard dir for
  // modern ids ("2026-06-11/<base>.audit.jsonl"). Scan both levels.
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const out: Array<{ sessionId: string; entryCount: number; ok: boolean }> = [];
  let foundRoot = true;
  const scan = async (scanDir: string, prefix: string, depth: number): Promise<void> => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(scanDir, { withFileTypes: true });
    } catch {
      if (depth === 0) foundRoot = false;
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory()) {
        if (depth === 0) await scan(path.join(scanDir, entry.name), entry.name, depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.audit.jsonl')) continue;
      const base = entry.name.slice(0, -'.audit.jsonl'.length);
      const sessionId = prefix ? `${prefix}/${base}` : base;
      const all = await log.load(sessionId);
      const verify = await log.verify(sessionId);
      out.push({ sessionId, entryCount: all.length, ok: verify.ok });
    }
  };
  await scan(dir, '', 0);
  if (!foundRoot) {
    deps.renderer.write(color.dim(`No sessions dir found at ${dir}. Run a session first.`) + '\n');
    return 0;
  }
  out.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  if (out.length === 0) {
    deps.renderer.write(color.dim('No audit logs recorded yet.') + '\n');
    return 0;
  }
  const lines: string[] = [color.bold(`${out.length} audit log(s)`), ''];
  for (const r of out) {
    const status = r.ok ? color.green('✓ intact') : color.red('✗ broken');
    lines.push(`  ${color.cyan(r.sessionId)}  ${color.dim(`${r.entryCount} entries`)}  ${status}`);
  }
  deps.renderer.write(lines.join('\n') + '\n');
  return 0;
}
