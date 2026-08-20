import { describe, expect, it } from 'vitest';
import { subjectForToolInput } from '../../src/utils/tool-subject.js';

/**
 * Regression for the over-broad `git` trust subject found by the 2026-08-20
 * security-check audit.
 *
 * A shell tool's subject is its whole command line, so a trust rule is as
 * specific as the invocation. `git` has no argv array — its parameters are
 * named fields — and `subjectKey: 'command'` yields an enum subcommand. Every
 * `git push`, to any branch, with or without `force`, therefore rendered to the
 * subject `"push"`, and a single "always allow" covered all of them.
 */

const GIT_FIELDS = ['branch', 'force', 'worktreeAction', 'worktreePath', 'newBranch'] as const;

const subject = (input: Record<string, unknown>) =>
  subjectForToolInput('git', input, 'command', GIT_FIELDS);

describe('git subjects distinguish invocations that differ in effect', () => {
  it('separates a force push from an ordinary one', () => {
    const plain = subject({ command: 'push', branch: 'main' });
    const forced = subject({ command: 'push', branch: 'main', force: true });

    expect(plain).not.toBe(forced);
    expect(forced).toContain('force=true');
  });

  it('separates pushes to different branches', () => {
    expect(subject({ command: 'push', branch: 'main' })).not.toBe(
      subject({ command: 'push', branch: 'release' }),
    );
  });

  it('separates worktree add from worktree remove', () => {
    expect(subject({ command: 'worktree', worktreeAction: 'add', worktreePath: '../wt' })).not.toBe(
      subject({ command: 'worktree', worktreeAction: 'remove', worktreePath: '../wt' }),
    );
  });

  it('keeps a bare subcommand short when no extra field is supplied', () => {
    // The common case must stay readable — the prompt shows this string.
    expect(subject({ command: 'status' })).toBe('status');
  });

  it('omits false and empty fields rather than rendering them', () => {
    expect(subject({ command: 'push', branch: '', force: false })).toBe('push');
  });

  it('still separates a dry-run commit from a real one', () => {
    const dry = subject({ command: 'commit', message: 'x', dry_run: true });
    const real = subject({ command: 'commit', message: 'x' });

    expect(dry).not.toBe(real);
    expect(dry).toMatch(/dry-run$/);
  });
});

describe('tools without subjectFields are unaffected', () => {
  it('renders a bash command line exactly as before', () => {
    expect(subjectForToolInput('bash', { command: 'git status' }, 'command')).toBe('git status');
  });

  it('renders an exec command with its args as before', () => {
    expect(subjectForToolInput('exec', { command: 'node', args: ['-e', 'x'] }, 'command')).toBe(
      'node -e x',
    );
  });
});
