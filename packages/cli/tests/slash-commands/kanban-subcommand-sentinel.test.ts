/**
 * Sentinel — every `/kanban ...` reference embedded in diagnostic messages
 * and Usage strings must point to a real subcommand. Designed to catch the
 * `review-evidence-missing` reference that used to send users to a
 * nonexistent `/kanban verify` instead of a real action.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SLASH_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src/slash-commands',
);

async function loadKanbanSource(): Promise<string> {
  const files = await fs.readdir(SLASH_DIR);
  const kanbanFiles = files.filter((f) => f.startsWith('kanban') && f.endsWith('.ts'));
  const contents = await Promise.all(
    kanbanFiles.map((f) => fs.readFile(path.join(SLASH_DIR, f), 'utf8')),
  );
  return contents.join('\n\n');
}

const TOP_LEVEL_SUBSUB = new Set([
  'task',
  'board',
  'graph',
  'column',
  'list',
  'ls',
  'show',
  'add',
  'move',
  'done',
  'block',
  'remove',
  'rm',
  'delete',
  'release',
  'split',
  'merge',
  'chain',
  'copy',
  'transfer',
  'move-board',
  'priority',
  'prio',
  'assign',
  'agent',
  'dispatch',
  'run',
  'depend',
  'dep',
  'metric',
  'note',
  'check',
  'ready',
  'claim',
  'export',
  'import',
  'sync',
  'prune',
  'create',
  'duplicate',
  'rename',
  'deps',
  'generate',
  'view',
  'archive',
  'help',
  'verify',
  'repair',
  'audit',
  'recover',
  'lanes',
  'centroid',
  'sequence',
  'memory',
  'queue',
  'health',
  'worktree',
  'tools',
  'skill',
  'session',
  'exit',
  'quit',
]);

const TASK_SUB = new Set([
  'show',
  'add',
  'move',
  'done',
  'block',
  'remove',
  'release',
  'split',
  'merge',
  'chain',
  'copy',
  'transfer',
  'priority',
  'assign',
  'dispatch',
  'depend',
  'metric',
  'note',
  'check',
  'claim',
  'verify',
  'repair',
  'update',
  'split-atomic',
  'decompose',
  'audit',
  'run',
]);

const PLACEHOLDER_COMMANDS = new Set([
  'verify_completion',
  'update_task',
  'repair_managed_task_projection',
  'split_atomic',
  'decompose',
  'audit',
  'run',
  'release',
  'assign',
  'move',
  'add',
  'done',
  'note',
  'check',
]);

const ALIASED_REDIRECTS = new Set([
  // Subcommands that are intentionally *not* dispatched against the user's
  // first token because the slash command treats them as inline attachments:
  // they must reuse the dispatch path the user already invoked.
  'verify',
  'repair',
  'update',
  'split-atomic',
]);

describe('kanban slash subcommand sentinel', () => {
  it('every /kanban <X> reference in kanban.ts points to a real subcommand', async () => {
    const source = await loadKanbanSource();

    // Backticks template and 'string' literals both interpolated
    const matches = Array.from(
      source.matchAll(/[`'"](\/kanban)\s+([a-z][a-z0-9-]*)(\s+([a-z][a-z0-9-]*))?/g),
    );

    const unknown: string[] = [];
    for (const match of matches) {
      const word1 = match[2];
      const word2 = match[4];
      if (!word1) throw new Error('kanban command regex returned an empty command capture');
      if (!TOP_LEVEL_SUBSUB.has(word1)) {
        unknown.push(`/${word1}${word2 ? ` ${word2}` : ''}`);
        continue;
      }
      if (word1 === 'task' && word2 && !TASK_SUB.has(word2)) {
        unknown.push(`/kanban task ${word2}`);
      }
    }

    expect(unknown, `unknown subcommand references: ${unknown.join(', ')}`).toEqual([]);
  });

  it('no aliased command shows a placeholder-only message without a working fallback', async () => {
    const source = await loadKanbanSource();
    for (const cmd of ALIASED_REDIRECTS) {
      // The diagnostic must mention a real workflow, not only a tool action.
      if (source.includes(`/kanban ${cmd}`)) {
        const nearby = extractNearby(source, cmd);
        const hasFallback = Array.from(PLACEHOLDER_COMMANDS).some((p) => nearby.includes(p));
        expect(
          hasFallback,
          `diagnostic for /kanban ${cmd} must include a concrete fallback command`,
        ).toBe(true);
      }
    }
  });

  it('task done diagnostics reference only real subcommands (move, assign, dispatch, verify_completion)', async () => {
    const source = await loadKanbanSource();

    // Slice out the `task done` handler body so the sentinel stays scoped
    // to the section that produces `/kanban task done` diagnostics — without
    // this carve-out the regex catches unrelated references in other handlers.
    // The handler uses `if (sub === 'done')` inside the task subcommand router.
    const startMarker = "if (sub === 'done')";
    const start = source.indexOf(startMarker);
    if (start < 0) {
      throw new Error(
        'sentinel expected to find the task done handler marker in kanban.ts — recheck the carve-out',
      );
    }
    // Walk forward until the next top-level `if (sub === '<something>')`
    // boundary so we don't leak into the next task-handler block.
    const boundary = source.slice(start + startMarker.length).search(/if \(sub === '[a-z]/);
    const end = boundary < 0 ? source.length : start + startMarker.length + boundary;
    const handler = source.slice(start, end);

    const references = Array.from(
      handler.matchAll(/[`'"](\/kanban)\s+([a-z][a-z0-9-]*)(?:\s+([a-z][a-z0-9-]*))?/g),
    ).map((m) => `/${m[2]}${m[3] ? ` ${m[3]}` : ''}`);

    const unknown = references.filter(
      (ref) =>
        !TOP_LEVEL_SUBSUB.has(ref.split(' ')[1] ?? '') &&
        !PLACEHOLDER_COMMANDS.has(ref.split(' ')[1] ?? ''),
    );
    expect(
      unknown,
      `task done handler references unknown subcommands: ${unknown.join(', ')}`,
    ).toEqual([]);

    // The diagnostic must point the user at a real workflow, not a dead end.
    // Preflight issues must mention at least one of: move, assign, dispatch,
    // verify_completion, or attach. If a future change removes every pointer,
    // the user is left without a recovery path.
    const recoveryTokens = [
      '/kanban task move',
      '/kanban task assign',
      '/kanban task dispatch',
      'verify_completion',
      '--attachment',
      'kanban.update_task',
    ];
    const hasRecovery = recoveryTokens.some((token) => handler.includes(token));
    expect(
      hasRecovery,
      'task done diagnostics must include at least one recovery pointer (move/assign/dispatch/verify_completion/--attachment/kanban.update_task)',
    ).toBe(true);
  });
});

function extractNearby(source: string, token: string): string {
  const idx = source.indexOf(`/kanban ${token}`);
  if (idx < 0) return '';
  const start = Math.max(0, idx - 200);
  const end = Math.min(source.length, idx + 400);
  return source.slice(start, end);
}
