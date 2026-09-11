import { describe, expect, it } from 'vitest';
import {
  selectDesktopLauncherExecutable,
  stripDesktopLauncherArgs,
} from '../src/boot/short-circuit-desktop.js';

describe('desktop short-circuit', () => {
  it('strips the flag form before forwarding args to the desktop package', () => {
    expect(stripDesktopLauncherArgs(['--desktop', '--open'])).toEqual(['--open']);
  });

  it('strips the subcommand form before forwarding args to the desktop package', () => {
    expect(stripDesktopLauncherArgs(['desktop', '--inspect'])).toEqual(['--inspect']);
  });

  it('uses Node for the Electron launcher when the CLI is running under Bun', () => {
    expect(selectDesktopLauncherExecutable('C:\\tools\\bun.exe', true)).toBe('node');
    expect(selectDesktopLauncherExecutable('C:\\tools\\bun.exe', true, 'D:\\node\\node.exe')).toBe(
      'D:\\node\\node.exe',
    );
  });

  it('keeps the current executable outside Bun', () => {
    expect(selectDesktopLauncherExecutable('C:\\node\\node.exe', false)).toBe('C:\\node\\node.exe');
  });
});
