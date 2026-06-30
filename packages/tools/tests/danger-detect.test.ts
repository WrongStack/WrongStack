import { describe, expect, it } from 'vitest';
import { detectDanger } from '../src/_danger-detect.js';

describe('detectDanger — rm / rmdir recursive force', () => {
  it('flags `rm -rf ./build` as destructive (PR 1 narrow set)', () => {
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
    const r = detectDanger('bcdedit', ['/set', '{default}', 'bootstatuspolicy', 'ignoreallfailures']);
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

  it('does NOT flag `mkfs.foo` (unknown extension, but rule fires for any mkfs.*)', () => {
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

  it('returns level=safe for `python -c "print(1)"` (PR 1 does not gate -c)', () => {
    // NOTE: PR 1 deliberately does NOT flag `python -c`. That will be in
    // PR 2 (broader) under the network-exfil / exec-arbitrary-code set.
    // Documenting the behavior so a future reviewer sees the boundary.
    const r = detectDanger('python', ['-c', 'print(1)']);
    expect(r.level).toBe('safe');
  });

  it('returns level=safe for `cargo build`', () => {
    const r = detectDanger('cargo', ['build']);
    expect(r.level).toBe('safe');
  });
});
