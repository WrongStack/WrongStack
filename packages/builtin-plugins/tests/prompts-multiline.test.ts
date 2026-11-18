import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DefaultPromptStore } from '@wrongstack/core/storage';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildPromptsCommand } from '../src/prompts-command.js';

describe('/prompts multiline and indentation fidelity', () => {
  let dir: string;
  let store: DefaultPromptStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prompts-multiline-'));
    store = new DefaultPromptStore({ globalPrompts: dir } as never);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('preserves newlines and indentation across add, edit, and extend', async () => {
    let extendInput = '';
    const cmd = buildPromptsCommand(
      () => store,
      () => null,
      () =>
        ({
          complete: async (prompt: string) => {
            extendInput = prompt;
            return { text: 'Enhanced line 1\n  Enhanced line 2' };
          },
        }) as never,
    );

    const content = 'Step 1: Inspect\n  - check nullability\nStep 2: Verify';
    await cmd.run!(`add --tags review "Checklist" "${content}"`, {} as never);
    expect((await store.find('Checklist'))[0]?.content).toBe(content);

    const updated = 'Line A\n    Line B\nLine C';
    await cmd.run!(`edit "Checklist" ${updated}`, {} as never);
    expect((await store.find('Checklist'))[0]?.content).toBe(updated);

    await cmd.run!('extend "Checklist" Keep:\n- bullet 1\n- bullet 2', {} as never);
    expect(extendInput).toContain('Keep:\n- bullet 1\n- bullet 2');
  });
});
