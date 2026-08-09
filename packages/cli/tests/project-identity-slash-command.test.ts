import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SlashCommandContext } from '../src/slash-commands/command-context.js';
import { buildProjectCommand } from '../src/slash-commands/project.js';

describe('/project identity commands', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-project-slash-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function command(confirm?: SlashCommandContext['confirm']) {
    return buildProjectCommand({ projectRoot: root, confirm } as SlashCommandContext);
  }

  it.each(['REKEY   --force   --YES', 'rekey  -y'])(
    'parses rekey confirmation flags as whitespace-delimited tokens: %s',
    { timeout: 5000 },
    async (args) => {
      const result = await command().run(args);
      const saved = JSON.parse(
        await fs.readFile(path.join(root, '.wrongstack', 'project.json'), 'utf8'),
      ) as { projectId: string };

      expect(result?.message).toContain(saved.projectId);
      expect(result?.message).not.toContain('Unknown:');
    },
  );

  it('reports an interactive rejection as cancellation without flag guidance', {
    timeout: 5000,
  }, async () => {
    const confirm = vi.fn().mockResolvedValue(null);
    const result = await command(confirm).run('rekey');

    expect(confirm).toHaveBeenCalledOnce();
    expect(result?.message).toBe('Rekey cancelled.');
  });

  it('requests --yes only when no interactive confirmation is available', {
    timeout: 5000,
  }, async () => {
    const result = await command().run('rekey');

    expect(result?.message).toContain('requires confirmation');
    expect(result?.message).toContain('--yes');
  });
});
