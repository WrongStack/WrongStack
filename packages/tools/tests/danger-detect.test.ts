import { describe, expect, it } from 'vitest';
import { detectDanger } from '../src/_danger-detect.js';

describe('detectDanger — rm / rmdir recursive force', () => {
  it('flags `rm -rf ./build` as destructive', () => {
    const r = detectDanger('rm', ['-rf', './build']);
    expect(r.level).toBe('destructive');
    expect(r.reasons).toContain('recursive force-delete');
    expect(r.matchedRule).toBe('rm-recursive');
  });

  it('flags `rm -fr ./build` (alternative flag order) as destructive', () => {
    const r = detectDanger('rm', ['-fr', './build']);
    expect(r.level).toBe('destructive');
  });

  it('flags `rm -r -f ./build` (split flags) as destructive', () => {
    const r = detectDanger('rm', ['-r', '-f', './build']);
    expect(r.level).toBe('destructive');
  });

  it('does NOT flag `rm ./build` (no recursive)', () => {
    const r = detectDanger('rm', ['./build']);
    expect(r.level).toBe('safe');
  });

  it('does NOT flag `rm -r ./build` (no force)', () => {
    const r = detectDanger('rm', ['-r', './build']);
    expect(r.level).toBe('safe');
  });

  it('does NOT flag `ls -rf /` (not the rm binary)', () => {
    const r = detectDanger('ls', ['-rf', '/']);
    expect(r.level).toBe('safe');
  });
});

describe('detectDanger — PowerShell Remove-Item -Recurse -Force', () => {
  it('flags `powershell Remove-Item -Recurse -Force foo` as destructive', () => {
    const r = detectDanger('powershell', ['Remove-Item', '-Recurse', '-Force', 'foo']);
    expect(r.level).toBe('destructive');
    expect(r.matchedRule).toBe('powershell-remove-item-recursive-force');
  });

  it('flags `pwsh -Command "Remove-Item -R -F foo"` as destructive', () => {
    const r = detectDanger('pwsh', ['-Command', 'Remove-Item', '-R', '-F', 'foo']);
    expect(r.level).toBe('destructive');
  });

  it('does NOT flag `powershell Remove-Item -WhatIf -Recurse -Force foo` (dry-run)', () => {
    const r = detectDanger('powershell', ['Remove-Item', '-WhatIf', '-Recurse', '-Force', 'foo']);
    expect(r.level).toBe('safe');
  });

  it('does NOT flag `powershell Get-ChildItem -Recurse` (different verb)', () => {
    const r = detectDanger('powershell', ['Get-ChildItem', '-Recurse']);
    expect(r.level).toBe('safe');
  });
});

describe('detectDanger — find -exec / -ok', () => {
  it('flags `find . -exec rm {} ;` as destructive', () => {
    const r = detectDanger('find', ['.', '-exec', 'rm', '{}', ';']);
    expect(r.level).toBe('destructive');
  });

  it('flags `find . -ok echo` as destructive', () => {
    const r = detectDanger('find', ['.', '-ok', 'echo']);
    expect(r.level).toBe('destructive');
  });

  it('flags `find . -execdir rm` as destructive', () => {
    const r = detectDanger('find', ['.', '-execdir', 'rm']);
    expect(r.level).toBe('destructive');
  });

  it('does NOT flag `find . -name "*.tmp"` (no -exec)', () => {
    const r = detectDanger('find', ['.', '-name', '*.tmp']);
    expect(r.level).toBe('safe');
  });
});

describe('detectDanger — git --exec/--upload-pack/--receive-pack', () => {
  it('flags `git --exec=foo fetch` as destructive', () => {
    const r = detectDanger('git', ['--exec=foo', 'fetch']);
    expect(r.level).toBe('destructive');
  });

  it('flags `git --upload-pack=evil` as destructive', () => {
    const r = detectDanger('git', ['--upload-pack=evil']);
    expect(r.level).toBe('destructive');
  });

  it('does NOT flag `git status`', () => {
    const r = detectDanger('git', ['status']);
    expect(r.level).toBe('safe');
  });
});

