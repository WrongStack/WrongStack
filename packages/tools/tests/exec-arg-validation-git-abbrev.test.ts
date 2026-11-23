import { describe, expect, it } from 'vitest';
import { validateArgs } from '../src/exec-arg-validation.js';

/**
 * git's `parse-options` accepts any unambiguous long-option prefix, so
 * `--upload-p` runs exactly what `--upload-pack` runs. The name table in
 * `BLOCKED_OPTION_NAMES` exists to close every spelling of an option that runs
 * an arbitrary command — abbreviated spellings included.
 *
 * Verified against git 2.56.1.windows.1: `fetch --upl=<cmd>`,
 * `fetch --upload-p=<cmd>`, `push --receive-p=<cmd>` and `push --exe=<cmd>` all
 * executed the named command, so these are the same capability, not unknown
 * options.
 */
describe('validateArgs git long-option abbreviations', () => {
  it('refuses abbreviated transport hooks git resolves to a blocked option', () => {
    expect(validateArgs('git', ['fetch', '--upload-p=/tmp/hook.sh'])).not.toBeNull();
    expect(validateArgs('git', ['fetch', '--upload-p', '/tmp/hook.sh'])).not.toBeNull();
    expect(validateArgs('git', ['fetch', '--upl=/tmp/hook.sh'])).not.toBeNull();
    expect(validateArgs('git', ['push', '--receive-p=/tmp/hook.sh', 'origin'])).not.toBeNull();
    expect(validateArgs('git', ['push', '--receive-p', '/tmp/hook.sh', 'origin'])).not.toBeNull();
    expect(validateArgs('git', ['push', '--exe=/tmp/hook.sh', 'origin'])).not.toBeNull();
  });

  it('refuses a prefix of a blocked global option rather than trusting its spelling', () => {
    // Modern git rejects these two today; a parser that accepts them must not
    // find the guard asleep, so the prefix is refused (fail closed).
    expect(validateArgs('git', ['status', '--exec-p=/tmp/x'])).not.toBeNull();
    expect(validateArgs('git', ['status', '--git-d=/tmp/x'])).not.toBeNull();
  });

  it('keeps ordinary git commands allowed', () => {
    expect(validateArgs('git', ['status', '--short'])).toBeNull();
    expect(validateArgs('git', ['log', '--oneline', '-5'])).toBeNull();
    expect(validateArgs('git', ['fetch', 'origin'])).toBeNull();
    expect(validateArgs('git', ['push', 'origin', 'HEAD:refs/heads/topic'])).toBeNull();
    // After `--` the operand is a pathspec, not an option (F938 contract).
    expect(validateArgs('git', ['status', '--', '--exec=file.txt'])).toBeNull();
  });

  it('does not extend the abbreviation rule to short options', () => {
    // find's `-o` is the OR operator and a prefix of the blocked `-ok`/`-okdir`
    // primaries; only long options have an abbreviation syntax.
    expect(validateArgs('find', ['.', '-name', 'a.ts', '-o', '-name', 'b.ts'])).toBeNull();
    expect(validateArgs('find', ['.', '-exec', 'sh', '-c', 'id', ';'])).not.toBeNull();
    expect(validateArgs('find', ['.', '-ok', 'rm', '{}', ';'])).not.toBeNull();
  });
});
