import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isInsideDirectory } from '../src/host-helpers.js';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('isInsideDirectory symlink containment', () => {
  it('blocks symlinks/junctions that escape root even for non-existent nested targets', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-fleet-sym-'));
    tempRoots.push(root);
    const checkout = path.join(root, 'checkout');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(checkout);
    fs.mkdirSync(outside);
    fs.symlinkSync(
      outside,
      path.join(checkout, 'sym'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    expect(isInsideDirectory(checkout, path.join(checkout, 'inside'))).toBe(true);
    expect(isInsideDirectory(checkout, path.join(checkout, 'sym', 'sub'))).toBe(false);
  });
});