describe('detectDanger — Windows format / diskpart / bcdedit', () => {
  it('flags `format C:` as destructive', () => {
    const r = detectDanger('format', ['C:']);
    expect(r.level).toBe('destructive');
    expect(r.matchedRule).toBe('win32-format');
  });

  it('flags `format.exe C: /q` as destructive', () => {
    const r = detectDanger('format.exe', ['C:', '/q']);
    expect(r.level).toBe('destructive');
  });

  it('flags `diskpart` with no args as destructive', () => {
    const r = detectDanger('diskpart', []);
    expect(r.level).toBe('destructive');
  });

  it('flags `bcdedit /set` as destructive', () => {
    const r = detectDanger('bcdedit', [
      '/set',
      '{default}',
      'bootstatuspolicy',
      'ignoreallfailures',
    ]);
    expect(r.level).toBe('destructive');
  });
});

describe('detectDanger — mkfs family', () => {
  it('flags `mkfs.ext4 /dev/sda1` as destructive', () => {
    const r = detectDanger('mkfs.ext4', ['/dev/sda1']);
    expect(r.level).toBe('destructive');
  });

  it('flags `mkfs` (no extension) as destructive', () => {
    const r = detectDanger('mkfs', ['/dev/sda1']);
    expect(r.level).toBe('destructive');
  });

  it('flags `mkswap /dev/sda2` as destructive', () => {
    const r = detectDanger('mkswap', ['/dev/sda2']);
    expect(r.level).toBe('destructive');
  });

  it('flags `mkfs.typo` (unknown extension still matches the general pattern)', () => {
    // The regex /^mkfs(\.[a-z0-9]+)?$/ matches mkfs followed by optional ext,
    // so even an unknown extension triggers. This is intentional: a typo'd
    // filesystem type is a dangerous mistake.
    const r = detectDanger('mkfs.typo', ['/dev/sda1']);
    expect(r.level).toBe('destructive');
  });
});

describe('detectDanger — dd writing to a block device', () => {
  it('flags `dd if=foo of=/dev/sda` as destructive', () => {
    const r = detectDanger('dd', ['if=foo.img', 'of=/dev/sda']);
    expect(r.level).toBe('destructive');
  });

  it('flags `dd of=/dev/nvme0n1` as destructive', () => {
    const r = detectDanger('dd', ['of=/dev/nvme0n1']);
    expect(r.level).toBe('destructive');
  });

  it('does NOT flag `dd if=/dev/urandom of=output.bin` (writing to a file)', () => {
    const r = detectDanger('dd', ['if=/dev/urandom', 'of=output.bin', 'bs=1M', 'count=10']);
    expect(r.level).toBe('safe');
  });
});

describe('detectDanger — secure-erase tools', () => {
  it('flags `shred secret.txt` as destructive', () => {
    const r = detectDanger('shred', ['secret.txt']);
    expect(r.level).toBe('destructive');
  });

  it('flags `wipefs /dev/sda1` as destructive', () => {
    const r = detectDanger('wipefs', ['/dev/sda1']);
    expect(r.level).toBe('destructive');
  });

  it('flags `sdelete -p 3 secret.txt` as destructive', () => {
    const r = detectDanger('sdelete', ['-p', '3', 'secret.txt']);
    expect(r.level).toBe('destructive');
  });
});

describe('detectDanger — safe baseline (regression)', () => {
  it('returns level=safe for `git status`', () => {
    const r = detectDanger('git', ['status']);
    expect(r.level).toBe('safe');
    expect(r.reasons).toEqual([]);
    expect(r.matchedRule).toBeUndefined();
  });

  it('returns level=safe for `npm test`', () => {
    const r = detectDanger('npm', ['test']);
    expect(r.level).toBe('safe');
  });

  it('returns level=caution for `python -c "print(1)"` (inline-eval)', () => {
    const r = detectDanger('python', ['-c', 'print(1)']);
    expect(r.level).toBe('caution');
    expect(r.matchedRule).toBe('inline-eval');
  });

  it('returns level=safe for `cargo build`', () => {
    const r = detectDanger('cargo', ['build']);
    expect(r.level).toBe('safe');
  });
});

