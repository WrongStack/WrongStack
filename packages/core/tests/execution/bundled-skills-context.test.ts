import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DefaultSkillLoader,
  DefaultSystemPromptBuilder,
  resolveWstackPaths,
} from '../../src/index.js';
import { RUNTIME_CAPABILITY_MANIFEST } from '../../src/types/runtime-capability-manifest.js';
import type { Tool } from '../../src/types/tool.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundledDir = path.resolve(here, '..', '..', 'skills');
const operationalSkills = [
  'auto-review',
  'mailbox-bridge',
  'mnemosyne',
  'wrongstack-mailbox',
] as const;

describe('bundled operational skills → prompt context', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-bundled-context-'));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  function loader(): DefaultSkillLoader {
    const paths = resolveWstackPaths({
      projectRoot: path.join(tmp, 'project'),
      globalRoot: path.join(tmp, 'global'),
      userHome: tmp,
    });
    return new DefaultSkillLoader({ paths, bundledDir, foreignSources: false });
  }

  async function prompt(
    mode: 'eager' | 'progressive',
    skillEagerMaxChars = 1_000_000,
  ): Promise<string> {
    const skillLoader = loader();
    const requiredToolNames = [
      ...new Set(RUNTIME_CAPABILITY_MANIFEST.flatMap((capability) => capability.tools)),
    ];
    const tools: Tool[] = requiredToolNames.map((name) => ({
      name,
      description: '',
      inputSchema: { type: 'object' },
      permission: 'auto',
      mutating: false,
      async execute() {
        return 'ok';
      },
    }));
    const builder = new DefaultSystemPromptBuilder({
      todayIso: '2026-07-18',
      skillLoader,
      skillMode: mode,
      // Exercise the complete eager injection path without making this catalog
      // contract depend on the normal session-wide prompt budget.
      skillEagerMaxChars,
    });
    const blocks = await builder.build({
      cwd: path.join(tmp, 'project'),
      projectRoot: path.join(tmp, 'project'),
      tools,
    });
    return blocks.map((block) => block.text).join('\n');
  }

  it('discovers every operational skill from the bundled layer', async () => {
    const manifests = await loader().list();

    for (const name of operationalSkills) {
      expect(manifests.find((entry) => entry.name === name)).toMatchObject({
        name,
        source: 'bundled',
      });
    }

    const bundledNames = manifests
      .filter((entry) => entry.source === 'bundled')
      .map((entry) => entry.name);
    expect(bundledNames).toEqual([...bundledNames].sort());
  });

  it('injects their full instructions through the eager system-prompt path', async () => {
    const text = await prompt('eager');

    for (const name of operationalSkills) {
      expect(text).toContain(`**${name}**`);
      expect(text).toContain(`## Skill: ${name}`);
    }
    expect(text).toContain('Auto Review — Built-in Plugin');
    expect(text).toContain('Mnemosyne — SAGE Memory Custodian');
  });

  it('injects their deterministic name and trigger manifest in progressive mode', async () => {
    const text = await prompt('progressive');

    for (const name of operationalSkills) {
      expect(text).toContain(`**${name}**`);
      expect(text).toContain(`| \`${name}\` |`);
    }
    expect(text).toContain('Call the `skill` tool to load a skill before relying on it.');
    expect(text).not.toContain('## Skill: mnemosyne');
  });

  it('keeps every operational trigger in context when the eager body budget overflows', async () => {
    const text = await prompt('eager', 1);

    for (const name of operationalSkills) {
      expect(text).toContain(`**${name}**`);
      expect(text).toContain(`- ${name}`);
    }
    expect(text).toContain('Available skills (load with the `skill` tool)');
    expect(text).not.toContain('## Skill: mnemosyne');
  });
});
