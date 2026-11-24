import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearLocalBinCache, resolveNodeBin } from '../src/runtime/index.js';

let base: string;
let projectRoot: string;
let outsidePackage: string;

async function writePackage(directory: string, name: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, 'package.json'),
    JSON.stringify({ name, version: '1.0.0', bin: { [name]: 'cli.js' } }),
  );
  await fs.writeFile(path.join(directory, 'cli.js'), 'process.stdout.write("fixture");');
}

beforeEach(async () => {
  clearLocalBinCache();
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-sdk-bin-scope-')));
  projectRoot = path.join(base, 'project');
  outsidePackage = path.join(base, 'outside-cli');
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.writeFile(path.join(projectRoot, 'package.json'), '{}');
  await writePackage(path.join(projectRoot, 'node_modules', 'local-cli'), 'local-cli');
  await writePackage(outsidePackage, 'outside-cli');
});

afterEach(async () => {
  clearLocalBinCache();
  if (base) await fs.rm(base, { recursive: true, force: true });
});

describe('resolveNodeBin package-name boundary', () => {
  it('resolves an installed project-local package', () => {
    expect(resolveNodeBin('local-cli', 'local-cli', projectRoot)).toMatchObject({
      cmd: process.execPath,
      entry: path.join(projectRoot, 'node_modules', 'local-cli', 'cli.js'),
    });
  });

  it('rejects relative traversal and absolute paths before Node can resolve them', () => {
    expect(resolveNodeBin('../outside-cli', 'outside-cli', projectRoot)).toBeNull();
    expect(resolveNodeBin(outsidePackage, 'outside-cli', projectRoot)).toBeNull();
  });
});