describe('detectDanger — git push --force / -f', () => {
  it('flags `git push --force origin main` as destructive', () => {
    const r = detectDanger('git', ['push', '--force', 'origin', 'main']);
    expect(r.level).toBe('destructive');
    expect(r.matchedRule).toBe('git-push-force');
  });

  it('flags `git push -f` (short form) as destructive', () => {
    const r = detectDanger('git', ['push', '-f']);
    expect(r.level).toBe('destructive');
  });

  it('flags `git push --force-with-lease` as destructive (still rewrites)', () => {
    const r = detectDanger('git', ['push', '--force-with-lease', 'origin', 'main']);
    expect(r.level).toBe('destructive');
  });

  it('does NOT flag `git push origin main` (no force flag)', () => {
    const r = detectDanger('git', ['push', 'origin', 'main']);
    expect(r.level).toBe('safe');
  });

  it('does NOT flag `git status --force` (--force belongs to a different verb)', () => {
    // The rule looks for the `push` subcommand first; `status` is unrelated.
    const r = detectDanger('git', ['status', '--force']);
    expect(r.level).toBe('safe');
  });
});

describe('detectDanger — git reset --hard', () => {
  it('flags `git reset --hard HEAD~1` as destructive', () => {
    const r = detectDanger('git', ['reset', '--hard', 'HEAD~1']);
    expect(r.level).toBe('destructive');
    expect(r.matchedRule).toBe('git-reset-hard');
  });

  it('flags `git reset --hard=foo` (rare `--key=value` form) as destructive', () => {
    const r = detectDanger('git', ['reset', '--hard=foo']);
    expect(r.level).toBe('destructive');
  });

  it('does NOT flag `git reset --soft HEAD~1` (soft, recoverable)', () => {
    const r = detectDanger('git', ['reset', '--soft', 'HEAD~1']);
    expect(r.level).toBe('safe');
  });

  it('does NOT flag `git reset HEAD~1` (mixed reset, no --hard)', () => {
    const r = detectDanger('git', ['reset', 'HEAD~1']);
    expect(r.level).toBe('safe');
  });
});

describe('detectDanger — git clean -f', () => {
  it('flags `git clean -fd` as destructive', () => {
    const r = detectDanger('git', ['clean', '-fd']);
    expect(r.level).toBe('destructive');
    expect(r.matchedRule).toBe('git-clean-force');
  });

  it('flags `git clean -f` (no -d) as destructive', () => {
    const r = detectDanger('git', ['clean', '-f']);
    expect(r.level).toBe('destructive');
  });

  it('flags `git clean --force` as destructive', () => {
    const r = detectDanger('git', ['clean', '--force']);
    expect(r.level).toBe('destructive');
  });

  it('does NOT flag `git clean -n` (dry-run, no force)', () => {
    const r = detectDanger('git', ['clean', '-n']);
    expect(r.level).toBe('safe');
  });

  it('does NOT flag `git status` (different verb)', () => {
    const r = detectDanger('git', ['status']);
    expect(r.level).toBe('safe');
  });
});

describe('detectDanger — package publish', () => {
  it('flags `npm publish` as destructive', () => {
    const r = detectDanger('npm', ['publish']);
    expect(r.level).toBe('destructive');
    expect(r.matchedRule).toBe('npm-publish');
  });

  it('flags `pnpm publish --tag beta` as destructive', () => {
    const r = detectDanger('pnpm', ['publish', '--tag', 'beta']);
    expect(r.level).toBe('destructive');
  });

  it('flags `cargo publish --allow-dirty` as destructive', () => {
    const r = detectDanger('cargo', ['publish', '--allow-dirty']);
    expect(r.level).toBe('destructive');
  });

  it('flags `cargo yank --version 1.0.0` as destructive (treats as publish-class)', () => {
    const r = detectDanger('cargo', ['yank', '--version', '1.0.0']);
    expect(r.level).toBe('destructive');
  });

  it('does NOT flag `npm install` (no publish subcommand)', () => {
    const r = detectDanger('npm', ['install']);
    expect(r.level).toBe('safe');
  });

  it('does NOT flag `cargo build` (no publish subcommand)', () => {
    const r = detectDanger('cargo', ['build']);
    expect(r.level).toBe('safe');
  });
});

