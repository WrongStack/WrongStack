import { ToolExecutor } from '@wrongstack/core/execution';
import { HookRegistry, HookRunner } from '@wrongstack/core/hooks';
import type { Tool, ToolResultBlock } from '@wrongstack/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const pathGuardPlugin = (await import('../src/path-guard/index.js')).default;
const { compilePathGlob, destructiveTargets, isSymlinkEscape } = await import(
  '../src/path-guard/index.js'
);

interface MockApi {
  tools: { register: ReturnType<typeof vi.fn> };
  config: { extensions: Record<string, unknown> };
  log: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  metrics: {
    counter: ReturnType<typeof vi.fn>;
    histogram: ReturnType<typeof vi.fn>;
    gauge: ReturnType<typeof vi.fn>;
  };
  registerHook: ReturnType<typeof vi.fn>;
}

function makeApi(overrides: { extensions?: Record<string, unknown> } = {}): MockApi {
  return {
    tools: { register: vi.fn() },
    config: { extensions: overrides.extensions ?? {} },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { counter: vi.fn(), histogram: vi.fn(), gauge: vi.fn() },
    registerHook: vi.fn(() => vi.fn()),
  };
}

type HookResult = { decision?: string; reason?: string; additionalContext?: string } | undefined;

function getHook(api: MockApi): (input: unknown) => Promise<HookResult> {
  const call = api.registerHook.mock.calls[0];
  if (!call) throw new Error('hook not registered');
  return (call as unknown[])[2] as (input: unknown) => Promise<HookResult>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('compilePathGlob', () => {
  it('matches basenames at any depth', async () => {
    const re = compilePathGlob('.env');
    expect(re.test('.env')).toBe(true);
    expect(re.test('sub/dir/.env')).toBe(true);
    expect(re.test('.envrc')).toBe(false);
  });

  it('supports * within a segment and ** across whole segments', async () => {
    expect(compilePathGlob('.env.*').test('.env.local')).toBe(true);
    expect(compilePathGlob('**/migrations/**').test('db/migrations/001.sql')).toBe(true);
    expect(compilePathGlob('**/migrations/**').test('migrations')).toBe(true);
    expect(compilePathGlob('**/migrations/**').test('db/migrations')).toBe(true);
    expect(compilePathGlob('**/migrations/**').test('my-migrations/001.sql')).toBe(false);
    expect(compilePathGlob('**/migrations/**').test('db-migrations/x')).toBe(false);
    expect(compilePathGlob('.git/**').test('.git')).toBe(true);
    expect(compilePathGlob('.git/**').test('.git/HEAD')).toBe(true);
    expect(compilePathGlob('.git/**').test('repo/.git/config')).toBe(true);
  });
});

describe('destructiveTargets', () => {
  it('extracts rm and redirect targets', async () => {
    expect(destructiveTargets('rm -rf pnpm-lock.yaml')).toContain('pnpm-lock.yaml');
    expect(destructiveTargets('echo hi > .env')).toContain('.env');
    expect(destructiveTargets('mv .env .env.bak')).toEqual(
      expect.arrayContaining(['.env', '.env.bak']),
    );
  });

  it('extracts common shell writer and wrapper targets', async () => {
    expect(destructiveTargets('echo x | tee -a .env')).toContain('.env');
    expect(destructiveTargets('git clean -fd')).toContain('.');
    expect(destructiveTargets('find . -delete')).toContain('.');
    expect(destructiveTargets('find src -type f -delete')).toContain('src');
    expect(destructiveTargets('cp src pnpm-lock.yaml')).toContain('pnpm-lock.yaml');
    expect(destructiveTargets('install -m 644 x .env')).toContain('.env');
    expect(destructiveTargets('dd if=src of=.env bs=4k')).toContain('.env');
    expect(destructiveTargets('sudo dd if=src of=".env local" bs=4k')).toContain('.env local');
    expect(destructiveTargets("sed -i 's/old/new/' .env")).toContain('.env');
    expect(destructiveTargets("sed -i 's/old/new/' .env notes.txt")).toEqual(
      expect.arrayContaining(['.env', 'notes.txt']),
    );
    expect(destructiveTargets('ln -sf source .env')).toContain('.env');
    expect(destructiveTargets("sh -c 'rm .env'")).toContain('.env');
    expect(destructiveTargets('printf .env | xargs rm')).toContain('.env');
    expect(destructiveTargets('xargs -0 rm .env')).toContain('.env');
    expect(destructiveTargets('xargs -r rm .env')).toContain('.env');
  });

  it('extracts writer targets inside command groups and subshells (boundary-bypass regression)', async () => {
    for (const command of [
      '{ cp src .env; }',
      '( cp src .env )',
      '{ install -m 644 x .env; }',
      '{ dd if=src of=.env bs=4k; }',
      '( dd if=src of=.env )',
      '{ tee .env; }',
      '( tee -a .env )',
      '{ sed -i "s/a/b/" .env; }',
      '( sed -i "s/a/b/" .env )',
      '{ ln -sf source .env; }',
    ]) {
      expect(destructiveTargets(command), command).toContain('.env');
    }
  });

  it('still ignores assignment-looking operands and quoted read filenames', async () => {
    expect(destructiveTargets('echo of=.env')).toHaveLength(0);
    expect(destructiveTargets('cat "of=.env local"')).toHaveLength(0);
  });

  it('keeps compact subshell destinations free of glued close-parens', async () => {
    expect(destructiveTargets('(cp src .env)')).toContain('.env');
    expect(destructiveTargets('(sudo cp src .env)')).toContain('.env');
    expect(destructiveTargets('(install -m 644 x .env)')).toContain('.env');
    expect(destructiveTargets('(dd if=src of=.env)')).toContain('.env');
    expect(destructiveTargets('(dd if=src of=".env")')).toContain('.env');
  });

  it('preserves balanced parentheses in operand filenames', async () => {
    expect(destructiveTargets('cp src notes(2)')).toContain('notes(2)');
    expect(destructiveTargets("cp src 'notes(2)'")).toContain('notes(2)');
    expect(destructiveTargets('(cp src "notes(2)")')).toContain('notes(2)');
  });

  it('treats escaped trailing parens as filename text, not subshell closers', async () => {
    // The material property: the escaped `\)` must survive — stripping it
    // truncated the target to `protected\`, which matches no glob. The two
    // rules serialize differently by existing convention: cp's tokenizer
    // unescapes to the real filename `protected)`, while dd keeps operand
    // syntax literal (same convention as `$(pwd)/.env` targets).
    expect(destructiveTargets('cp src protected\\)').at(-1)).toBe('protected)');
    expect(destructiveTargets('dd if=src of=protected\\)').at(-1)).toBe('protected\\)');
  });

  it('extracts find deletion roots inside command groups and subshells (find-in-group regression)', async () => {
    expect(destructiveTargets('{ find . -delete; }')).toContain('.');
    expect(destructiveTargets('{ find db -delete; }')).toContain('db');
    expect(destructiveTargets('( find . -delete )')).toContain('.');
    expect(destructiveTargets('(find . -delete)')).toContain('.');
  });

  it('extracts writer targets after xargs value-taking options (xargs option bypass regression)', async () => {
    expect(destructiveTargets('printf x | xargs -n 1 tee .env')).toContain('.env');
    expect(destructiveTargets('xargs -I {} cp src {}')).toContain('{}');
    expect(destructiveTargets('xargs --replace={} cp src {}')).toContain('{}');
    // Flag-only options must keep working and must not swallow the writer
    // as an option value.
    expect(destructiveTargets('xargs -0 rm .env')).toContain('.env');
    expect(destructiveTargets('xargs -r rm .env')).toContain('.env');
  });

  it('preserves parentheses in destructive path operands', async () => {
    expect(destructiveTargets('rm -rf "$(pwd)/.env"')).toContain('$(pwd)/.env');
    expect(destructiveTargets('(cd workspace && rm .env)')).toContain('.env');
    expect(destructiveTargets('rm "file (1).env"')).toContain('file (1).env');
    expect(destructiveTargets('mv "backup(1).env" .env')).toEqual(
      expect.arrayContaining(['backup(1).env', '.env']),
    );
    expect(destructiveTargets(String.raw`rm config\ \(prod\).env`)).toContain('config (prod).env');
  });

  it('preserves Windows path separators inside double quotes', async () => {
    expect(destructiveTargets(String.raw`rm -rf "D:\repo\.git"`)).toContain(
      String.raw`D:\repo\.git`,
    );
    expect(destructiveTargets(String.raw`git -C "C:\repo" rm .env`)).toContain('C:/repo/.env');
    expect(destructiveTargets(String.raw`echo secret | tee -a "C:\repo\.env"`)).toContain(
      String.raw`C:\repo\.env`,
    );
  });

  it('extracts command and process substitutions but ignores arithmetic expansions', async () => {
    expect(destructiveTargets('echo hi > >(rm .env)')).toContain('.env');
    expect(destructiveTargets('cat < <(rm .env)')).toContain('.env');
    expect(destructiveTargets('echo $((rm .env))')).toHaveLength(0);
    expect(destructiveTargets('echo "$((rm .env))"')).toHaveLength(0);
    expect(destructiveTargets('echo "$(rm .env)"')).toContain('.env');
    expect(destructiveTargets('echo "`rm .env`"')).toContain('.env');
    expect(destructiveTargets('echo "$(printf ")" && rm .env)"')).toContain('.env');
    expect(destructiveTargets('echo "$(echo a $(b) && rm .env)"')).toContain('.env');
    expect(destructiveTargets(String.raw`echo "$(printf \); rm .env)"`)).toContain('.env');
    expect(destructiveTargets('echo "$( (rm .env) )"')).toContain('.env');
    expect(destructiveTargets('echo "$(printf x | sed s/x/y/; rm .env)"')).toContain('.env');
    expect(destructiveTargets("echo '$(rm .env)'")).toHaveLength(0);
    expect(destructiveTargets("echo '`rm .env`'")).toHaveLength(0);
    expect(destructiveTargets('echo "\\$(rm .env)"')).toHaveLength(0);
    expect(destructiveTargets('echo "\\`rm .env\\`"')).toHaveLength(0);
  });

  it('bounds deeply nested command substitution inspection with an unresolved scope', async () => {
    const nested = `${'echo $('.repeat(100)}rm .env${')'.repeat(100)}`;
    expect(destructiveTargets(nested)).toContain('**');
  });

  it('terminates safely on deeply nested unclosed substitutions', async () => {
    expect(destructiveTargets('$('.repeat(2_000))).toHaveLength(0);
  });

  it('extracts noclobber overrides and destructive raw Git targets', async () => {
    expect(destructiveTargets('echo secret >| .env')).toContain('.env');
    expect(destructiveTargets('sudo --user=root rm .env')).toContain('.env');
    expect(destructiveTargets('sudo --user root rm .env')).toContain('.env');
    expect(destructiveTargets('sudo --prompt=hint rm .env')).toContain('.env');
    expect(destructiveTargets('sudo --prompt hint rm .env')).toContain('.env');
    expect(destructiveTargets('sudo --prompt=Password: rm .env')).toContain('.env');
    expect(destructiveTargets('sudo --prompt Password: rm .env')).toContain('.env');
    expect(destructiveTargets("sudo --prompt 'Password: ' rm -rf .env")).toContain('.env');
    expect(destructiveTargets("sudo --prompt 'P: ' rm -rf /")).toContain('/');
    expect(destructiveTargets('sudo --group root rm .env')).toContain('.env');
    expect(destructiveTargets('sudo --chdir /tmp rm .env')).toContain('.env');
    expect(destructiveTargets('sudo -Eu root rm .env')).toContain('.env');
    expect(destructiveTargets('env -u VAR rm .env')).toContain('.env');
    expect(destructiveTargets('env -iu VAR rm .env')).toContain('.env');
    expect(destructiveTargets('env --unset VAR rm .env')).toContain('.env');
    expect(destructiveTargets('env --chdir /tmp rm .env')).toContain('.env');
    expect(destructiveTargets('env --ignore-environment rm .env')).toContain('.env');
    expect(destructiveTargets("git rm 'dir)/.env'")).toContain('dir)/.env');
    expect(destructiveTargets("git rm 'dir;name/.env'")).toContain('dir;name/.env');
    expect(destructiveTargets("git rm 'dir|name/.env'")).toContain('dir|name/.env');
    expect(destructiveTargets("git rm 'dir&name/.env'")).toContain('dir&name/.env');
    expect(destructiveTargets('git rm .env')).toContain('.env');
    expect(destructiveTargets('(git rm .env)')).toContain('.env');
    expect(destructiveTargets('(cd workspace && git rm .env)')).toContain('.env');
    expect(destructiveTargets('(git rm -r src)')).toContain('src/**');
    expect(destructiveTargets('(git restore .)')).toContain('**');
    expect(destructiveTargets('(git reset --hard)')).toContain('.');
    expect(destructiveTargets('git -C repo rm .env')).toContain('repo/.env');
    expect(destructiveTargets('git -Crepo rm .env')).toContain('repo/.env');
    expect(destructiveTargets('git -C "repo dir" rm .env')).toContain('repo dir/.env');
    expect(destructiveTargets('git -C repo -C nested rm .env')).toContain('repo/nested/.env');
    expect(destructiveTargets('git -C repo --work-tree=nested rm .env')).toContain(
      'repo/nested/.env',
    );
    expect(destructiveTargets('git -C repo reset --hard')).toContain('repo');
    expect(destructiveTargets('git --work-tree=repo clean -fd')).toContain('repo');
    expect(destructiveTargets('git --literal-pathspecs rm .env')).toContain('.env');
    expect(destructiveTargets('git --no-pager restore .env')).toContain('.env');
    expect(destructiveTargets('git --exec-path /tmp rm .env')).toContain('.env');
    expect(destructiveTargets('git --attr-source HEAD clean -fdx')).toContain('.');
    expect(destructiveTargets('git --attr-source=HEAD reset --hard')).toContain('.');
    expect(destructiveTargets('git -c core.safecrlf=false restore .env')).toContain('.env');
    expect(destructiveTargets('git restore .env')).toContain('.env');
    expect(destructiveTargets('git restore src')).toContain('src/**');
    expect(destructiveTargets('git rm --pathspec-from-file=paths.txt')).toContain('**');
    expect(destructiveTargets('git rm --pathspec-from-file paths.txt')).toContain('**');
    expect(destructiveTargets('git -C repo rm --pathspec-from-file=paths.txt')).toContain(
      'repo/**',
    );
    expect(destructiveTargets('git restore --pathspec-from-file=paths.txt')).toContain('**');
    expect(destructiveTargets('git restore --pathspec-from-file paths.txt')).toContain('**');
    expect(
      destructiveTargets('git --work-tree=repo restore --pathspec-from-file=paths.txt'),
    ).toContain('repo/**');
    expect(destructiveTargets('git restore --staged --worktree .env')).toContain('.env');
    expect(destructiveTargets('git restore --staged -W .env')).toContain('.env');
    expect(destructiveTargets('git restore -SW .env')).toContain('.env');
    expect(destructiveTargets('git checkout -- src/')).toContain('src/**');
    expect(destructiveTargets('git checkout -- src')).toContain('src/**');
    expect(destructiveTargets('git checkout -- .env')).toContain('.env');
    expect(destructiveTargets('git checkout .')).toContain('.');
    expect(destructiveTargets('git checkout pnpm-lock.yaml')).toContain('.');
    expect(destructiveTargets('git checkout feature/path-guard')).toContain('.');
    expect(destructiveTargets('git checkout -b feature/path-guard main')).toContain('.');
    expect(destructiveTargets('git switch feature/path-guard')).toContain('.');
    expect(destructiveTargets('git switch -c feature/path-guard main')).toContain('.');
    expect(destructiveTargets('git reset --hard')).toContain('.');
    expect(destructiveTargets('git reset --merge')).toContain('.');
    expect(destructiveTargets('git reset --keep')).toContain('.');
  });

  it('detects destructive payloads inside env split-string commands', async () => {
    expect(destructiveTargets("env -S 'rm .env'")).toContain('.env');
    expect(destructiveTargets('env -S "rm -rf .git"')).toContain('.git');
    expect(destructiveTargets('env -S "rm -rf \'.git\'"')).toContain('.git');
    expect(destructiveTargets(`env -S 'sh -c "rm .env"'`)).toContain('.env');
    expect(destructiveTargets(`env -S "sh -c 'rm .env'"`)).toContain('.env');
    expect(destructiveTargets(`env -S 'git clean -fd "dist"'`)).toContain('dist');
    expect(destructiveTargets(`env --split-string="rm -rf '.git'"`)).toContain('.git');
    expect(destructiveTargets("env -iS 'rm .env'")).toContain('.env');
    expect(destructiveTargets("/usr/bin/env -S 'rm .env'")).toContain('.env');
    expect(destructiveTargets("sudo /usr/bin/env -S 'rm -rf .git'")).toContain('.git');
    expect(destructiveTargets("env --split-string 'rm .env'")).toContain('.env');
    expect(destructiveTargets('env --split-string="rm -rf .git"')).toContain('.git');
    expect(destructiveTargets("env -C 'safe;dir' -S 'rm .env'")).toContain('.env');
    expect(destructiveTargets(String.raw`env -C safe\;dir -S 'rm .env'`)).toContain('.env');
  });

  it('does not unwrap env split-string text beyond a shell separator', async () => {
    expect(destructiveTargets("env FOO=1 ; echo -S 'rm -rf /'")).toHaveLength(0);
  });

  it('does not let `env -S` hide compound destructive commands', async () => {
    expect(destructiveTargets('rm -rf .git && env -S "echo hi"')).toContain('.git');
    expect(destructiveTargets('git clean -fdx && env -S "echo hi"')).toContain('.');
    expect(destructiveTargets('env -S "echo hi" && rm -rf .env')).toContain('.env');
    expect(destructiveTargets("env -S 'echo x' > .env")).toContain('.env');
    expect(destructiveTargets("env -S 'echo x' && rm .env")).toContain('.env');
    expect(destructiveTargets("rm -f .env; env -S 'echo y'")).toContain('.env');
    expect(destructiveTargets("env -S 'echo y' | tee .env")).toContain('.env');
    expect(destructiveTargets("sudo env -S 'rm .env'")).toContain('.env');
    expect(destructiveTargets("env -S'echo safe' && rm .env")).toContain('.env');
    expect(destructiveTargets("env -S 'echo safe'; env -S 'rm .env'")).toContain('.env');
    expect(destructiveTargets(`env -S "echo don't" ; rm .env`)).toContain('.env');
    expect(destructiveTargets(`env -S 'echo "hi' ; rm .env`)).toContain('.env');
    expect(destructiveTargets("env echo ok; rm .env; env -S 'echo safe'")).toContain('.env');
    expect(destructiveTargets("env -S 'echo safe'")).toHaveLength(0);
  });

  it('ignores Git-looking text inside quoted shell arguments', async () => {
    expect(destructiveTargets('echo "a; git clean -fdx"')).toHaveLength(0);
    expect(destructiveTargets('echo "line1\ngit clean -fdx"')).toHaveLength(0);
    expect(destructiveTargets('echo "x; git reset --hard"; cp notes.txt .')).toEqual(['.']);
  });

  it('ignores non-mutating raw Git forms', async () => {
    expect(destructiveTargets('git log -- rm .env')).toHaveLength(0);
    expect(destructiveTargets('git config rm .env')).toHaveLength(0);
    expect(destructiveTargets('git status clean')).toHaveLength(0);
    expect(destructiveTargets('git clean -x\necho hello')).toEqual(['.']);
    expect(destructiveTargets('git status rm')).toHaveLength(0);
    expect(destructiveTargets('git add restore')).toHaveLength(0);
    expect(destructiveTargets('git diff checkout')).toHaveLength(0);
    expect(destructiveTargets('git reset -- .env')).toHaveLength(0);
    expect(destructiveTargets('git restore -S .env')).toHaveLength(0);
    expect(destructiveTargets('git checkout -b feature/path-guard')).toHaveLength(0);
    expect(destructiveTargets('git checkout --orphan feature/path-guard')).toHaveLength(0);
    expect(destructiveTargets('git checkout --branch feature/path-guard')).toHaveLength(0);
    expect(destructiveTargets('git switch -c feature/path-guard')).toHaveLength(0);
    expect(destructiveTargets('git clean -n')).toHaveLength(0);
    expect(destructiveTargets('git clean -nd')).toHaveLength(0);
  });

  it('classifies recursive Git directory operands as scopes', async () => {
    expect(destructiveTargets('git rm -r src')).toContain('src/**');
    expect(destructiveTargets('git clean -fd src/')).toContain('src/**');
    expect(destructiveTargets('git restore src/')).toContain('src/**');
    expect(destructiveTargets('git restore -s HEAD~1 src/')).toEqual(['src/**']);
    expect(destructiveTargets('git restore --source=HEAD~1 src/')).toEqual(['src/**']);
  });

  it('does not mistake git clean redirects or exclude values for deletion roots', async () => {
    expect(destructiveTargets('git clean -fdx > /dev/null')).toEqual(['.']);
    expect(destructiveTargets('git clean -fdx 2>/dev/null')).toEqual(['.']);
    expect(destructiveTargets('git clean -fdx >> clean.log')).toEqual(
      expect.arrayContaining(['.', 'clean.log']),
    );
    expect(destructiveTargets('git clean -f -e pnpm-lock.yaml')).toEqual(['.']);
    expect(destructiveTargets('git clean -f --exclude .env')).toEqual(['.']);
    expect(destructiveTargets('git clean -f --exclude=.env')).toEqual(['.']);
  });

  it.each(['/bin/cat <<EOF\nrm .env\nEOF', 'sudo /bin/cat <<EOF\nrm .env\nEOF'])(
    'ignores destructive syntax in path-qualified or wrapped cat heredoc data: %s',
    async (command) => {
      expect(destructiveTargets(command)).toHaveLength(0);
    },
  );

  it('does not treat assignment-like of= arguments on benign commands as dd outputs', async () => {
    expect(destructiveTargets('echo see of=.env')).toHaveLength(0);
    expect(destructiveTargets('ls of=.env')).toHaveLength(0);
    expect(destructiveTargets("grep 'x' of=.env")).toHaveLength(0);
  });

  it('unwraps env launchers and honors copy target-directory options', async () => {
    expect(destructiveTargets('env rm .env')).toContain('.env');
    expect(destructiveTargets('env FOO=bar rm ".env local"')).toContain('.env local');
    expect(destructiveTargets('cp -t .git source')).toContain('.git');
    expect(destructiveTargets('cp --target-directory .git source')).toContain('.git');
    expect(destructiveTargets('install --target-directory=.git source')).toContain('.git');
  });

  it('strips env/sudo option-bearing launchers so deletion is not hidden', async () => {
    expect(destructiveTargets('env -i rm .env')).toContain('.env');
    expect(destructiveTargets('env -i rm -rf db')).toContain('db');
    expect(destructiveTargets('env -uFOO rm .env')).toContain('.env');
    expect(destructiveTargets('env -C/tmp rm .env')).toContain('.env');
    expect(destructiveTargets('env -C /tmp rm .env')).toContain('.env');
    expect(destructiveTargets('env -P /tmp rm .env')).toContain('.env');
    expect(destructiveTargets('env --chdir /tmp rm .env')).toContain('.env');
    expect(destructiveTargets('env -C "my dir" rm .env')).toContain('.env');
    expect(destructiveTargets('env --chdir "my dir" rm .env')).toContain('.env');
    expect(destructiveTargets('env -a NAME rm -rf .git')).toContain('.git');
    expect(destructiveTargets('env --argv0 NAME rm -rf .git')).toContain('.git');
    expect(destructiveTargets('env --argv0=NAME rm -rf .git')).toContain('.git');
    expect(destructiveTargets('env -iv rm -rf .git')).toContain('.git');
    expect(destructiveTargets('sudo -i rm .env')).toContain('.env');
    expect(destructiveTargets('sudo -i rm -rf db')).toContain('db');
    expect(destructiveTargets('sudo -E rm .env')).toContain('.env');
    expect(destructiveTargets('sudo -u root rm .env')).toContain('.env');
    expect(destructiveTargets('sudo -uroot rm -rf .git')).toContain('.git');
    expect(destructiveTargets('sudo -g root rm -rf .git')).toContain('.git');
    expect(destructiveTargets('sudo -C 3 rm -rf .git')).toContain('.git');
    expect(destructiveTargets("sudo -p 'pw' rm .env")).toContain('.env');
    expect(destructiveTargets('sudo -p "password: " rm .env')).toContain('.env');
    expect(destructiveTargets('sudo --user "user name" rm .env')).toContain('.env');
    expect(destructiveTargets('sudo --host x rm .env')).toContain('.env');
    expect(destructiveTargets('sudo FOO=bar rm -rf .git')).toContain('.git');
    expect(destructiveTargets('sudo -u root;rm -rf db')).toContain('db');
    expect(destructiveTargets('sudo --user=root;rm .env')).toContain('.env');
    expect(destructiveTargets('sudo FOO=bar;rm .env')).toContain('.env');
    expect(destructiveTargets('env -u FOO;rm .env')).toContain('.env');
    expect(destructiveTargets('env -uFOO;rm .env')).toContain('.env');
    expect(destructiveTargets('env -C/tmp;rm .env')).toContain('.env');
  });

  it('distinguishes file-form combined redirects from descriptor operations', async () => {
    expect(destructiveTargets('echo secret >& .env')).toContain('.env');
    expect(destructiveTargets('echo secret >&.env')).toContain('.env');
    expect(destructiveTargets('command 2>&1')).toHaveLength(0);
    expect(destructiveTargets('command >&-')).toHaveLength(0);
  });

  it('ignores non-destructive commands, quoted operators, fd copies, and /dev/null', async () => {
    expect(destructiveTargets('cat .env')).toHaveLength(0);
    expect(destructiveTargets('echo "note: > .env"')).toHaveLength(0);
    expect(destructiveTargets('command 2>&1')).toHaveLength(0);
    expect(destructiveTargets('ls -la > /dev/null')).toHaveLength(0);
  });

  it.each([
    'echo "note: dd of=.env"',
    'echo "note; rm .env"',
    'echo "note; cp source .env"',
    'echo "note | tee .env"',
    'echo "note; sed -i s/x/y/ .env"',
    'echo "note: printf .env | xargs rm"',
  ])('ignores destructive-looking syntax inside quoted text: %s', async (command) => {
    expect(destructiveTargets(command)).toHaveLength(0);
  });

  it('preserves spaces in quoted redirect targets', async () => {
    expect(destructiveTargets('echo hi > "my dir/.env"')).toContain('my dir/.env');
  });

  it('keeps opposite quote characters literal while locating redirects', async () => {
    expect(destructiveTargets('echo "it\'s" > .env')).toContain('.env');
    expect(destructiveTargets("echo 'say \"hi' > .env")).toContain('.env');
  });

  it('treats newlines as command boundaries for destructive writers', async () => {
    expect(destructiveTargets('echo ok\nrm .env')).toContain('.env');
    expect(destructiveTargets('echo ok\r\ncp source .env')).toContain('.env');
  });

  it('does not treat a backslash as escaping a POSIX single quote', async () => {
    expect(destructiveTargets("echo 'foo\\' ; rm .env")).toContain('.env');
  });

  it.each([
    ["cat <<'EOF'\nliteral > .env\nEOF\necho safe > notes.txt", ['notes.txt']],
    ["echo x | cat <<'EOF'\nliteral > .env\nEOF\necho safe > notes.txt", ['notes.txt']],
    [
      "tee output.txt <<'EOF'\nliteral > .env\nEOF\necho safe > notes.txt",
      ['output.txt', 'notes.txt'],
    ],
    ["while read line <<'EOF'\nliteral > .env\nEOF\necho safe > notes.txt", ['notes.txt']],
    ['while read line; do echo "$line"; done <<\'EOF\'\nliteral > .env\nEOF', []],
    ['while read line\ndo\n  echo "$line"\ndone <<\'EOF\'\nliteral > .env\nEOF', []],
    ["cat <<'EOF' > output\nrm .env\nEOF", ['output']],
    [
      String.raw`cat <<\EOF
rm .env
EOF`,
      [],
    ],
  ])(
    'ignores redirect-looking text inside non-executing heredoc bodies: %s',
    async (command, expected) => {
      expect(destructiveTargets(command)).toEqual(expected);
    },
  );

  it('does not treat a data heredoc feeding process substitution as executing its body', async () => {
    expect(destructiveTargets("cat <<'EOF' > >(grep x)\nrm .env\nEOF")).toHaveLength(0);
  });

  it.each(['env sh', 'sudo sh'])(
    'inspects heredoc bodies executed by launcher-wrapped process substitutions: %s',
    async (processCommand) => {
      expect(destructiveTargets(`cat <<'EOF' > >(${processCommand})\nrm .env\nEOF`)).toContain(
        '.env',
      );
    },
  );

  it('inspects executable heredoc consumers but keeps quoted data heredocs inert', async () => {
    expect(destructiveTargets('cat <<EOF\n$(rm .env)\nEOF')).toContain('.env');
    expect(destructiveTargets('cat <<EOF\n$(\nrm .env\n)\nEOF')).toContain('.env');
    expect(destructiveTargets('cat <<EOF\n`\nrm .env\n`\nEOF')).toContain('.env');
    expect(destructiveTargets("cat <<'EOF'\n$(rm .env)\nEOF")).toHaveLength(0);
    expect(destructiveTargets("python <<'EOF'\nrm .env\nEOF")).toContain('.env');
    expect(destructiveTargets('python <<EOF\n$(rm .env)\nEOF')).toContain('.env');
    for (const interpreter of ['sh', 'bash', 'zsh', 'sh -c']) {
      expect(destructiveTargets(`cat <<EOF | ${interpreter}\nrm .env\nEOF`)).toContain('.env');
    }
    expect(destructiveTargets('cat <<EOF > >(sh)\nrm .env\nEOF')).toContain('.env');
    expect(destructiveTargets('cat <<EOF > fix.sh\nrm .env\nEOF\nbash fix.sh')).toContain('.env');
  });

  it.each([
    "cat <<'EOF' > fix.sh; sh fix.sh\nrm .env\nEOF",
    "cat <<'EOF' > fix.sh\nrm .env\nEOF\nchmod +x fix.sh\n./fix.sh",
    "cat <<'EOF' >> fix.sh\nrm .env\nEOF\nbash ./fix.sh",
    "cat <<'EOF' >| scripts/fix.sh\nrm .env\nEOF\n./scripts/./fix.sh",
  ])(
    'inspects a generated heredoc script through equivalent path spellings: %s',
    async (command) => {
      expect(destructiveTargets(command)).toContain('.env');
    },
  );

  it.each([
    "printf x | tee /tmp/out | sh <<'EOF'\nrm .env\nEOF",
    "sh -c true | cat <<'EOF'\nrm .env\nEOF",
    "sh -c true | tee /tmp/out <<'EOF'\nrm .env\nEOF",
  ])('classifies the command immediately owning a heredoc: %s', async (command) => {
    const targets = destructiveTargets(command);
    if (command.includes('sh <<')) expect(targets).toContain('.env');
    else expect(targets).not.toContain('.env');
  });

  it('does not mistake a here-string for a heredoc', async () => {
    expect(destructiveTargets('cat <<< "x"\nrm .env')).toContain('.env');
  });

  it('applies tab-only terminator stripping for <<- heredocs', async () => {
    expect(
      destructiveTargets("cat <<-'EOF'\nliteral > .env\n\tEOF\necho safe > notes.txt"),
    ).toEqual(['notes.txt']);
  });
});

describe('path-guard plugin', () => {
  it('keeps hook ownership isolated across concurrent plugin hosts', async () => {
    const first = makeApi();
    const second = makeApi();
    const unregisterFirst = vi.fn();
    const unregisterSecond = vi.fn();
    first.registerHook.mockReturnValue(unregisterFirst);
    second.registerHook.mockReturnValue(unregisterSecond);

    pathGuardPlugin.setup(first as never);
    pathGuardPlugin.setup(second as never);

    expect(unregisterFirst).not.toHaveBeenCalled();
    expect(unregisterSecond).not.toHaveBeenCalled();

    pathGuardPlugin.teardown?.(first as never);
    expect(unregisterFirst).toHaveBeenCalledOnce();
    expect(unregisterSecond).not.toHaveBeenCalled();

    pathGuardPlugin.teardown?.(second as never);
    expect(unregisterSecond).toHaveBeenCalledOnce();
  });

  it('blocks an unknown fs.write tool through the real HookRunner and ToolExecutor path', {
    timeout: 5_000,
  }, async () => {
    const hookRegistry = new HookRegistry();
    const api = makeApi();
    api.registerHook.mockImplementation((event, matcher, hook, options) =>
      hookRegistry.registerInProcess(event, matcher, hook, 'path-guard', options),
    );
    pathGuardPlugin.setup(api as never);

    const execute = vi.fn().mockResolvedValue('must not run');
    const writer = {
      name: 'mcp__filesystem__write_file',
      description: 'Unknown filesystem writer',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
      permission: 'auto',
      mutating: true,
      capabilities: ['fs.write'],
      execute,
    } as const;
    // `as const` keeps the literal readable; the registry wants a mutable Tool.
    const writerTool = writer as unknown as Tool;
    const executor = new ToolExecutor(
      { get: (name) => (name === writer.name ? writerTool : undefined), list: () => [writerTool] },
      {
        permissionPolicy: {
          evaluate: vi.fn().mockResolvedValue({ permission: 'auto', source: 'default' }),
        } as never,
        secretScrubber: { scrub: (value: string) => value } as never,
        hookRunner: new HookRunner({ registry: hookRegistry }),
      },
    );
    const ctx = {
      cwd: 'D:\\repo',
      projectRoot: 'D:\\repo',
      signal: new AbortController().signal,
      meta: {},
    } as never;

    const result = await executor.executeBatch(
      [
        {
          type: 'tool_use',
          id: 'unknown-writer',
          name: writer.name,
          input: { path: '.env' },
        },
      ],
      ctx,
      'sequential',
    );

    const blocked = result.outputs[0]?.result as ToolResultBlock;
    expect(blocked).toMatchObject({ is_error: true });
    expect(blocked.content).toContain('path-guard');
    expect(blocked.content).toContain('.env');
    expect(execute).not.toHaveBeenCalled();
  });

  it('registers a status tool and a PreToolUse hook for every tool', async () => {
    const api = makeApi();
    pathGuardPlugin.setup(api as never);
    expect(api.tools.register).toHaveBeenCalledTimes(1);
    const [event, matcher] = api.registerHook.mock.calls[0]!;
    expect(event).toBe('PreToolUse');
    // Was `write|edit|bash|exec`. A matcher is a list of tool NAMES, so that
    // registration could only ever cover tools someone had already thought of:
    // `patch`, `scaffold`, plugin-registered writers and MCP filesystem
    // servers all wrote past it. The hook now sees every call and decides from
    // the tool's own declaration.
    expect(matcher).toBe('*');
  });

  it('blocks writes to a default-protected lockfile', async () => {
    const api = makeApi();
    pathGuardPlugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({ toolName: 'write', toolInput: { path: 'pnpm-lock.yaml' } });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('pnpm-lock.yaml');
  });

  it('blocks edits to .env at any depth', async () => {
    const api = makeApi();
    pathGuardPlugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({ toolName: 'edit', toolInput: { file_path: 'apps/web/.env' } });
    expect(result?.decision).toBe('block');
  });

  it('blocks destructive command substitutions at the hook level', async () => {
    const api = makeApi();
    pathGuardPlugin.setup(api as never);
    const hook = getHook(api);
    for (const command of [
      'echo "$(rm .env)"',
      'echo "$( (rm .env) )"',
      'echo "`rm .env`"',
      'cat <<EOF\n$(rm .env)\nEOF',
    ]) {
      const result = await hook({ toolName: 'bash', toolInput: { command } });
      expect(result?.decision).toBe('block');
      expect(result?.reason).toContain('.env');
    }
  });

  it('fails closed when command substitution inspection reaches its depth cap', async () => {
    const api = makeApi();
    pathGuardPlugin.setup(api as never);
    const hook = getHook(api);
    const command = `${'echo $('.repeat(100)}rm .env${')'.repeat(100)}`;
    const result = await hook({ toolName: 'bash', toolInput: { command } });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('write scope "**"');
  });

  it('allows destructive-looking data in non-executing heredocs at the hook level', async () => {
    const api = makeApi();
    pathGuardPlugin.setup(api as never);
    const hook = getHook(api);
    expect(
      await hook({
        toolName: 'bash',
        toolInput: { command: 'cat <<EOF\nrm -rf .env\nEOF > README.md' },
      }),
    ).toBeUndefined();
    expect(
      await hook({
        toolName: 'bash',
        toolInput: { command: '/bin/cat <<EOF\nrm .env\nEOF' },
      }),
    ).toBeUndefined();
    expect(
      await hook({
        toolName: 'bash',
        toolInput: { command: "cat <<'EOF'\n$(rm .env)\nEOF" },
      }),
    ).toBeUndefined();
    expect(
      await hook({
        toolName: 'bash',
        toolInput: { command: 'cat <<EOF\ngit reset --hard\nEOF\ncp notes.txt .' },
      }),
    ).toBeUndefined();
    expect(
      await hook({
        toolName: 'bash',
        toolInput: { command: 'echo "git reset --hard"; cp notes.txt .' },
      }),
    ).toBeUndefined();
  });

  it('serializes argv assignment args so dd of= targets stay visible (argv bypass regression)', async () => {
    const api = makeApi();
    pathGuardPlugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({
      toolName: 'bash',
      toolInput: { command: 'dd', args: ['if=src', 'of=$HOME/.env'] },
    });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('.env');
  });

  it('does not block benign argv assignment data', async () => {
    const api = makeApi();
    pathGuardPlugin.setup(api as never);
    const hook = getHook(api);
    expect(
      await hook({ toolName: 'bash', toolInput: { command: 'printf', args: ['of=.env'] } }),
    ).toBeUndefined();
  });

  it('serializes argv assignment args for any writer tool, not only dd', async () => {
    // The KEY="value" serialization is generic: any argv-form writer whose
    // operands use assignment syntax must stay inspectable, and the
    // JSON.stringify fallback still applies to non-assignment quoted args.
    const api = makeApi();
    pathGuardPlugin.setup(api as never);
    const hook = getHook(api);
    // Generic assignment serialization: env-style tool carrying an of= arg.
    expect(
      await hook({ toolName: 'bash', toolInput: { command: 'env', args: ['of=.env'] } }),
    ).toBeUndefined();
    // Fallback path: a quoted non-assignment arg stays JSON-quoted and is
    // not misread as an assignment. Benign outcome = hook returns undefined.
    expect(
      await hook({ toolName: 'bash', toolInput: { command: 'cat', args: ['of=.env local'] } }),
    ).toBeUndefined();
    // rm via argv with a safe-charset protected path is still blocked.
    const blocked = await hook({
      toolName: 'bash',
      toolInput: { command: 'rm', args: ['-rf', '.env'] },
    });
    expect(blocked?.decision).toBe('block');
  });

  it.each(["bash <<'EOF'\necho hi > .env\nEOF", 'cat <<EOF\n$(echo hi > .env)\nEOF'])(
    'blocks redirect writes executed from heredoc content: %s',
    async (command) => {
      const api = makeApi();
      pathGuardPlugin.setup(api as never);
      const result = await getHook(api)({ toolName: 'bash', toolInput: { command } });
      expect(result?.decision).toBe('block');
      expect(result?.reason).toContain('.env');
    },
  );

  it.each([
    'find . -delete',
    'find db -delete',
    'find db -exec rm -rf {} +',
    '{ find . -delete; }',
    'xargs -n 1 rm -rf db',
  ])('blocks recursive find deletion scopes: %s', async (command) => {
    const api = makeApi({ extensions: { 'path-guard': { protect: ['db/migrations/**'] } } });
    pathGuardPlugin.setup(api as never);
    expect((await getHook(api)({ toolName: 'bash', toolInput: { command } }))?.decision).toBe(
      'block',
    );
  });

  it('blocks destructive commands in process substitutions', async () => {
    const api = makeApi();
    pathGuardPlugin.setup(api as never);
    const result = await getHook(api)({
      toolName: 'bash',
      toolInput: { command: 'echo hi > >(rm .env)' },
    });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('.env');
  });

  it('blocks an executing heredoc owner after an earlier tee pipeline stage', async () => {
    const api = makeApi();
    pathGuardPlugin.setup(api as never);
    const result = await getHook(api)({
      toolName: 'bash',
      toolInput: { command: "printf x | tee /tmp/out | sh <<'EOF'\nrm .env\nEOF" },
    });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('.env');
  });

  it('blocks protected suffixes after command substitutions in destructive operands', async () => {
    const api = makeApi();
    pathGuardPlugin.setup(api as never);
    const result = await getHook(api)({
      toolName: 'bash',
      toolInput: { command: 'rm -rf "$(pwd)/.env"' },
    });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('$(pwd)/.env');
  });

  it('blocks quoted Windows-style protected paths', async () => {
    const api = makeApi();
    pathGuardPlugin.setup(api as never);
    const result = await getHook(api)({
      toolName: 'bash',
      toolInput: { command: String.raw`rm -rf "D:\repo\.git"` },
      cwd: String.raw`D:\repo`,
    });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('.git');
  });

  it('guards raw Git operations that can rewrite the working tree', async () => {
    const api = makeApi();
    pathGuardPlugin.setup(api as never);
    const hook = getHook(api);
    for (const command of [
      'git checkout main',
      'git switch dev',
      'git stash',
      'git stash push',
      'git stash pop',
      'git stash apply',
      'git checkout .',
    ]) {
      expect((await hook({ toolName: 'bash', toolInput: { command } }))?.decision).toBe('block');
    }
    expect(
      await hook({ toolName: 'bash', toolInput: { command: 'git stash list' } }),
    ).toBeUndefined();
    expect(
      await hook({ toolName: 'bash', toolInput: { command: 'git stash show' } }),
    ).toBeUndefined();
    expect(
      (await hook({ toolName: 'bash', toolInput: { command: 'git reset --hard' } }))?.decision,
    ).toBe('block');
    expect(
      (
        await hook({
          toolName: 'bash',
          toolInput: { command: 'git --attr-source HEAD clean -fdx' },
        })
      )?.decision,
    ).toBe('block');
    expect(
      (
        await hook({
          toolName: 'bash',
          toolInput: { command: 'git --attr-source=HEAD reset --hard' },
        })
      )?.decision,
    ).toBe('block');
  });

  it('blocks destructive commands hidden behind env split-string launchers', async () => {
    const api = makeApi();
    pathGuardPlugin.setup(api as never);
    const hook = getHook(api);
    for (const command of [
      "env -S 'rm -rf .'",
      "env --split-string 'rm .env'",
      'env --split-string="rm -rf .git"',
      `env -S "echo don't" ; rm .env`,
      `env -S 'echo "hi' ; rm .env`,
    ]) {
      expect((await hook({ toolName: 'bash', toolInput: { command } }))?.decision).toBe('block');
    }
  });

  it('blocks destructive bash on protected paths, allows reads', async () => {
    const api = makeApi();
    pathGuardPlugin.setup(api as never);
    const hook = getHook(api);
    expect((await hook({ toolName: 'bash', toolInput: { command: 'rm -f .env' } }))?.decision).toBe(
      'block',
    );
    expect(
      (await hook({ toolName: 'bash', toolInput: { command: 'rm -rf .git' } }))?.decision,
    ).toBe('block');
    expect(
      (await hook({ toolName: 'bash', toolInput: { command: 'echo secret >& .env' } }))?.decision,
    ).toBe('block');
    expect(await hook({ toolName: 'bash', toolInput: { command: 'cat .env' } })).toBeUndefined();
  });

  it('classifies shell commands once without inventing a working-directory target', async () => {
    const api = makeApi();
    pathGuardPlugin.setup(api as never);
    const hook = getHook(api);

    expect(
      await hook({
        toolName: 'exec',
        toolInput: { command: 'cat .env' },
        toolCapabilities: ['shell.restricted', 'fs.write'],
        toolMutating: true,
      }),
    ).toBeUndefined();
    expect(
      (
        await hook({
          toolName: 'exec',
          toolInput: { command: 'rm -f .env' },
          toolCapabilities: ['shell.restricted', 'fs.write'],
          toolMutating: true,
        })
      )?.decision,
    ).toBe('block');
    expect(
      (
        await hook({
          toolName: 'exec',
          toolInput: { command: 'rm', args: ['-f', '.env'] },
          toolCapabilities: ['shell.restricted'],
          toolMutating: true,
        })
      )?.decision,
    ).toBe('block');
    expect(
      (
        await hook({
          toolName: 'exec',
          toolInput: { command: 'rm', args: ['-rf', '.'] },
          toolCapabilities: ['shell.restricted'],
          toolMutating: true,
        })
      )?.decision,
    ).toBe('block');
  });

  it('rebases relative destructive shell targets against the effective cwd', async () => {
    const api = makeApi({
      extensions: { 'path-guard': { protect: ['db/migrations/**'] } },
    });
    pathGuardPlugin.setup(api as never);
    const hook = getHook(api);

    for (const input of [
      { toolInput: { command: 'rm migrations/001.sql', cwd: 'db' } },
      { toolInput: { command: 'rm migrations/001.sql' }, cwd: 'db' },
    ]) {
      const result = await hook({ toolName: 'bash', ...input });
      expect(result?.decision).toBe('block');
      expect(result?.reason).toContain('db/migrations/001.sql');
    }
  });

  it('blocks Git targets rebased through global working-tree options', async () => {
    const api = makeApi({
      extensions: { 'path-guard': { protect: ['sub/secrets/**'] } },
    });
    pathGuardPlugin.setup(api as never);
    const hook = getHook(api);

    for (const command of ['git -C sub rm secrets/key', 'git -Csub rm secrets/key']) {
      expect((await hook({ toolName: 'bash', toolInput: { command } }))?.decision).toBe('block');
    }
    expect(
      (
        await hook({
          toolName: 'bash',
          toolInput: { command: 'git --work-tree=sub restore secrets/key' },
        })
      )?.decision,
    ).toBe('block');
  });

  it('blocks file-sourced Git pathspecs within the effective working tree', async () => {
    const api = makeApi({
      extensions: { 'path-guard': { protect: ['sub/secrets/**'] } },
    });
    pathGuardPlugin.setup(api as never);
    const hook = getHook(api);

    for (const command of [
      'git -C sub rm --pathspec-from-file=paths.txt',
      'git --work-tree=sub restore --pathspec-from-file paths.txt',
    ]) {
      expect((await hook({ toolName: 'bash', toolInput: { command } }))?.decision).toBe('block');
    }
  });

  it('blocks destructive shell commands targeting protected directory roots', async () => {
    const api = makeApi();
    pathGuardPlugin.setup(api as never);
    const hook = getHook(api);

    for (const command of ['rm -rf .', 'rm -rf .git', 'rm -rf migrations', 'rm -f .env*']) {
      expect((await hook({ toolName: 'bash', toolInput: { command } }))?.decision).toBe('block');
    }
  });

  it.each([
    { protect: ['db/migrations/**'], command: 'rm -rf db' },
    { protect: ['**/migrations/**'], command: 'rm -rf db' },
    { protect: ['src/generated/**'], command: 'rm -rf src' },
    { protect: ['cache.v1/.env'], command: 'rm -rf cache.v1' },
  ])('blocks deleting an ancestor of a protected subtree: %j', async ({ protect, command }) => {
    const api = makeApi({ extensions: { 'path-guard': { protect } } });
    pathGuardPlugin.setup(api as never);
    const result = await getHook(api)({ toolName: 'bash', toolInput: { command } });
    expect(result?.decision).toBe('block');
  });

  it.each([
    'rm -f -r db',
    'rm -r -f db',
    'rm -fr db',
    'rm -R db',
    'rm --recursive --force db',
    'rm --force --recursive db',
    'rd /s /q db',
    'Remove-Item -Recurse -Force db',
    'del /q /s db',
    'del /s /q db',
  ])('blocks recursive deletion with separate or reordered options: %s', async (command) => {
    const api = makeApi({
      extensions: { 'path-guard': { protect: ['db/migrations/**'] } },
    });
    pathGuardPlugin.setup(api as never);
    const result = await getHook(api)({ toolName: 'bash', toolInput: { command } });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('write scope "db"');
  });

  it.each(['rm -f db -rf', 'rm db --recursive', 'del db /s'])(
    'blocks recursive flags after the first operand: %s',
    async (command) => {
      const api = makeApi({
        extensions: { 'path-guard': { protect: ['db/migrations/**'] } },
      });
      pathGuardPlugin.setup(api as never);
      const result = await getHook(api)({ toolName: 'bash', toolInput: { command } });
      expect(result?.decision).toBe('block');
      expect(result?.reason).toContain('write scope "db"');
    },
  );

  it.each(['rm -f . -rf', 'del . /s'])(
    'blocks recursive deletion of the working tree when flags follow the operand: %s',
    async (command) => {
      const api = makeApi();
      pathGuardPlugin.setup(api as never);
      const result = await getHook(api)({ toolName: 'bash', toolInput: { command } });
      expect(result?.decision).toBe('block');
      expect(result?.reason).toContain('write scope "."');
    },
  );

  it('does not treat recursion-like operands after an option terminator as flags', async () => {
    const api = makeApi({
      extensions: { 'path-guard': { protect: ['db/migrations/**'] } },
    });
    pathGuardPlugin.setup(api as never);
    const result = await getHook(api)({
      toolName: 'bash',
      toolInput: { command: 'rm db -- --recursive' },
    });
    expect(result).toBeUndefined();
  });

  it('applies allow globs normally to concrete destructive-shell targets', async () => {
    const api = makeApi({
      extensions: {
        'path-guard': { protect: ['.env*'], allow: ['**/.env'] },
      },
    });
    pathGuardPlugin.setup(api as never);
    const hook = getHook(api);

    expect(await hook({ toolName: 'bash', toolInput: { command: 'rm .env' } })).toBeUndefined();
    expect(
      (await hook({ toolName: 'bash', toolInput: { command: 'rm .env.local' } }))?.decision,
    ).toBe('block');
  });

  it('allows destructive shell commands on unprotected concrete paths under defaults', async () => {
    const api = makeApi();
    pathGuardPlugin.setup(api as never);
    const hook = getHook(api);

    for (const command of [
      'rm -f src/index.ts',
      'rm -rf src/index.ts',
      'rm -rf notes.txt',
      'mv a b',
      'echo x > notes.txt',
    ]) {
      expect(await hook({ toolName: 'bash', toolInput: { command } })).toBeUndefined();
    }
  });

  it.each([
    'sudo -u root;rm -rf db',
    'sudo --user=root;rm .env',
    'sudo FOO=bar;rm .env',
    'env -u FOO;rm .env',
    'env -uFOO;rm .env',
    'env -C/tmp;rm .env',
  ])('blocks destructive commands glued to launcher option values: %s', async (command) => {
    const api = makeApi({ extensions: { 'path-guard': { protect: ['db/**', '.env'] } } });
    pathGuardPlugin.setup(api as never);
    expect((await getHook(api)({ toolName: 'bash', toolInput: { command } }))?.decision).toBe(
      'block',
    );
  });

  it.each(['env --unknown rm .env', 'env -a', 'env --argv0'])(
    'fails closed for unknown or malformed env launcher options: %s',
    async (command) => {
      const api = makeApi();
      pathGuardPlugin.setup(api as never);
      const result = await getHook(api)({ toolName: 'bash', toolInput: { command } });
      expect(result?.decision).toBe('block');
      expect(result?.reason).toContain('write scope "**"');
    },
  );

  it.each(['cp src .', 'mv x .'])(
    'does not widen a literal root destination into a deletion scope: %s',
    async (command) => {
      const api = makeApi();
      pathGuardPlugin.setup(api as never);
      expect(await getHook(api)({ toolName: 'bash', toolInput: { command } })).toBeUndefined();
    },
  );

  it.each([
    'sudo rm -rf db',
    'sudo -uroot rm -rf db',
    'sudo -g root rm -rf db',
    'sudo -C 3 rm -rf db',
    'sudo git clean -fd',
    'env -i git reset --hard',
    '/usr/bin/sudo rm -rf db',
    'env -a NAME rm -rf db',
    'env --argv0 NAME rm -rf db',
    'env rm -rf db',
    '/usr/bin/env rm -rf db',
  ])('blocks recursive deletion through launcher wrappers: %s', async (command) => {
    const api = makeApi({ extensions: { 'path-guard': { protect: ['db/migrations/**'] } } });
    pathGuardPlugin.setup(api as never);
    expect((await getHook(api)({ toolName: 'bash', toolInput: { command } }))?.decision).toBe(
      'block',
    );
  });

  it('allows concrete files but blocks directory writer scopes that may contain defaults', async () => {
    const api = makeApi();
    pathGuardPlugin.setup(api as never);
    const hook = getHook(api);

    expect(await hook({ toolName: 'write', toolInput: { path: 'src/index.ts' } })).toBeUndefined();
    expect(
      (
        await hook({
          toolName: 'format',
          toolInput: { files: 'src', check: false },
          toolCapabilities: ['fs.write'],
        })
      )?.decision,
    ).toBe('block');
    expect(
      (
        await hook({
          toolName: 'scaffold',
          toolInput: { template: 'npm-package', cwd: 'packages/example', name: 'example' },
          toolCapabilities: ['fs.write'],
        })
      )?.decision,
    ).toBe('block');
  });

  it('warn mode injects context instead of blocking', async () => {
    const api = makeApi({ extensions: { 'path-guard': { mode: 'warn' } } });
    pathGuardPlugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({ toolName: 'write', toolInput: { path: '.env' } });
    expect(result?.decision).toBe('allow');
    expect(result?.additionalContext).toContain('path-guard');
  });

  it('allow globs override protect for scalar and single-item list targets', async () => {
    const api = makeApi({
      extensions: {
        'path-guard': { protect: ['**/migrations/**'], allow: ['**/migrations/dev/**'] },
      },
    });
    pathGuardPlugin.setup(api as never);
    const hook = getHook(api);
    expect(
      (await hook({ toolName: 'write', toolInput: { path: 'db/migrations/001.sql' } }))?.decision,
    ).toBe('block');
    expect(
      await hook({ toolName: 'write', toolInput: { path: 'db/migrations/dev/001.sql' } }),
    ).toBeUndefined();
    expect(
      await hook({ toolName: 'format', toolInput: { files: ['db/migrations/dev/001.sql'] } }),
    ).toBeUndefined();
    expect(
      await hook({ toolName: 'format', toolInput: { files: 'db/migrations/dev/001.sql' } }),
    ).toBeUndefined();
  });

  it('canonicalizes traversal before applying allow and protect globs', async () => {
    const api = makeApi({
      extensions: {
        'path-guard': { protect: ['.env'], allow: ['safe/**'] },
      },
    });
    pathGuardPlugin.setup(api as never);
    const hook = getHook(api);

    const result = await hook({ toolName: 'write', toolInput: { path: 'safe/../.env' } });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('.env');
  });

  it('enabled:false disables the guard', async () => {
    const api = makeApi({ extensions: { 'path-guard': { enabled: false } } });
    pathGuardPlugin.setup(api as never);
    const hook = getHook(api);
    expect(await hook({ toolName: 'write', toolInput: { path: '.env' } })).toBeUndefined();
  });

  it('teardown zeros counters and logs', async () => {
    const api = makeApi();
    pathGuardPlugin.setup(api as never);
    const hook = getHook(api);
    await hook({ toolName: 'write', toolInput: { path: '.env' } });
    pathGuardPlugin.teardown!(api as never);
    const health = (await pathGuardPlugin.health!()) as unknown as {
      counters: Record<string, number>;
    };
    expect(health.counters['blocks']).toBe(0);
    expect(api.log.info).toHaveBeenCalledWith('path-guard: teardown complete', expect.any(Object));
  });
});

/**
 * The widened surface. Each case is a tool that WOULD have written to a
 * protected path under the old four-name matcher.
 */
describe('path-guard covers any tool that declares a write', () => {
  function hookOf(api: ReturnType<typeof makeApi>) {
    return api.registerHook.mock.calls[0]![2] as (
      input: Record<string, unknown>,
    ) => Promise<{ decision?: string; reason?: string } | void>;
  }

  it('blocks a tool it has never heard of when it declares fs.write', async () => {
    const api = makeApi();
    pathGuardPlugin.setup(api as never);
    const result = await hookOf(api)({
      toolName: 'patch',
      toolInput: { path: 'pnpm-lock.yaml' },
      toolCapabilities: ['fs.write'],
    });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('pnpm-lock.yaml');
    // The message names the tool so the refusal is actionable.
    expect(result?.reason).toContain('patch');
  });

  it('falls back to the mutating flag when no capability is declared', async () => {
    const api = makeApi();
    pathGuardPlugin.setup(api as never);
    const result = await hookOf(api)({
      toolName: 'render_template',
      toolInput: { output_path: '.env' },
      toolCapabilities: [],
      toolMutating: true,
    });
    expect(result?.decision).toBe('block');
  });

  it('does not let mutating:true override declared non-filesystem capabilities', async () => {
    const api = makeApi();
    pathGuardPlugin.setup(api as never);
    const result = await hookOf(api)({
      toolName: 'config_writer',
      toolInput: { path: '.env' },
      toolCapabilities: ['config.mutate'],
      toolMutating: true,
    });
    expect(result).toBeUndefined();
  });

  it('treats an empty capability list as undeclared for legacy writers', async () => {
    const api = makeApi();
    pathGuardPlugin.setup(api as never);
    const result = await hookOf(api)({
      toolName: 'write',
      toolInput: { path: '.env' },
      toolCapabilities: [],
    });
    expect(result?.decision).toBe('block');
  });

  it('blocks every protected target in array-valued fields', async () => {
    const api = makeApi();
    pathGuardPlugin.setup(api as never);
    const result = await hookOf(api)({
      toolName: 'bulk_writer',
      toolInput: { files: ['src/index.ts', 'apps/web/.env'] },
      toolCapabilities: ['fs.write'],
    });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('apps/web/.env');
  });

  it('treats a single concrete list path consistently with multi-item lists', async () => {
    const api = makeApi();
    pathGuardPlugin.setup(api as never);
    const hook = hookOf(api);

    expect(
      await hook({
        toolName: 'format',
        toolInput: { files: 'src/index.ts', check: false },
        toolCapabilities: ['fs.write'],
      }),
    ).toBeUndefined();
    expect(
      await hook({
        toolName: 'format',
        toolInput: { files: ['src/index.ts', 'src/other.ts'], check: false },
        toolCapabilities: ['fs.write'],
      }),
    ).toBeUndefined();
  });

  it('trims array-valued targets before matching protected paths', async () => {
    const api = makeApi();
    pathGuardPlugin.setup(api as never);
    const result = await hookOf(api)({
      toolName: 'format',
      toolInput: { files: ['src/index.ts', ' .env '], check: false },
      toolCapabilities: ['fs.write'],
    });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('.env');
  });

  it('treats an array-valued directory operand as a scope', async () => {
    const api = makeApi({
      extensions: { 'path-guard': { protect: ['src/secrets/**'] } },
    });
    pathGuardPlugin.setup(api as never);
    const result = await hookOf(api)({
      toolName: 'format',
      toolInput: { files: ['src'], check: false },
      toolCapabilities: ['fs.write'],
    });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('write scope "src" may include a protected path');
  });

  it('splits comma-delimited target lists before matching regardless of order', async () => {
    const api = makeApi();
    pathGuardPlugin.setup(api as never);
    const hook = hookOf(api);

    for (const files of ['src/index.ts, apps/web/.env', 'apps/web/.env, src/index.ts']) {
      const result = await hook({
        toolName: 'format',
        toolInput: { files, check: false },
        toolCapabilities: ['fs.write'],
      });
      expect(result?.decision).toBe('block');
      expect(result?.reason).toContain('apps/web/.env');
    }
  });

  it('preserves commas in scalar path fields', async () => {
    const api = makeApi({
      extensions: { 'path-guard': { protect: ['reports/a,b.txt'] } },
    });
    pathGuardPlugin.setup(api as never);
    const result = await hookOf(api)({
      toolName: 'write',
      toolInput: { path: 'reports/a,b.txt' },
      toolCapabilities: ['fs.write'],
    });
    expect(result?.decision).toBe('block');
  });

  it.each([
    ['path', '**/*.yaml'],
    ['target', 'db/**'],
  ])('classifies glob-valued scalar %s fields as write scopes', async (field, value) => {
    const api = makeApi({
      extensions: { 'path-guard': { protect: ['db/config.yaml'] } },
    });
    pathGuardPlugin.setup(api as never);
    const result = await hookOf(api)({
      toolName: 'bulk_writer',
      toolInput: { [field]: value },
      toolCapabilities: ['fs.write'],
    });
    expect(result?.decision).toBe('block');
  });

  it('does not treat a concrete file target as its descendant directory scope', async () => {
    const api = makeApi({
      extensions: { 'path-guard': { protect: ['src/generated/**'] } },
    });
    pathGuardPlugin.setup(api as never);
    const result = await hookOf(api)({
      toolName: 'write',
      toolInput: { path: 'src' },
      toolCapabilities: ['fs.write'],
    });
    expect(result).toBeUndefined();
  });

  it('does not let a sibling allow subtree exempt a broader protected scope', async () => {
    const api = makeApi({
      extensions: {
        'path-guard': { protect: ['src/secret/**'], allow: ['src/allowed/**'] },
      },
    });
    pathGuardPlugin.setup(api as never);
    const result = await hookOf(api)({
      toolName: 'format',
      toolInput: { files: 'src', check: false },
      toolCapabilities: ['fs.write'],
    });
    expect(result?.decision).toBe('block');
  });

  it('does not let a wildcard allow prefix exempt a broader protected scope', async () => {
    const api = makeApi({
      extensions: {
        'path-guard': { protect: ['src/secrets/**'], allow: ['src/*/generated/**'] },
      },
    });
    pathGuardPlugin.setup(api as never);
    const result = await hookOf(api)({
      toolName: 'format',
      toolInput: { files: 'src/**', check: false },
      toolCapabilities: ['fs.write'],
    });
    expect(result?.decision).toBe('block');
  });

  it('does not treat a glob regex match against literal writer-glob text as a scope exemption', async () => {
    const api = makeApi({
      extensions: {
        'path-guard': { protect: ['src/secrets/**'], allow: ['src/*'] },
      },
    });
    pathGuardPlugin.setup(api as never);
    const result = await hookOf(api)({
      toolName: 'format',
      toolInput: { files: 'src/**', check: false },
      toolCapabilities: ['fs.write'],
    });
    expect(result?.decision).toBe('block');
  });

  it('blocks a pathless filesystem writer at its working-directory scope', async () => {
    const api = makeApi({
      extensions: { 'path-guard': { protect: ['src/secrets/**'] } },
    });
    pathGuardPlugin.setup(api as never);
    const result = await hookOf(api)({
      toolName: 'format',
      cwd: 'src',
      toolInput: { check: false },
      toolCapabilities: ['fs.write'],
    });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('write scope "src" may include a protected path');
  });

  it('rebases the production absolute cwd to the repository-root scope', async () => {
    const api = makeApi({
      extensions: { 'path-guard': { protect: ['src/secrets/**'] } },
    });
    pathGuardPlugin.setup(api as never);
    const result = await hookOf(api)({
      toolName: 'format',
      cwd: 'D:\\repo',
      toolInput: { check: false },
      toolCapabilities: ['fs.write'],
    });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('write scope "." may include a protected path');
  });

  it('rebases relative writer targets under an absolute hook cwd', async () => {
    const api = makeApi({
      extensions: { 'path-guard': { protect: ['src/generated/**'] } },
    });
    pathGuardPlugin.setup(api as never);
    const result = await hookOf(api)({
      toolName: 'format',
      cwd: 'D:\\repo',
      toolInput: { files: 'src', check: false },
      toolCapabilities: ['fs.write'],
    });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('write scope "src" may include a protected path');
  });

  it.each([{ packages: 'example' }, { packages: 'example', global: true }])(
    'fails closed for a real package install with unknown ecosystem outputs: %j',
    async (toolInput) => {
      const api = makeApi();
      pathGuardPlugin.setup(api as never);
      const result = await hookOf(api)({
        toolName: 'install',
        cwd: 'D:\\repo',
        toolInput,
        toolCapabilities: ['package.install', 'shell.restricted'],
        toolMutating: true,
      });
      expect(result?.decision).toBe('block');
      expect(result?.reason).toContain('write scope "." may include a protected path');
    },
  );

  it('fails closed for a package install dry run because delegated ecosystems may ignore it', async () => {
    const api = makeApi();
    pathGuardPlugin.setup(api as never);
    const result = await hookOf(api)({
      toolName: 'install',
      cwd: 'D:\\repo',
      toolInput: { packages: 'example', dry_run: true },
      toolCapabilities: ['package.install', 'shell.restricted'],
      toolMutating: true,
    });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('write scope "." may include a protected path');
  });

  it('does not let a package installer command string bypass its implicit write scope', async () => {
    const api = makeApi();
    pathGuardPlugin.setup(api as never);
    const result = await hookOf(api)({
      toolName: 'package_exec',
      cwd: 'D:\\repo',
      toolInput: { command: 'echo safe', packages: 'example' },
      toolCapabilities: ['package.install', 'shell.restricted'],
      toolMutating: true,
    });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('write scope "." may include a protected path');
  });

  it('does not let a legacy install command string bypass its implicit write scope', async () => {
    const api = makeApi();
    pathGuardPlugin.setup(api as never);
    const result = await hookOf(api)({
      toolName: 'install',
      cwd: 'D:\\repo',
      toolInput: { command: 'echo safe', packages: 'example' },
      toolMutating: true,
    });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('write scope "." may include a protected path');
  });

  it.each([
    { toolInput: { subagentId: 'worker-1' } },
    { toolInput: { path: '.env', subagentId: 'worker-1' } },
  ])('does not classify a non-filesystem mutator as a disk writer: %j', async ({ toolInput }) => {
    const api = makeApi();
    pathGuardPlugin.setup(api as never);
    const result = await hookOf(api)({
      toolName: 'terminate_subagent',
      cwd: 'D:\\repo',
      toolInput,
      toolCapabilities: ['subagent.spawn'],
      toolMutating: true,
    });
    expect(result).toBeUndefined();
  });

  it.each(['mcp__filesystem__edit_file', 'mcp__filesystem__appendFile', 'mcp__filesystem__mkdir'])(
    'blocks filesystem MCP writer %s even when upstream mutating inference misses it',
    async (toolName) => {
      const api = makeApi();
      pathGuardPlugin.setup(api as never);
      const result = await hookOf(api)({
        toolName,
        toolInput: { path: '.env' },
        toolCapabilities: ['mcp.proxy'],
        toolMutating: false,
      });
      expect(result?.decision).toBe('block');
    },
  );

  it('blocks structured directory deletion above a protected subtree', async () => {
    const api = makeApi({
      extensions: { 'path-guard': { protect: ['db/migrations/**'] } },
    });
    pathGuardPlugin.setup(api as never);
    const result = await hookOf(api)({
      toolName: 'mcp__filesystem__remove_directory',
      toolInput: { path: 'db' },
      toolCapabilities: ['mcp.proxy'],
      toolMutating: true,
    });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('write scope "db"');
  });

  it('blocks a structured directory move whose source contains a protected subtree', async () => {
    const api = makeApi({
      extensions: { 'path-guard': { protect: ['db/migrations/**'] } },
    });
    pathGuardPlugin.setup(api as never);
    const result = await hookOf(api)({
      toolName: 'mcp__filesystem__move_directory',
      toolInput: { source: 'db', destination: 'archive' },
      toolCapabilities: ['mcp.proxy'],
      toolMutating: true,
    });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('write scope "db"');
  });

  it('does not classify a filesystem MCP reader as a writer merely because it has a path', async () => {
    const api = makeApi();
    pathGuardPlugin.setup(api as never);
    const result = await hookOf(api)({
      toolName: 'mcp__filesystem__read_file',
      toolInput: { path: '.env' },
      toolCapabilities: ['mcp.proxy'],
      toolMutating: false,
    });
    expect(result).toBeUndefined();
  });

  it('blocks output aliases such as out', async () => {
    const api = makeApi();
    pathGuardPlugin.setup(api as never);
    const result = await hookOf(api)({
      toolName: 'design',
      toolInput: { action: 'materialize', out: '.env' },
      toolCapabilities: ['fs.write'],
    });
    expect(result?.decision).toBe('block');
  });

  it('derives a scaffold destination from cwd and name', async () => {
    const api = makeApi({
      extensions: { 'path-guard': { protect: ['**/migrations/**'] } },
    });
    pathGuardPlugin.setup(api as never);
    const result = await hookOf(api)({
      toolName: 'scaffold',
      toolInput: { template: 'npm-package', cwd: 'db/migrations', name: 'release' },
      toolCapabilities: ['fs.write'],
    });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('db/migrations');
  });

  it('blocks a scaffold scope whose fixed files can land in a protected directory', async () => {
    const api = makeApi({
      extensions: { 'path-guard': { protect: ['db/migrations/package.json'] } },
    });
    pathGuardPlugin.setup(api as never);
    const result = await hookOf(api)({
      toolName: 'scaffold',
      toolInput: { template: 'npm-package', cwd: 'db/migrations', name: 'release' },
      toolCapabilities: ['fs.write'],
    });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('db/migrations');
  });

  it('blocks a directory writer scope containing wildcard-protected descendants', async () => {
    const api = makeApi({
      extensions: { 'path-guard': { protect: ['src/generated/*.ts'] } },
    });
    pathGuardPlugin.setup(api as never);
    const result = await hookOf(api)({
      toolName: 'format',
      toolInput: { files: 'src', check: false },
      toolCapabilities: ['fs.write'],
    });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('src');
  });

  it('blocks a directory writer scope when the protected glob starts in that directory', async () => {
    const api = makeApi({
      extensions: { 'path-guard': { protect: ['src/*.ts'] } },
    });
    pathGuardPlugin.setup(api as never);
    const result = await hookOf(api)({
      toolName: 'format',
      toolInput: { files: 'src', check: false },
      toolCapabilities: ['fs.write'],
    });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('src');
  });

  it.each(['.env*', 'pnpm-lock.yaml', '**/migrations/**'])(
    'blocks a concrete directory scope that may contain %s',
    async (protect) => {
      const api = makeApi({ extensions: { 'path-guard': { protect: [protect] } } });
      pathGuardPlugin.setup(api as never);
      const result = await hookOf(api)({
        toolName: 'format',
        cwd: 'D:/work/repo',
        toolInput: { files: 'src', check: false },
        toolCapabilities: ['fs.write'],
      });
      expect(result?.decision).toBe('block');
      expect(result?.reason).toContain('write scope "src" may include a protected path');
    },
  );

  it('allows scaffolding into a concretely exempted directory scope', async () => {
    const api = makeApi({
      extensions: {
        'path-guard': { protect: ['**/migrations/**'], allow: ['**/migrations/dev/**'] },
      },
    });
    pathGuardPlugin.setup(api as never);
    const result = await hookOf(api)({
      toolName: 'scaffold',
      toolInput: { template: 'npm-package', cwd: 'db/migrations/dev', name: 'release' },
      toolCapabilities: ['fs.write'],
    });
    expect(result).toBeUndefined();
  });

  it('uses hook cwd when scaffold omits its cwd input', async () => {
    const api = makeApi({
      extensions: { 'path-guard': { protect: ['db/migrations/package.json'] } },
    });
    pathGuardPlugin.setup(api as never);
    const result = await hookOf(api)({
      toolName: 'scaffold',
      cwd: 'db/migrations',
      toolInput: { template: 'npm-package', name: 'release' },
      toolCapabilities: ['fs.write'],
    });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('db/migrations/package.json');
  });

  it.each([
    { cwdInput: { cwd: 'db' }, hookCwd: undefined },
    { cwdInput: {}, hookCwd: 'db' },
  ])(
    'rebases relative list targets against the effective cwd: %j',
    async ({ cwdInput, hookCwd }) => {
      const api = makeApi({
        extensions: { 'path-guard': { protect: ['db/migrations/**'] } },
      });
      pathGuardPlugin.setup(api as never);
      const result = await hookOf(api)({
        toolName: 'format',
        cwd: hookCwd,
        toolInput: { ...cwdInput, files: ['migrations'], check: false },
        toolCapabilities: ['fs.write'],
      });
      expect(result?.decision).toBe('block');
      expect(result?.reason).toContain('db/migrations');
    },
  );

  it('rebases relative scalar targets against the effective cwd', async () => {
    const api = makeApi({
      extensions: { 'path-guard': { protect: ['db/migrations/001.sql'] } },
    });
    pathGuardPlugin.setup(api as never);
    const result = await hookOf(api)({
      toolName: 'write',
      cwd: 'db',
      toolInput: { path: 'migrations/001.sql' },
      toolCapabilities: ['fs.write'],
    });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('db/migrations/001.sql');
  });

  it('blocks unresolved glob write scopes whose literal prefix overlaps protection', async () => {
    const api = makeApi({
      extensions: { 'path-guard': { protect: ['db/migrations/**'] } },
    });
    pathGuardPlugin.setup(api as never);
    const result = await hookOf(api)({
      toolName: 'replace',
      toolInput: {
        pattern: 'old',
        replacement: 'new',
        files: 'db/**/*.sql',
        dry_run: false,
      },
      toolCapabilities: ['fs.write'],
    });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('write scope "db/**/*.sql" may include a protected path');
  });

  it('allows unresolved glob write scopes whose literal prefix cannot reach protection', async () => {
    const api = makeApi({
      extensions: { 'path-guard': { protect: ['db/migrations/**'] } },
    });
    pathGuardPlugin.setup(api as never);
    const result = await hookOf(api)({
      toolName: 'format',
      toolInput: { files: 'src/**/*.ts', check: false },
      toolCapabilities: ['fs.write'],
    });
    expect(result).toBeUndefined();
  });

  it('allows prefixed write globs that cannot match a protected basename', async () => {
    const api = makeApi({
      extensions: { 'path-guard': { protect: ['.env*'] } },
    });
    pathGuardPlugin.setup(api as never);
    const result = await hookOf(api)({
      toolName: 'format',
      toolInput: { files: 'src/**/*.ts', check: false },
      toolCapabilities: ['fs.write'],
    });
    expect(result).toBeUndefined();
  });

  it('conservatively blocks write scopes against protected basenames at any depth', async () => {
    const api = makeApi({
      extensions: { 'path-guard': { protect: ['pnpm-lock.yaml'] } },
    });
    pathGuardPlugin.setup(api as never);
    const result = await hookOf(api)({
      toolName: 'format',
      toolInput: { files: 'packages/**/*.yaml', check: false },
      toolCapabilities: ['fs.write'],
    });
    expect(result?.decision).toBe('block');
  });

  it('blocks a repository-wide glob against default basename and descendant protection', async () => {
    const api = makeApi();
    pathGuardPlugin.setup(api as never);
    const result = await hookOf(api)({
      toolName: 'format',
      toolInput: { files: '**/*', check: false },
      toolCapabilities: ['fs.write'],
    });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('write scope "**/*" may include a protected path');
  });

  it('blocks repository-root list scopes containing protected descendants', async () => {
    const api = makeApi({
      extensions: { 'path-guard': { protect: ['.git/**'] } },
    });
    pathGuardPlugin.setup(api as never);
    const result = await hookOf(api)({
      toolName: 'format',
      toolInput: { files: '.', check: false },
      toolCapabilities: ['fs.write'],
    });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('write scope "." may include a protected path');
  });

  it('does not treat a matching static allow prefix as glob containment', async () => {
    const api = makeApi({
      extensions: {
        'path-guard': { protect: ['src/secret/**'], allow: ['src/*.ts'] },
      },
    });
    pathGuardPlugin.setup(api as never);
    const result = await hookOf(api)({
      toolName: 'format',
      toolInput: { files: 'src', check: false },
      toolCapabilities: ['fs.write'],
    });
    expect(result?.decision).toBe('block');
  });

  it('blocks write scopes with partial-segment wildcards that can reach protection', async () => {
    const api = makeApi({
      extensions: { 'path-guard': { protect: ['src/foobar/**'] } },
    });
    pathGuardPlugin.setup(api as never);
    const result = await hookOf(api)({
      toolName: 'format',
      toolInput: { files: 'src/foo*', check: false },
      toolCapabilities: ['fs.write'],
    });
    expect(result?.decision).toBe('block');
  });

  it('compares writer and protected scope prefixes case-insensitively', async () => {
    const api = makeApi({
      extensions: { 'path-guard': { protect: ['src/secrets/**'] } },
    });
    pathGuardPlugin.setup(api as never);
    const result = await hookOf(api)({
      toolName: 'format',
      toolInput: { files: 'SRC/**', check: false },
      toolCapabilities: ['fs.write'],
    });
    expect(result?.decision).toBe('block');
  });

  it.each(['.env*', 'src/.env*', 'src/foo*.env'])(
    'blocks dotted partial-segment write scopes that can reach protected paths: %s',
    async (files) => {
      const api = makeApi({
        extensions: { 'path-guard': { protect: ['.env'] } },
      });
      pathGuardPlugin.setup(api as never);
      const result = await hookOf(api)({
        toolName: 'format',
        toolInput: { files, check: false },
        toolCapabilities: ['fs.write'],
      });
      expect(result?.decision).toBe('block');
    },
  );

  it('blocks partial-segment directory scopes that can contain a protected basename', async () => {
    const api = makeApi({
      extensions: { 'path-guard': { protect: ['.env*'] } },
    });
    pathGuardPlugin.setup(api as never);
    const result = await hookOf(api)({
      toolName: 'format',
      toolInput: { files: 'src/foo*', check: false },
      toolCapabilities: ['fs.write'],
    });
    expect(result?.decision).toBe('block');
  });

  it('blocks prefixed write globs that can reach an unrooted protected scope', async () => {
    const api = makeApi({
      extensions: { 'path-guard': { protect: ['**/migrations/**'] } },
    });
    pathGuardPlugin.setup(api as never);
    const result = await hookOf(api)({
      toolName: 'replace',
      toolInput: {
        pattern: 'old',
        replacement: 'new',
        files: 'src/**',
        dry_run: false,
      },
      toolCapabilities: ['fs.write'],
    });
    expect(result?.decision).toBe('block');
  });

  it('allows an unresolved glob write scope explicitly exempted by allow', async () => {
    const api = makeApi({
      extensions: {
        'path-guard': { protect: ['**/migrations/**'], allow: ['generated/**/*.sql'] },
      },
    });
    pathGuardPlugin.setup(api as never);
    expect(
      await hookOf(api)({
        toolName: 'replace',
        toolInput: {
          pattern: 'old',
          replacement: 'new',
          files: 'generated/**/*.sql',
          dry_run: false,
        },
        toolCapabilities: ['fs.write'],
      }),
    ).toBeUndefined();
  });

  it('allows a narrower write scope contained by an allow subtree', async () => {
    const api = makeApi({
      extensions: {
        'path-guard': { protect: ['**/migrations/**'], allow: ['generated/**'] },
      },
    });
    pathGuardPlugin.setup(api as never);
    expect(
      await hookOf(api)({
        toolName: 'replace',
        toolInput: {
          pattern: 'old',
          replacement: 'new',
          files: 'generated/**/*.sql',
          dry_run: false,
        },
        toolCapabilities: ['fs.write'],
      }),
    ).toBeUndefined();
  });

  it('does not let an allow subtree exempt a wider partial-segment writer scope', async () => {
    const api = makeApi({
      extensions: {
        'path-guard': { protect: ['src/safeevil/**'], allow: ['src/safe/**'] },
      },
    });
    pathGuardPlugin.setup(api as never);
    const result = await hookOf(api)({
      toolName: 'format',
      toolInput: { files: 'src/safe*', check: false },
      toolCapabilities: ['fs.write'],
    });
    expect(result?.decision).toBe('block');
  });

  it('allows an identical leading-wildcard write scope explicitly exempted by allow', async () => {
    const api = makeApi({
      extensions: {
        'path-guard': { protect: ['**/migrations/**'], allow: ['**/*.sql'] },
      },
    });
    pathGuardPlugin.setup(api as never);
    expect(
      await hookOf(api)({
        toolName: 'replace',
        toolInput: {
          pattern: 'old',
          replacement: 'new',
          files: '**/*.sql',
          dry_run: false,
        },
        toolCapabilities: ['fs.write'],
      }),
    ).toBeUndefined();
  });

  it('blocks protected patch targets relative to the hook cwd when directory is omitted', async () => {
    const api = makeApi({
      extensions: { 'path-guard': { protect: ['db/migrations/001.sql'] } },
    });
    pathGuardPlugin.setup(api as never);
    const result = await hookOf(api)({
      toolName: 'patch',
      cwd: 'db',
      toolInput: {
        patch: '--- a/migrations/001.sql\n+++ b/migrations/001.sql\n@@ -1 +1 @@\n-old\n+new\n',
      },
      toolCapabilities: ['fs.write'],
    });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('db/migrations/001.sql');
  });

  it('blocks protected targets parsed from a unified diff relative to directory', async () => {
    const api = makeApi({
      extensions: { 'path-guard': { protect: ['**/migrations/**'] } },
    });
    pathGuardPlugin.setup(api as never);
    const result = await hookOf(api)({
      toolName: 'patch',
      toolInput: {
        directory: 'db',
        patch: '--- a/migrations/001.sql\n+++ b/migrations/001.sql\n@@ -1 +1 @@\n-old\n+new\n',
      },
      toolCapabilities: ['fs.write'],
    });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('db/migrations/001.sql');
  });

  it('parses unquoted patch paths with spaces through the tab separator', async () => {
    const api = makeApi();
    pathGuardPlugin.setup(api as never);
    const result = await hookOf(api)({
      toolName: 'patch',
      toolInput: {
        patch:
          '--- a/my dir/.env\t2026-08-06\n+++ b/my dir/.env\t2026-08-06\n@@ -1 +1 @@\n-old\n+new\n',
      },
      toolCapabilities: ['fs.write'],
    });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('my dir/.env');
  });

  it('parses GNU space-delimited patch timestamps without truncating path spaces', async () => {
    const api = makeApi();
    pathGuardPlugin.setup(api as never);
    const result = await hookOf(api)({
      toolName: 'patch',
      toolInput: {
        patch:
          '--- a/my dir/.env 2026-08-06 10:00:00 +0000\n+++ b/my dir/.env 2026-08-06 10:01:00 +0000\n@@ -1 +1 @@\n-old\n+new\n',
      },
      toolCapabilities: ['fs.write'],
    });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('my dir/.env');
  });

  it('ignores header-like hunk body text that is not a file header pair', async () => {
    const api = makeApi();
    pathGuardPlugin.setup(api as never);
    const result = await hookOf(api)({
      toolName: 'patch',
      toolInput: {
        patch:
          '--- a/src/safe.txt\n+++ b/src/safe.txt\n@@ -1,2 +1,2 @@\n---- a/.env\n-+++ b/.env\n+safe\n',
      },
      toolCapabilities: ['fs.write'],
    });
    expect(result).toBeUndefined();
  });

  it('blocks a dotted directory source for a directory-oriented move tool', async () => {
    const api = makeApi({
      extensions: { 'path-guard': { protect: ['cache.v1/.env'] } },
    });
    pathGuardPlugin.setup(api as never);
    const result = await hookOf(api)({
      toolName: 'filesystem_move_directory',
      toolInput: { source: 'cache.v1', destination: 'archive/cache.v1' },
      toolCapabilities: ['fs.write'],
    });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('write scope "cache.v1"');
  });

  it.each([
    { source: 'db', protect: ['db/migrations/**'], expectedScope: 'db' },
    { source: '*.env', protect: ['.env'], expectedScope: '*.env' },
  ])(
    'blocks an MCP move_file source scope that overlaps protected paths: $source',
    async ({ source, protect, expectedScope }) => {
      const api = makeApi({ extensions: { 'path-guard': { protect } } });
      pathGuardPlugin.setup(api as never);
      const result = await hookOf(api)({
        toolName: 'mcp__filesystem__move_file',
        toolInput: { source, destination: 'archive' },
        toolCapabilities: ['mcp.proxy'],
        toolMutating: true,
      });
      expect(result?.decision).toBe('block');
      expect(result?.reason).toContain(`write scope "${expectedScope}"`);
    },
  );

  it('blocks the protected source of move and rename tools', async () => {
    const api = makeApi();
    pathGuardPlugin.setup(api as never);
    const result = await hookOf(api)({
      toolName: 'file_rename',
      toolInput: { from: '.env', destination: 'backup.env' },
      toolCapabilities: ['fs.write'],
    });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('.env');
  });

  it.each([
    { cwdInput: { cwd: 'db' }, hookCwd: undefined },
    { cwdInput: {}, hookCwd: 'db' },
  ])(
    'rebases protected move sources against the effective cwd: %j',
    async ({ cwdInput, hookCwd }) => {
      const api = makeApi({
        extensions: { 'path-guard': { protect: ['db/migrations/**'] } },
      });
      pathGuardPlugin.setup(api as never);
      const result = await hookOf(api)({
        toolName: 'file_rename',
        cwd: hookCwd,
        toolInput: { ...cwdInput, from: 'migrations/001.sql', destination: 'archive/001.sql' },
        toolCapabilities: ['fs.write'],
      });
      expect(result?.decision).toBe('block');
      expect(result?.reason).toContain('db/migrations/001.sql');
    },
  );

  it('recognizes camelCase move and rename tool names', async () => {
    const api = makeApi();
    pathGuardPlugin.setup(api as never);
    const result = await hookOf(api)({
      toolName: 'fileRename',
      toolInput: { from: '.env', destination: 'backup.env' },
      toolCapabilities: ['fs.write'],
    });
    expect(result?.decision).toBe('block');
  });

  it('checks explicit write targets even when a benign command field is present', async () => {
    const api = makeApi();
    pathGuardPlugin.setup(api as never);
    const result = await hookOf(api)({
      toolName: 'command_writer',
      toolInput: { command: 'echo safe', output_path: '.env' },
      toolCapabilities: ['fs.write'],
    });
    expect(result?.decision).toBe('block');
  });

  it('checks structured write targets after an unprotected destructive shell target', async () => {
    const api = makeApi();
    pathGuardPlugin.setup(api as never);
    const result = await hookOf(api)({
      toolName: 'command_writer',
      toolInput: { command: 'rm notes.txt', output_path: '.env' },
      toolCapabilities: ['shell.exec', 'fs.write'],
      toolMutating: true,
    });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('.env');
  });

  it.each(['bash', 'exec', 'shell'])(
    'keeps the legacy %s shell guard active despite incomplete capability metadata',
    async (toolName) => {
      const api = makeApi();
      pathGuardPlugin.setup(api as never);
      const result = await hookOf(api)({
        toolName,
        toolInput: { command: 'rm .env' },
        toolCapabilities: ['process.spawn'],
        toolMutating: true,
      });
      expect(result?.decision).toBe('block');
    },
  );

  it.each(['mcp_terminal', 'run_command'])(
    'blocks destructive commands from capability-declared %s runners',
    async (toolName) => {
      const api = makeApi();
      pathGuardPlugin.setup(api as never);
      const result = await hookOf(api)({
        toolName,
        toolInput: { command: 'rm .env' },
        toolCapabilities: ['shell.restricted'],
        toolMutating: true,
      });
      expect(result?.decision).toBe('block');
    },
  );

  it('blocks destructive commands from mutating wrappers with non-shell capabilities', async () => {
    const api = makeApi();
    pathGuardPlugin.setup(api as never);
    const result = await hookOf(api)({
      toolName: 'mcp.proxy',
      toolInput: { command: 'rm -f .env' },
      toolCapabilities: ['mcp.proxy'],
      toolMutating: true,
    });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('.env');
  });

  it('does not parse structured git subcommands as shell strings but guards their unknown write scope', async () => {
    const api = makeApi();
    pathGuardPlugin.setup(api as never);
    const result = await hookOf(api)({
      toolName: 'git',
      toolInput: { command: 'rm .env' },
      toolCapabilities: ['fs.write', 'shell.restricted'],
      toolMutating: true,
    });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('write scope "." may include a protected path');
  });

  it('continues from shell parsing into path inspection for dual-capability writers', async () => {
    const api = makeApi();
    pathGuardPlugin.setup(api as never);
    const hook = hookOf(api);
    expect(
      await hook({
        toolName: 'command_writer',
        toolInput: { command: 'rm src/safe.txt' },
        toolCapabilities: ['shell.restricted', 'fs.write'],
        toolMutating: true,
      }),
    ).toBeUndefined();

    const result = await hook({
      toolName: 'command_writer',
      toolInput: { command: 'rm src/safe.txt', output_path: '.env' },
      toolCapabilities: ['shell.restricted', 'fs.write'],
      toolMutating: true,
    });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('.env');
  });

  it('does not parse command-shaped data from a non-shell tool', async () => {
    const api = makeApi();
    pathGuardPlugin.setup(api as never);
    const result = await hookOf(api)({
      toolName: 'command_reader',
      toolInput: { command: 'rm .env' },
      toolCapabilities: ['fs.read'],
      toolMutating: false,
    });
    expect(result).toBeUndefined();
  });

  it('blocks mutating git worktree paths using either supported field spelling', async () => {
    const api = makeApi({
      extensions: { 'path-guard': { protect: ['protected-worktrees/**'] } },
    });
    pathGuardPlugin.setup(api as never);
    const hook = hookOf(api);

    for (const toolInput of [
      { command: 'worktree', worktreeAction: 'add', worktreePath: 'protected-worktrees/new' },
      { command: 'worktree', worktreeAction: 'remove', worktree_path: 'protected-worktrees/old' },
    ]) {
      const result = await hook({
        toolName: 'git',
        toolInput,
        toolCapabilities: ['fs.write', 'shell.restricted'],
        toolMutating: true,
      });
      expect(result?.decision).toBe('block');
      expect(result?.reason).toContain('protected-worktrees');
    }
  });

  it('allows git commit pathspecs that name protected working-tree files', async () => {
    const api = makeApi();
    pathGuardPlugin.setup(api as never);
    const result = await hookOf(api)({
      toolName: 'git',
      toolInput: { command: 'commit', files: ['.env'] },
      toolCapabilities: ['fs.write', 'shell.restricted'],
      toolMutating: true,
    });
    expect(result).toBeUndefined();
  });

  it.each(['checkout', 'reset', 'stash'])(
    'blocks git %s when its pathspec names a protected working-tree file',
    async (command) => {
      const api = makeApi();
      pathGuardPlugin.setup(api as never);
      const result = await hookOf(api)({
        toolName: 'git',
        toolInput: { command, files: '.env' },
        toolCapabilities: ['fs.write', 'shell.restricted'],
        toolMutating: true,
      });
      expect(result?.decision).toBe('block');
      expect(result?.reason).toContain('.env');
    },
  );

  it.each(['src/index.ts', ['src/index.ts']])(
    'allows an unprotected git pathspec regardless of files serialization: %j',
    async (files) => {
      const api = makeApi();
      pathGuardPlugin.setup(api as never);
      const result = await hookOf(api)({
        toolName: 'git',
        toolInput: { command: 'checkout', files },
        toolCapabilities: ['fs.write', 'shell.restricted'],
        toolMutating: true,
      });
      expect(result).toBeUndefined();
    },
  );

  it('guards git branch checkout as a working-tree write scope', async () => {
    const api = makeApi();
    pathGuardPlugin.setup(api as never);
    const result = await hookOf(api)({
      toolName: 'git',
      toolInput: { command: 'checkout', branch: 'feature/path-guard' },
      toolCapabilities: ['fs.write', 'shell.restricted'],
      toolMutating: true,
    });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('write scope "." may include a protected path');
  });

  it.each(['checkout', 'reset', 'stash', 'pull', 'clean'])(
    'blocks files-less git %s because it can rewrite the repository root',
    async (command) => {
      const api = makeApi();
      pathGuardPlugin.setup(api as never);
      const result = await hookOf(api)({
        toolName: 'git',
        cwd: 'D:/work/repo',
        toolInput: { command },
        toolCapabilities: ['fs.write', 'shell.restricted'],
        toolMutating: true,
      });
      expect(result?.decision).toBe('block');
      expect(result?.reason).toContain('write scope "." may include a protected path');
    },
  );

  it('allows a benign shell command with production-shape metadata and an absolute cwd', async () => {
    const api = makeApi();
    pathGuardPlugin.setup(api as never);
    const result = await hookOf(api)({
      toolName: 'bash',
      cwd: 'D:/work/repo',
      toolInput: { command: 'echo safe' },
      toolCapabilities: ['shell.arbitrary'],
      toolMutating: true,
    });
    expect(result).toBeUndefined();
  });

  it('guards the cwd scope for mutating actions without a recognized target', async () => {
    const api = makeApi({
      extensions: { 'path-guard': { protect: ['protected-worktrees/**'] } },
    });
    pathGuardPlugin.setup(api as never);
    const result = await hookOf(api)({
      toolName: 'git',
      toolInput: {
        command: 'worktree',
        worktreeAction: 'prune',
        worktreePath: 'protected-worktrees/new',
      },
      toolCapabilities: ['fs.write', 'shell.restricted'],
      toolMutating: true,
    });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('write scope "." may include a protected path');
  });

  it('allows read-only actions of tools whose descriptor is broadly mutating', async () => {
    const api = makeApi();
    pathGuardPlugin.setup(api as never);
    const hook = hookOf(api);

    expect(
      await hook({
        toolName: 'git',
        toolInput: { command: 'status', files: '.env' },
        toolCapabilities: ['fs.write'],
        toolMutating: true,
      }),
    ).toBeUndefined();
    expect(
      await hook({
        toolName: 'design',
        toolInput: { action: 'verify', files: ['.env'] },
        toolCapabilities: ['fs.write'],
        toolMutating: true,
      }),
    ).toBeUndefined();
    expect(
      await hook({
        toolName: 'format',
        toolInput: { check: true, files: '.env' },
        toolCapabilities: ['fs.write'],
        toolMutating: true,
      }),
    ).toBeUndefined();
  });

  it('does not guard a tool explicitly declared read-only', async () => {
    const api = makeApi();
    pathGuardPlugin.setup(api as never);
    const result = await hookOf(api)({
      toolName: 'custom_reader',
      toolInput: { path: '.env' },
      toolCapabilities: ['fs.read'],
      toolMutating: false,
    });
    expect(result).toBeUndefined();
  });

  it('says nothing about a read-only tool that names a protected path', async () => {
    const api = makeApi();
    pathGuardPlugin.setup(api as never);
    // Reading `.env` is secret-scanner's and injection-shield's business.
    // Blocking it here would make the plugin unusable.
    const result = await hookOf(api)({
      toolName: 'read',
      toolInput: { path: '.env' },
      toolCapabilities: ['fs.read'],
    });
    expect(result).toBeUndefined();
  });

  it('still guards built-in writers on a host that declares nothing', async () => {
    // A security plugin with failurePolicy: 'closed' must not become a no-op
    // against a host older than the capability fields.
    const api = makeApi();
    pathGuardPlugin.setup(api as never);
    expect(
      (await hookOf(api)({ toolName: 'write', toolInput: { path: '.env.local' } }))?.decision,
    ).toBe('block');
    expect(
      (
        await hookOf(api)({
          toolName: 'patch',
          toolInput: { patch: '--- a/.env\n+++ b/.env\n@@ -1 +1 @@\n-old\n+new\n' },
        })
      )?.decision,
    ).toBe('block');
    expect(
      (await hookOf(api)({ toolName: 'design', toolInput: { action: 'materialize', out: '.env' } }))
        ?.decision,
    ).toBe('block');
  });

  it('guards the cwd scope for an unfamiliar writer target shape', async () => {
    const api = makeApi();
    pathGuardPlugin.setup(api as never);
    const result = await hookOf(api)({
      toolName: 'odd_writer',
      toolInput: { whereverItGoes: 'pnpm-lock.yaml' },
      toolCapabilities: ['fs.write'],
    });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('write scope "." may include a protected path');
  });

  it.each([
    'echo secret >| .env',
    'sudo --user=root rm .env',
    'sudo --group root rm .env',
    'env -u VAR rm .env',
    'env --unset VAR rm .env',
    'git rm .env',
    'git restore src',
    'git restore --pathspec-from-file=paths.txt',
    'git checkout -- src',
    'git checkout -- .env',
    'cat <<EOF > fix.sh\nrm .env\nEOF\nbash fix.sh',
  ])('blocks protected paths through shell parser hardening: %s', async (command) => {
    const api = makeApi();
    pathGuardPlugin.setup(api as never);
    expect((await hookOf(api)({ toolName: 'bash', toolInput: { command } }))?.decision).toBe(
      'block',
    );
  });

  it.each(['git rm --cached .env', 'git restore --staged .env', 'git clean -nd'])(
    'allows non-working-tree Git operations: %s',
    async (command) => {
      const api = makeApi();
      pathGuardPlugin.setup(api as never);
      expect(await hookOf(api)({ toolName: 'bash', toolInput: { command } })).toBeUndefined();
    },
  );

  it('guards metadata-less built-in installs on legacy hosts', async () => {
    const api = makeApi();
    pathGuardPlugin.setup(api as never);
    const result = await hookOf(api)({
      toolName: 'install',
      toolInput: { packages: 'example' },
    });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('write scope "." may include a protected path');
  });

  it('detects a project-local symlink whose realpath escaped (issue #365)', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-guard-symlink-'));
    const original = process.cwd();
    try {
      process.chdir(dir);
      const outside = path.join(os.tmpdir(), `path-guard-outside-${Date.now()}`);
      fs.writeFileSync(outside, 'secret', 'utf8');
      try {
        fs.symlinkSync(outside, path.join(dir, 'innocent.txt'));
      } catch {
        return; // platform cannot create symlinks without elevation
      }
      expect(isSymlinkEscape('innocent.txt')).toBe(true);
    } finally {
      process.chdir(original);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('setup() twice unregisters the first hook (H1 reload, issue #365)', () => {
    const first = vi.fn();
    const second = vi.fn();
    const api = makeApi();
    api.registerHook.mockReturnValueOnce(first).mockReturnValueOnce(second);
    pathGuardPlugin.setup(api as never);
    pathGuardPlugin.setup(api as never);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  // Audit T-03 (2026-08-22): pin the full no-leak contract beyond the first
  // release — teardown must free the hook the CURRENT setup registered (not
  // the stale first one), and a second host's setup/teardown must never
  // disturb the first host's handles.
  it('teardown after re-setup releases the CURRENT hook; other hosts are isolated (audit T-03)', () => {
    const first = vi.fn();
    const second = vi.fn();
    const api = makeApi();
    api.registerHook.mockReturnValueOnce(first).mockReturnValueOnce(second);
    pathGuardPlugin.setup(api as never);
    pathGuardPlugin.setup(api as never);

    const other = makeApi();
    const otherOff = vi.fn();
    other.registerHook.mockReturnValueOnce(otherOff);
    pathGuardPlugin.setup(other as never);
    // Only the SAME api's re-setup released its own previous hook.
    expect(first).toHaveBeenCalledTimes(1);
    expect(otherOff).not.toHaveBeenCalled();

    // Teardown releases the live (second) registration exactly once — and
    // MUST NOT touch the other host's handle (cross-host isolation).
    pathGuardPlugin.teardown(api as never);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledTimes(1);
    expect(otherOff).not.toHaveBeenCalled();

    // The other host is untouched and released by its own teardown.
    pathGuardPlugin.teardown(other as never);
    expect(otherOff).toHaveBeenCalledTimes(1);

    // A second teardown after state deletion is a safe no-op.
    expect(() => pathGuardPlugin.teardown(api as never)).not.toThrow();
  });
});
