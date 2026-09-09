import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveHqPasswordInput } from '../src/hq-server/secret-input.js';

describe('HQ password secret-file input', () => {
  let directory: string;
  let secretFile: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-secret-input-'));
    secretFile = path.join(directory, 'password');
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('reads an absolute Docker secret path and removes one final newline', async () => {
    await fs.writeFile(secretFile, '  long secret  \n');
    await expect(
      resolveHqPasswordInput({
        environment: { WRONGSTACK_HQ_PASSWORD_FILE: secretFile },
      }),
    ).resolves.toBe('  long secret  ');
  });

  it('keeps direct password behavior when no secret file is configured', async () => {
    await expect(
      resolveHqPasswordInput({ environment: { WRONGSTACK_HQ_PASSWORD: 'direct-secret' } }),
    ).resolves.toBe('direct-secret');
  });

  it('rejects ambiguous, relative, non-file and oversized sources', async () => {
    await fs.writeFile(secretFile, 'file-secret');
    await expect(
      resolveHqPasswordInput({
        explicitPassword: 'direct-secret',
        environment: { WRONGSTACK_HQ_PASSWORD_FILE: secretFile },
      }),
    ).rejects.toThrow('only one');
    await expect(
      resolveHqPasswordInput({ environment: { WRONGSTACK_HQ_PASSWORD_FILE: 'relative-secret' } }),
    ).rejects.toThrow('absolute path');
    await expect(
      resolveHqPasswordInput({ environment: { WRONGSTACK_HQ_PASSWORD_FILE: directory } }),
    ).rejects.toThrow('regular file');
    await fs.writeFile(secretFile, 'x'.repeat(4097));
    await expect(
      resolveHqPasswordInput({ environment: { WRONGSTACK_HQ_PASSWORD_FILE: secretFile } }),
    ).rejects.toThrow('4096 bytes');
  });
});