describe('detectDanger — kubectl delete namespace / drain', () => {
  it('flags `kubectl delete namespace foo` as destructive', () => {
    const r = detectDanger('kubectl', ['delete', 'namespace', 'foo']);
    expect(r.level).toBe('destructive');
    expect(r.matchedRule).toBe('kubectl-delete-namespace');
  });

  it('flags `kubectl delete ns foo` (short form) as destructive', () => {
    const r = detectDanger('kubectl', ['delete', 'ns', 'foo']);
    expect(r.level).toBe('destructive');
  });

  it('flags `kubectl drain node1` as destructive', () => {
    const r = detectDanger('kubectl', ['drain', 'node1']);
    expect(r.level).toBe('destructive');
    expect(r.matchedRule).toBe('kubectl-drain');
  });

  it('does NOT flag `kubectl delete pod foo` (too common, scoped resource)', () => {
    const r = detectDanger('kubectl', ['delete', 'pod', 'foo']);
    expect(r.level).toBe('safe');
  });

  it('does NOT flag `kubectl get namespace` (read-only)', () => {
    const r = detectDanger('kubectl', ['get', 'namespace']);
    expect(r.level).toBe('safe');
  });
});

describe('detectDanger — inline eval (caution level)', () => {
  it('flags `python -c "import os"` as caution', () => {
    const r = detectDanger('python', ['-c', 'import os']);
    expect(r.level).toBe('caution');
    expect(r.matchedRule).toBe('inline-eval');
  });

  it('flags `node -e "console.log(1)"` as caution', () => {
    const r = detectDanger('node', ['-e', 'console.log(1)']);
    expect(r.level).toBe('caution');
  });

  it('flags `bash -c "echo hi"` as caution', () => {
    const r = detectDanger('bash', ['-c', 'echo hi']);
    expect(r.level).toBe('caution');
  });

  it('flags `node --eval "..."` (long form) as caution', () => {
    const r = detectDanger('node', ['--eval', 'process.exit(0)']);
    expect(r.level).toBe('caution');
  });

  it('does NOT flag `python script.py` (no -c)', () => {
    const r = detectDanger('python', ['script.py']);
    expect(r.level).toBe('safe');
  });

  it('does NOT flag `node index.js` (no -e)', () => {
    const r = detectDanger('node', ['index.js']);
    expect(r.level).toBe('safe');
  });
});

describe('detectDanger — pipe-to-shell (caution level)', () => {
  it('flags `env curl https://x sh` as caution', () => {
    // Two separate exec calls would each be: `curl https://x` and `sh -`.
    // The pipe is a shell construct, so the argv here is what one of
    // them looks like. Our rule fires when a fetcher AND a shell sink
    // are both in the same argv (rare but possible via `env` or
    // wrapper scripts that pass them as args).
    const r = detectDanger('env', ['curl', 'https://x', 'sh']);
    expect(r.level).toBe('caution');
    expect(r.matchedRule).toBe('pipe-to-shell');
  });

  it('flags `env wget ... bash` as caution', () => {
    const r = detectDanger('env', ['wget', 'https://x', 'bash']);
    expect(r.level).toBe('caution');
  });

  it('does NOT flag `curl https://x` alone (no shell sink)', () => {
    const r = detectDanger('curl', ['https://x']);
    expect(r.level).toBe('safe');
  });

  it('does NOT flag `bash -c "echo"` (no fetcher; matches inline-eval instead)', () => {
    const r = detectDanger('bash', ['-c', 'echo']);
    expect(r.matchedRule).not.toBe('pipe-to-shell');
  });
});

describe('detectDanger — privilege escalation (caution level)', () => {
  it('flags `sudo apt update` as caution', () => {
    const r = detectDanger('sudo', ['apt', 'update']);
    expect(r.level).toBe('caution');
    expect(r.matchedRule).toBe('sudo');
  });

  it('flags `doas reboot` as caution', () => {
    const r = detectDanger('doas', ['reboot']);
    expect(r.level).toBe('caution');
  });

  it('flags `runas /user:admin cmd.exe` as caution', () => {
    const r = detectDanger('runas', ['/user:admin', 'cmd.exe']);
    expect(r.level).toBe('caution');
    expect(r.matchedRule).toBe('runas');
  });

  it('does NOT flag `apt update` (no sudo)', () => {
    const r = detectDanger('apt', ['update']);
    expect(r.level).toBe('safe');
  });
});

