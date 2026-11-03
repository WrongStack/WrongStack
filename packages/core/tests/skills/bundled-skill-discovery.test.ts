import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUNTIME_CAPABILITY_MANIFEST } from '@wrongstack/contracts/types/runtime-capability-manifest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProgressiveSkillManifestText } from '../../src/core/system-prompt-skill-bodies.js';
import { DefaultSkillLoader } from '../../src/execution/skill-loader.js';
import { isSkillHiddenFromPrompt, skillUseWhenText } from '../../src/skills/prompt-discovery.js';
import { resolveWstackPaths } from '../../src/utils/wstack-paths.js';

/**
 * In the default progressive mode the model chooses a skill from one catalog
 * row: the description (plus trigger) cut to a short budget with "…". Most
 * bundled descriptions used to spend that budget on generic prose ("Build and
 * upgrade X with explicit Y and Z") and lost the framework and file names a
 * request would actually contain — python-backend's row ended at "Use when
 * working on…", before FastAPI or Django.
 *
 * The contract pinned here: every row a visible bundled skill gets shows its
 * complete first sentence. Authors put the discriminating nouns there. The
 * budget itself is read from the rendered catalog, not copied.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const bundledDir = path.resolve(here, '..', '..', 'skills');
const everyTool = [...new Set(RUNTIME_CAPABILITY_MANIFEST.flatMap((entry) => [...entry.tools]))];

/** Abbreviations whose trailing period does not end a sentence. */
const NON_TERMINAL = /\b(?:e\.g|i\.e|etc|vs|cf)$/i;

function firstSentence(text: string): string {
  for (const match of text.matchAll(/[.!?](?=\s|$)/g)) {
    const end = match.index ?? 0;
    if (NON_TERMINAL.test(text.slice(0, end + 1).replace(/\.$/, ''))) continue;
    return text.slice(0, end + 1);
  }
  return text;
}

describe('bundled skill catalog rows', () => {
  let tmp: string;
  let rows: Map<string, string>;
  let loader: DefaultSkillLoader;

  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-skill-discovery-'));
    loader = new DefaultSkillLoader({
      paths: resolveWstackPaths({
        projectRoot: path.join(tmp, 'project'),
        globalRoot: path.join(tmp, 'global'),
        userHome: tmp,
      }),
      bundledDir,
      foreignSources: false,
    });
    const manifest = await buildProgressiveSkillManifestText(loader, everyTool);
    rows = new Map(
      [...manifest.matchAll(/^\| `([a-z0-9-]+)`[^|]*\| (.*) \|$/gm)].map((match) => [
        match[1] ?? '',
        (match[2] ?? '').replace(/\\\|/g, '|'),
      ]),
    );
  });

  afterAll(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('lists every prompt-visible bundled skill', async () => {
    const visible = (await loader.list()).filter(
      (skill) => skill.source === 'bundled' && !isSkillHiddenFromPrompt(skill.audience),
    );
    expect(visible.length).toBeGreaterThan(50);
    expect(visible.map((skill) => skill.name).filter((name) => !rows.has(name))).toEqual([]);
  });

  it('shows each skill’s complete first sentence', async () => {
    const problems: string[] = [];
    for (const skill of await loader.list()) {
      const row = rows.get(skill.name);
      if (skill.source !== 'bundled' || row === undefined) continue;
      const useWhen = skillUseWhenText(skill.description, skill.trigger)
        .replace(/\s+/g, ' ')
        .trim();
      const sentence = firstSentence(useWhen);
      if (!row.startsWith(sentence)) {
        problems.push(`${skill.name} (${sentence.length} chars): ${row}`);
      }
    }
    expect(problems, `\n${problems.join('\n')}\n`).toEqual([]);
  });
});
