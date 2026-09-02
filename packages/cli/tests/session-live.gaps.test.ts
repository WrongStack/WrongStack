import * as path from 'node:path';
import { stripAnsi } from '@wrongstack/core/utils';
import { describe, expect, it, vi } from 'vitest';
import { buildLoadCommand } from '../src/slash-commands/session.js';

function makeOpts(extra: Record<string, unknown> = {}) {
  return {
    context: { session: { id: 'current-session' } },
    paths: { projectSessions: path.join(process.env['WRONGSTACK_HOME'] ?? '.', 'sessions') },
    sessionStore: {
      list: vi.fn(async () => []),
      rename: vi.fn(async (id: string) => ({ id, title: 'Auto Title' })),
      delete: vi.fn(async () => undefined),
    },
    ...extra,
  } as never;
}

describe('/sessions rename and delete guards', () => {
  it('requires a session id and a configured store for renames', async () => {
    const cmd = buildLoadCommand(makeOpts());
    expect(stripAnsi((await cmd.run('rename'))?.message ?? '')).toContain(
      'Usage: /sessions rename <sessionId>',
    );

    const noStore = buildLoadCommand(makeOpts({ sessionStore: undefined }));
    expect(stripAnsi((await noStore.run('rename s1 Name'))?.message ?? '')).toContain(
      'No session store configured.',
    );
  });

  it('renames and clears names', async () => {
    const cmd = buildLoadCommand(makeOpts());
    const renamed = await cmd.run('rename s1 Fresh Name');
    expect(stripAnsi(renamed?.message ?? '')).toContain('Renamed s1 → "Fresh Name"');

    const cleared = await cmd.run('rename s1');
    expect(stripAnsi(cleared?.message ?? '')).toContain('Cleared name on s1');
  });

  it('surfaces rename failures', async () => {
    const cmd = buildLoadCommand(
      makeOpts({
        sessionStore: {
          rename: vi.fn(async () => {
            throw new Error('locked');
          }),
        },
      }),
    );
    const out = await cmd.run('rename s1 x');
    expect(stripAnsi(out?.message ?? '')).toContain('Rename failed: locked');
  });

  it('protects the active session from deletion', async () => {
    const out = await buildLoadCommand(makeOpts()).run('delete current-session');
    expect(stripAnsi(out?.message ?? '')).toContain('Cannot delete the active session');
  });

  it('prints delete usage and requires a store', async () => {
    const cmd = buildLoadCommand(makeOpts());
    expect(stripAnsi((await cmd.run('delete'))?.message ?? '')).toContain(
      'Usage: /sessions delete <sessionId>',
    );

    const noStore = buildLoadCommand(makeOpts({ sessionStore: undefined }));
    expect(stripAnsi((await noStore.run('delete s1'))?.message ?? '')).toContain(
      'No session store configured.',
    );
  });

  it('honours a declined delete confirmation', async () => {
    const out = await buildLoadCommand(makeOpts({ confirm: vi.fn(async () => false) })).run(
      'delete other-session',
    );
    expect(stripAnsi(out?.message ?? '')).toContain('Delete cancelled.');
  });

  it('deletes sessions after confirmation and reports failures', async () => {
    const ok = await buildLoadCommand(makeOpts({ confirm: vi.fn(async () => true) })).run(
      'delete doomed',
    );
    expect(stripAnsi(ok?.message ?? '')).toContain('Deleted session doomed');

    const failing = await buildLoadCommand(
      makeOpts({
        confirm: vi.fn(async () => true),
        sessionStore: {
          delete: vi.fn(async () => {
            throw new Error('in use');
          }),
        },
      }),
    ).run('delete doomed');
    expect(stripAnsi(failing?.message ?? '')).toContain('Delete failed: in use');
  });
});

describe('/sessions recovery plans', () => {
  it('reports when no session log exists for the recovery target', async () => {
    const out = await buildLoadCommand(makeOpts()).run('--recover missing-id');
    expect(stripAnsi(out?.message ?? '')).toContain(
      'No session log found for missing-id (or it is empty).',
    );
  });

  it('requires configured paths for recovery plans', async () => {
    const out = await buildLoadCommand(makeOpts({ paths: undefined })).run('--recover x');
    expect(stripAnsi(out?.message ?? '')).toContain('No paths configured');
  });
});
