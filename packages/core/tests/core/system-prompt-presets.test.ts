import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadInstructionBundle } from '../../src/core/instruction-bundle.js';
import {
  buildIdentityLayer,
  DefaultSystemPromptBuilder,
} from '../../src/core/system-prompt-builder.js';
import {
  activateSystemPromptPreset,
  bundledPromptText,
  createSystemPromptPreset,
  readActiveSystemPromptPresets,
  readProjectSystemPromptPresets,
  saveSystemPromptPreset,
  systemPromptPresetCacheKey,
  validateSystemPromptPreset,
} from '../../src/core/system-prompt-presets.js';

const dirs: string[] = [];
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-preset-'));
  dirs.push(root);
  const globalDir = path.join(root, 'profile', 'instructions');
  const projectDir = path.join(root, 'project', '.wrongstack', 'instructions');
  await fs.mkdir(projectDir, { recursive: true });
  return { globalDir, projectDir };
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('profile system prompt presets', () => {
  it('accepts the expanded shipped variants as editable copies', () => {
    for (const variant of ['lite', 'default', 'pro', 'scout'] as const) {
      expect(
        validateSystemPromptPreset(bundledPromptText(variant)).filter(
          (i) => i.severity === 'error',
        ),
      ).toEqual([]);
    }
  });
  it('rejects malformed conditionals before saving instead of runtime fail-open', () => {
    expect(
      validateSystemPromptPreset('<!--ws:if tool=read-->\nRead').some(
        (i) => i.severity === 'error',
      ),
    ).toBe(true);
    expect(
      validateSystemPromptPreset('<!--ws:if mode=foo-->\nRead\n<!--ws:end-->').some(
        (i) => i.severity === 'error',
      ),
    ).toBe(true);
    expect(validateSystemPromptPreset('<!--ws:if tool=read-->\nRead\n<!--ws:end-->')).toEqual([]);
    expect(
      validateSystemPromptPreset('<!--ws:if tool=custom_bridge-->\nUse it\n<!--ws:end-->'),
    ).toContainEqual(expect.objectContaining({ severity: 'warning', line: 1 }));
  });

  it('loads an active global copy and preserves project guidance provenance', async () => {
    const { globalDir, projectDir } = await fixture();
    const preset = await createSystemPromptPreset(globalDir, 'My standard', 'default');
    const changed = await saveSystemPromptPreset(
      globalDir,
      preset.id,
      1,
      preset.name,
      '# My identity\n<!--ws:if tool=read-->\nUse read.\n<!--ws:end-->',
    );
    await expect(
      saveSystemPromptPreset(globalDir, preset.id, 1, 'stale', changed.text),
    ).rejects.toThrow('changed elsewhere');
    await activateSystemPromptPreset(globalDir, 'default', preset.id);
    const global = await loadInstructionBundle({ globalDir, systemVariant: 'default' });
    expect(global.system?.identity).toBe(changed.text);
    expect(global.system?.identitySource).toBe('global');
    await fs.writeFile(path.join(projectDir, 'system.md'), '# Project guidance');
    const project = await loadInstructionBundle({
      globalDir,
      projectDir,
      systemVariant: 'default',
    });
    expect(project.system?.identity).toContain('Project guidance');
    expect(project.system?.identitySource).toBe('project');
    expect(project.system?.trustedIdentity).toBe(changed.text);
    const composed = buildIdentityLayer(
      project.system?.identity,
      project.system?.identitySource,
      undefined,
      project.system?.trustedIdentity,
    );
    expect(composed).toContain('# My identity');
    expect(composed).toContain('<project-supplied-instructions');
    expect((await readActiveSystemPromptPresets(globalDir)).default).toBe(preset.id);
  });

  it('refreshes a reused builder after activating and editing a preset', async () => {
    const { globalDir } = await fixture();
    const builder = new DefaultSystemPromptBuilder({
      injectMemory: false,
      instructionPaths: { globalDir, systemVariant: 'default' },
    });
    const context = {
      cwd: '/repo',
      projectRoot: '/repo',
      tools: [],
      provider: 'mock',
      model: 'test',
    };
    const before = (await builder.build(context)).map((block) => block.text).join('\n');
    const preset = await createSystemPromptPreset(globalDir, 'Active', 'default');
    const edited = await saveSystemPromptPreset(
      globalDir,
      preset.id,
      preset.revision,
      preset.name,
      '# First custom identity',
    );
    await activateSystemPromptPreset(globalDir, 'default', edited.id);
    const active = (await builder.build(context)).map((block) => block.text).join('\n');
    expect(before).not.toContain('First custom identity');
    expect(active).toContain('First custom identity');
    await saveSystemPromptPreset(
      globalDir,
      edited.id,
      edited.revision,
      edited.name,
      '# Revised custom identity',
    );
    const revised = (await builder.build(context)).map((block) => block.text).join('\n');
    expect(revised).toContain('Revised custom identity');
    expect(revised).not.toContain('First custom identity');
    const presetFile = path.join(globalDir, 'system-prompt-presets', `${edited.id}.json`);
    const external = JSON.parse(await fs.readFile(presetFile, 'utf8')) as Record<string, unknown>;
    external['text'] = '# Changed by another process';
    external['revision'] = 4;
    await fs.writeFile(presetFile, JSON.stringify(external));
    await fs.utimes(presetFile, new Date(), new Date(Date.now() + 1000));
    const refreshed = (await builder.build(context)).map((block) => block.text).join('\n');
    expect(refreshed).toContain('Changed by another process');
  });

  it('falls back to the base identity when the selected preset file is deleted', async () => {
    // F3: a dangling selection (deleted preset JSON, partial profile sync)
    // used to reject every system-prompt build with a raw ENOENT.
    const { globalDir } = await fixture();
    const preset = await createSystemPromptPreset(globalDir, 'Deleted', 'default');
    const edited = await saveSystemPromptPreset(
      globalDir,
      preset.id,
      preset.revision,
      preset.name,
      '# Custom preset identity',
    );
    await activateSystemPromptPreset(globalDir, 'default', edited.id);
    expect((await loadInstructionBundle({ globalDir })).system?.identity).toBe(
      '# Custom preset identity',
    );

    await fs.unlink(path.join(globalDir, 'system-prompt-presets', `${edited.id}.json`));

    expect(await systemPromptPresetCacheKey(globalDir, 'default')).toBe('');
    const bundle = await loadInstructionBundle({ globalDir });
    expect(bundle.system?.identity).toContain('You are WrongStack');
    expect(bundle.system?.identity).not.toBe('# Custom preset identity');
  });

  it('lets a project choose a different preset without writing to the repository', async () => {
    const { globalDir, projectDir } = await fixture();
    const first = await createSystemPromptPreset(globalDir, 'Profile default', 'default');
    const second = await createSystemPromptPreset(globalDir, 'Project choice', 'default');
    await saveSystemPromptPreset(globalDir, first.id, 1, first.name, '# PROFILE');
    await saveSystemPromptPreset(globalDir, second.id, 1, second.name, '# PROJECT');
    await activateSystemPromptPreset(globalDir, 'default', first.id);
    await activateSystemPromptPreset(globalDir, 'default', second.id, projectDir);
    expect((await loadInstructionBundle({ globalDir, projectDir })).system?.identity).toBe(
      '# PROJECT',
    );
    expect((await loadInstructionBundle({ globalDir })).system?.identity).toBe('# PROFILE');
    expect((await readProjectSystemPromptPresets(globalDir, projectDir)).default).toBe(second.id);
    expect(await fs.readdir(projectDir)).toEqual([]);
  });
});
