import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DefaultSkillLoader } from '../../src/execution/skill-loader.js';
import { SKILL_LIMITS } from '../../src/skills/limits.js';
import { resolveWstackPaths } from '../../src/utils/wstack-paths.js';

/**
 * Fleet subagents and compact prompts receive an auto-compacted body for every
 * skill without a SKILL.save.md. The compactor used to slice at fixed character
 * offsets, so a subagent read things like "Checked stable Go target: 1.27.3 on
 * 2026" and "2. Pass the caller's `context.C…" — half an instruction is worse
 * than none. It also kept only the first physical line of a wrapped rule.
 *
 * Contract: whole sentences from the Overview, whole rule items (continuation
 * lines included), never above the compact total.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const bundledDir = path.resolve(here, '..', '..', 'skills');

describe('auto-compacted skill bodies', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-compact-'));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  function loader(bundled?: string): DefaultSkillLoader {
    return new DefaultSkillLoader({
      paths: resolveWstackPaths({
        projectRoot: path.join(tmp, 'project'),
        globalRoot: path.join(tmp, 'global'),
        userHome: tmp,
      }),
      bundledDir: bundled,
      foreignSources: false,
    });
  }

  async function writeSkill(body: string): Promise<DefaultSkillLoader> {
    const dir = path.join(tmp, 'bundled', 'demo');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'SKILL.md'), `---\nname: demo\ndescription: d\n---\n${body}`);
    return loader(path.join(tmp, 'bundled'));
  }

  it('keeps whole Overview sentences instead of cutting mid-sentence', async () => {
    const first =
      'Go services fail at lifetimes, not syntax: goroutines nobody waits for and contexts that never cancel.';
    const second =
      'Checked stable Go target: 1.27.3 on 2026-10-23, and the module directive decides semantics for every loop and timer.';
    const compact = await (
      await writeSkill(
        `## Overview\n\n${first}\n${second}\n\n## Rules\n\n1. Own every goroutine.\n`,
      )
    ).readSaveBody('demo');
    expect(compact).toContain(first);
    expect(compact).not.toContain('Checked stable Go target');
    expect(compact).toContain('1. Own every goroutine.');
  });

  it('keeps wrapped rule items whole and drops items that do not fit', async () => {
    const compact = await (
      await writeSkill(
        [
          '## Overview',
          '',
          'Short essence.',
          '',
          '## Rules',
          '',
          '1. Reproduce before fixing. Get a command, test, or input that shows the failure',
          '   on demand, then keep it as the regression proof.',
          `2. ${'Read the whole error and every cause line before forming a hypothesis. '.repeat(6)}`,
          '3. Change one thing at a time.',
        ].join('\n'),
      )
    ).readSaveBody('demo');
    expect(compact).toContain('on demand, then keep it as the regression proof.');
    expect(compact).not.toContain('2. Read the whole error');
    expect(compact).not.toMatch(/…$/);
    expect(compact.length).toBeLessThanOrEqual(
      SKILL_LIMITS.COMPACT_TOTAL_MAX + '## Overview\n\n'.length,
    );
  });

  it('still says something when the first sentence alone is too long', async () => {
    const long = `${'word '.repeat(80)}end.`;
    const compact = await (await writeSkill(`## Overview\n\n${long}\n`)).readSaveBody('demo');
    expect(compact).toMatch(/word…$/);
  });

  it('gives every bundled skill without a SKILL.save.md a clean compact body', async () => {
    const skills = loader(bundledDir);
    const problems: string[] = [];
    for (const skill of await skills.list()) {
      if (skill.source !== 'bundled') continue;
      const hasSave = await fs
        .stat(path.join(path.dirname(skill.path), 'SKILL.save.md'))
        .then(() => true)
        .catch(() => false);
      if (hasSave) continue;
      const compact = await skills.readSaveBody(skill.name);
      const text = compact.replace(/^## Overview\n\n/, '');
      if (text.length > SKILL_LIMITS.COMPACT_TOTAL_MAX)
        problems.push(`${skill.name}: ${text.length} chars`);
      // A fixed-offset cut leaves a dangling fragment such as "on 2026" or "`context.C…";
      // bundled Overviews open with a whole sentence that fits, so none ends in a cut.
      const overview = text.split('\n\n')[0] ?? '';
      if (!/[.!?]$/.test(overview))
        problems.push(`${skill.name}: overview ends "${overview.slice(-30)}"`);
      if (/…$/.test(text)) problems.push(`${skill.name}: compact body ends in a cut`);
    }
    expect(problems, `\n${problems.join('\n')}\n`).toEqual([]);
  });
});
