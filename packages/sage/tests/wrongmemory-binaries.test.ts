import { describe, expect, it } from 'vitest';
import { findWrongMemoryBinary, wrongMemoryInstallDir } from '../src/wrongmemory-binaries.js';

const win = (files: string[], env: NodeJS.ProcessEnv, daemonPath?: string) => ({
  daemonPath,
  env,
  platform: 'win32' as const,
  execPath: 'C:\\Users\\u\\.bun\\bin\\bun.exe',
  exists: (f: string) => files.includes(f),
});

describe('findWrongMemoryBinary', () => {
  const local = 'C:\\Users\\u\\AppData\\Local';
  const installed = `${local}\\WrongMemory\\bin`;

  it('finds the standard per-user install', () => {
    const files = [`${installed}\\wrongmemoryd.exe`, `${installed}\\wrongmemory.exe`];
    expect(findWrongMemoryBinary('daemon', win(files, { LOCALAPPDATA: local }))).toEqual({
      path: `${installed}\\wrongmemoryd.exe`,
      source: 'installed',
    });
    expect(findWrongMemoryBinary('cli', win(files, { LOCALAPPDATA: local }))?.path).toBe(
      `${installed}\\wrongmemory.exe`,
    );
    expect(wrongMemoryInstallDir({ LOCALAPPDATA: local }, 'win32')).toBe(installed);
  });

  it('prefers the configured path, then the environment, over the install', () => {
    const files = [
      'D:\\wm\\wrongmemoryd.exe',
      'D:\\wm\\wrongmemory.exe',
      'E:\\env\\wrongmemoryd.exe',
      `${installed}\\wrongmemoryd.exe`,
    ];
    const env = { LOCALAPPDATA: local, WRONGMEMORYD_PATH: 'E:\\env\\wrongmemoryd.exe' };
    expect(findWrongMemoryBinary('daemon', win(files, env, 'D:\\wm\\wrongmemoryd.exe'))).toEqual({
      path: 'D:\\wm\\wrongmemoryd.exe',
      source: 'config',
    });
    expect(findWrongMemoryBinary('cli', win(files, env, 'D:\\wm\\wrongmemoryd.exe'))?.path).toBe(
      'D:\\wm\\wrongmemory.exe',
    );
    expect(findWrongMemoryBinary('daemon', win(files, env))?.source).toBe('env');
  });

  it('never looks next to the Bun runtime unless the file is there, then falls back to PATH', () => {
    const files = ['C:\\tools\\wrongmemoryd.exe'];
    const env = { LOCALAPPDATA: local, PATH: 'C:\\Windows;C:\\tools' };
    expect(findWrongMemoryBinary('daemon', win(files, env))).toEqual({
      path: 'C:\\tools\\wrongmemoryd.exe',
      source: 'path',
    });
    expect(findWrongMemoryBinary('daemon', win([], env))).toBeUndefined();
  });
});
