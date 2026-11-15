import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { saveProjectSkillAugmentation } from '@wrongstack/agent-catalog';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveHostSubagentSkillResolution } from '../src/host-context.js';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('resolveHostSubagentSkillResolution prototype safety', () => {
  it('delivers addendumOnly for skills named after Object.prototype keys', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-fleet-proto-'));
    tempRoots.push(root);
    const role = 'test-role';
    saveProjectSkillAugmentation(role, 'constructor', 'Always inspect constructor safely.', root);

    const skillNames = ['s1', 's2', 's3', 's4', 's5', 's6', 'constructor'];
    const deps = {
      projectRoot: root,
      cwd: root,
      skillLoader: {
        find: async (name: string) => ({
          name,
          description: `desc ${name}`,
          requiredCapabilities: name === 'constructor' ? ['filesystem.write'] : [],
          requiredTools: name === 'constructor' ? ['write_file'] : [],
        }),
        readSaveBody: async (name: string) => `body ${name}`,
      },
    } as never;

    const report = await resolveHostSubagentSkillResolution(
      deps,
      { [role]: { name: role, role, skillPool: skillNames } as never },
      { name: role, role } as never,
      [],
    );
    expect(report.addendumOnly).toContain('constructor');
  });
});
