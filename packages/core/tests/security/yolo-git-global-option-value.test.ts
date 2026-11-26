import { describe, expect, it } from 'vitest';
import { classifyDestructiveCommand } from '../../src/security/yolo-risk.js';

/**
 * The subcommand-keyed git rules skip global options to find the real
 * subcommand, but only `-c`/`-C` consumed a separate value. Git also accepts
 * `--git-dir <path>`, `--work-tree <path>`, `--namespace <ns>`,
 * `--config-env <name>=<var>` and `--super-prefix <path>` with the value as
 * the next word, so that value was read as the subcommand and
 * `git --work-tree . checkout -- src` (discards local edits) was never gated.
 */
describe('git global options with a separate value do not hide the subcommand', () => {
  const ROOT = 'C:\\projects\\demo';

  it.each([
    'git --work-tree . checkout -- src',
    'git --git-dir .git stash drop',
    'git --namespace ns restore src/app.ts',
    'git --config-env core.x=X --work-tree . checkout .',
    'git --git-dir .git branch -D feature',
    'git --attr-source HEAD checkout -- src',
    'git --attr-source HEAD branch -D feature',
  ])('gates `%s`', (cmd) => {
    expect(classifyDestructiveCommand(cmd, ROOT)).toBe('git-history');
  });

  it('the same global options before a harmless subcommand stay ungated', () => {
    expect(
      classifyDestructiveCommand('git --git-dir .git --work-tree . status', ROOT),
    ).toBeUndefined();
    expect(classifyDestructiveCommand('git --git-dir .git branch feature', ROOT)).toBeUndefined();
  });
});
