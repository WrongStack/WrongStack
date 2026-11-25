import { describe, expect, it } from 'vitest';
import { hermeticPosixArgv } from '../src/bash-hermetic.js';

describe('hermeticPosixArgv (F2206)', () => {
  it('recognizes Windows backslash paths and .exe suffixes for bash/zsh/fish', () => {
    expect(hermeticPosixArgv('C:\\Program Files\\Git\\bin\\bash.exe')).toEqual([
      '--noprofile',
      '--norc',
      '-c',
    ]);
    expect(hermeticPosixArgv('/usr/bin/zsh')).toEqual(['-f', '-c']);
    expect(hermeticPosixArgv('/usr/bin/fish')).toEqual(['--no-config', '-c']);
  });
});