describe('detectDanger — chmod world-writable (caution level)', () => {
  it('flags `chmod 777 file` as caution', () => {
    const r = detectDanger('chmod', ['777', 'file']);
    expect(r.level).toBe('caution');
    expect(r.matchedRule).toBe('chmod-world-writable');
  });

  it('flags `chmod 0644 file` as safe (no 7)', () => {
    const r = detectDanger('chmod', ['0644', 'file']);
    expect(r.level).toBe('safe');
  });

  it('flags `chmod 755 dir` as caution (group is 5 but other is 7)', () => {
    const r = detectDanger('chmod', ['755', 'dir']);
    expect(r.level).toBe('caution');
  });

  it('does NOT flag `chmod +x file` (symbolic mode)', () => {
    const r = detectDanger('chmod', ['+x', 'file']);
    expect(r.level).toBe('safe');
  });

  it('does NOT flag `chmod u+w file` (symbolic, scoped)', () => {
    const r = detectDanger('chmod', ['u+w', 'file']);
    expect(r.level).toBe('safe');
  });
});

describe('detectDanger — multi-rule interaction', () => {
  it('returns the higher level when multiple rules fire', () => {
    // `rm -rf curl sh` triggers both `rm-recursive` (destructive, matches
    // on cmd='rm' + the -rf flag) and `pipe-to-shell` (caution, matches on
    // a fetcher token + a shell-sink token appearing anywhere in args,
    // regardless of cmd). The output should be 'destructive'.
    const r = detectDanger('rm', ['-rf', 'curl', 'sh']);
    expect(r.level).toBe('destructive');
    expect(r.reasons).toContain('recursive force-delete');
    expect(r.reasons).toContain('network fetch piped to a shell (download-and-run pattern)');
  });

  it('does not downgrade a destructive result', () => {
    const r = detectDanger('git', ['push', '--force', 'origin', 'main']);
    expect(r.level).toBe('destructive');
  });
});

describe('detectDanger — bypass argument', () => {
  it('skips a rule whose id is in the bypass set', () => {
    const bypass = new Set(['rm-recursive']);
    const r = detectDanger('rm', ['-rf', './build'], bypass);
    expect(r.level).toBe('safe');
    expect(r.reasons).toEqual([]);
    expect(r.matchedRule).toBeUndefined();
  });

  it('ignores unknown bypass ids (forward-compat: future rule can be referenced)', () => {
    const bypass = new Set(['this-rule-does-not-exist']);
    const r = detectDanger('rm', ['-rf', './build'], bypass);
    // Unknown bypass id should not affect anything; rm-recursive still fires.
    expect(r.level).toBe('destructive');
  });

  it('skips only the specified rule; other matched rules still fire', () => {
    // Bypass `rm-recursive` but keep `sudo` active. `sudo rm -rf /` then
    // has the destructive rule suppressed, leaving only the caution rule.
    const bypass = new Set(['rm-recursive']);
    const r = detectDanger('sudo', ['rm', '-rf', '/'], bypass);
    expect(r.level).toBe('caution');
    expect(r.reasons).toEqual(['privilege escalation (sudo / doas)']);
  });

  it('treats empty bypass the same as no bypass (default behavior)', () => {
    const emptyBypass = new Set<string>();
    const noBypass = undefined;
    const a = detectDanger('rm', ['-rf', './build'], emptyBypass);
    const b = detectDanger('rm', ['-rf', './build'], noBypass);
    expect(a).toEqual(b);
    expect(a.level).toBe('destructive');
  });

  it('bypasses a caution-level rule (e.g. inline-eval)', () => {
    const bypass = new Set(['inline-eval']);
    const r = detectDanger('python', ['-c', 'import os'], bypass);
    expect(r.level).toBe('safe');
  });

  it('does NOT silently suppress unmatched rules when bypass is provided', () => {
    // Bypass `rm-recursive`, but invoke a different destructive rule. The
    // bypass should not affect it.
    const bypass = new Set(['rm-recursive']);
    const r = detectDanger('git', ['push', '--force', 'origin', 'main'], bypass);
    expect(r.level).toBe('destructive');
    expect(r.matchedRule).toBe('git-push-force');
  });

  it('handles bypass with multiple ids', () => {
    const bypass = new Set(['rm-recursive', 'git-push-force', 'inline-eval']);
    const r1 = detectDanger('rm', ['-rf', 'foo'], bypass);
    const r2 = detectDanger('git', ['push', '--force'], bypass);
    const r3 = detectDanger('python', ['-c', 'evil'], bypass);
    expect(r1.level).toBe('safe');
    expect(r2.level).toBe('safe');
    expect(r3.level).toBe('safe');
  });
});
