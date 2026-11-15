import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createSystemPromptPreset,
  listSystemPromptPresets,
  readSystemPromptPreset,
} from '../../src/core/system-prompt-presets.js';

const temps: string[] = [];

afterEach(async () => {
  for (const dir of temps.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe('system-prompt-presets corrupt JSON resilience (F370)', () => {
  it('skips corrupt preset JSON files in listSystemPromptPresets and throws Invalid preset file on direct read', async () => {
    const fakeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'f370-'));
    temps.push(fakeDir);

    const created = await createSystemPromptPreset(
      fakeDir,
      'Valid Preset',
      'default',
      'You are helpful.',
    );
    const entries = await fs.readdir(fakeDir, { recursive: true });
    const createdRel = entries.find((e) => e.endsWith(`${created.id}.json`));
    expect(createdRel).toBeDefined();
    const corruptId = '11111111-1111-4111-8111-111111111111';
    const corruptPath = path.join(
      path.dirname(path.join(fakeDir, createdRel!)),
      `${corruptId}.json`,
    );
    await fs.writeFile(corruptPath, '{NOT_VALID_JSON', 'utf8');

    const listed = await listSystemPromptPresets(fakeDir);
    expect(listed.some((p) => p.id === created.id)).toBe(true);

    await expect(readSystemPromptPreset(fakeDir, corruptId)).rejects.toThrow(
      'Invalid preset file.',
    );
  });
});
