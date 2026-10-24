import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ToolResultBlock, ToolSettlement, ToolUseBlock } from '@wrongstack/contracts/types';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isAdHocScriptCall,
  projectKitTurnGuidance,
  rankKitCandidates,
} from '../src/project-kit/advisor.js';
import { readKitAdviceCatalog } from '../src/project-kit/catalog.js';
import { projectKitTool } from '../src/project-kit.js';

const catalog = [
  {
    name: 'settings.parity',
    description: 'Inspect settings across CLI TUI and WebUI interfaces.',
    effects: 'read' as const,
  },
  {
    name: 'reports.architecture',
    description: 'Generate an architecture report for packages.',
    effects: 'write' as const,
  },
];
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
function call(name: string, input: Record<string, unknown>): ToolUseBlock {
  return { type: 'tool_use', id: 'u1', name, input };
}
function result(error = false): ToolResultBlock {
  return { type: 'tool_result', tool_use_id: 'u1', content: 'ok', is_error: error };
}
const adhoc = call('write', {
  path: '.temp_files/check-settings.mjs',
  content: 'settings parity inspection',
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kit-advice-'));
  roots.push(root);
  for (const item of catalog) {
    const template = (await projectKitTool.execute(
      { action: 'template', name: item.name },
      {} as never,
      { signal: new AbortController().signal },
    )) as { files: Record<string, string> };
    for (const [file, source] of Object.entries(template.files)) {
      const target = path.join(root, file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(
        target,
        file.endsWith('kit.json')
          ? JSON.stringify({
              ...JSON.parse(source),
              description: item.description,
              effects: item.effects,
            })
          : 'throw new Error("must not execute during advice");',
      );
    }
  }
  return root;
}
async function advisor(task = 'Check setting parity across interfaces') {
  const root = await fixture();
  return {
    root,
    advice: await projectKitTurnGuidance.create({
      task,
      projectRoot: root,
      signal: new AbortController().signal,
    }),
  };
}

describe('Project Kit task advice', () => {
  it('matches Turkish and English domain terms deterministically', () => {
    expect(
      rankKitCandidates(catalog, 'ayarların arayüzlerde karşılığını kontrol et').map((k) => k.name),
    ).toEqual(['settings.parity']);
    expect(rankKitCandidates(catalog, 'Inspect setting parity').map((k) => k.name)).toEqual([
      'settings.parity',
    ]);
    expect(rankKitCandidates(catalog, 'mimari rapor oluştur')[0]?.name).toBe(
      'reports.architecture',
    );
    expect(rankKitCandidates(catalog, 'hello')).toEqual([]);
    expect(rankKitCandidates(catalog, 'run a new script and check it')).toEqual([]);
    expect(rankKitCandidates(catalog, 'Inspect latest news')).toEqual([]);
    expect(
      rankKitCandidates(
        [{ name: 'file.inspect', description: 'Read project data and files', effects: 'read' }],
        'read project files',
      ),
    ).toEqual([]);
  });
  it('reads only bounded manifests, skips invalid/symlinked entries and never imports code', async () => {
    const root = await fixture();
    const dir = path.join(root, '.wrongstack/project-kit');
    await mkdir(path.join(dir, 'invalid'));
    await writeFile(path.join(dir, 'invalid/kit.json'), '{oops');
    await mkdir(path.join(dir, 'oversized'));
    await writeFile(path.join(dir, 'oversized/kit.json'), ' '.repeat(70000));
    const longName = 'a'.repeat(81);
    await mkdir(path.join(dir, longName));
    const valid = JSON.parse(await readFile(path.join(dir, 'settings.parity/kit.json'), 'utf8'));
    await writeFile(
      path.join(dir, longName, 'kit.json'),
      JSON.stringify({ ...valid, name: longName }),
    );
    await symlink(path.join(dir, 'settings.parity'), path.join(dir, 'linked'), 'junction');
    expect(await readKitAdviceCatalog(root, new AbortController().signal)).toEqual(
      [...catalog].reverse(),
    );
  });
  it('refreshes metadata per turn and keeps project catalogs separate', async () => {
    const { root, advice } = await advisor();
    expect(advice.initialNote).toContain('settings.parity');
    expect(advice.initialNote).not.toContain('reports.architecture');
    const manifestPath = path.join(root, '.wrongstack/project-kit/settings.parity/kit.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    await writeFile(
      manifestPath,
      JSON.stringify({ ...manifest, description: 'Updated setting inspection' }),
    );
    const fresh = await projectKitTurnGuidance.create({
      task: 'Inspect setting',
      projectRoot: root,
      signal: new AbortController().signal,
    });
    expect(fresh.initialNote).toContain('Updated setting inspection');
    const empty = await mkdtemp(path.join(os.tmpdir(), 'kit-empty-'));
    roots.push(empty);
    expect(
      (
        await projectKitTurnGuidance.create({
          task: 'Inspect setting',
          projectRoot: empty,
          signal: new AbortController().signal,
        })
      ).initialNote,
    ).toBeNull();
  });
  it('nudges once after a successful ad hoc call without claiming it was prevented', async () => {
    const { advice } = await advisor();
    const note = advice.afterTools([adhoc], [result()]);
    expect(note).toContain('possible ad hoc duplication');
    expect(note).toContain('already happened');
    expect(advice.afterTools([adhoc], [result()])).toBeNull();
  });
  it('can discover relevance from the script when the follow-up task is vague', async () => {
    const { advice } = await advisor('devam et');
    expect(advice.initialNote).toBeNull();
    expect(advice.afterTools([adhoc], [result()])).toContain('settings.parity');
  });
  it('stops nudging after a direct or deferred inspection', async () => {
    for (const name of ['project_kit', 'tool_use']) {
      const { advice } = await advisor();
      const input = { action: 'inspect', name: 'settings.parity' };
      advice.afterTools(
        [call(name, name === 'tool_use' ? { tool: 'project_kit', input } : input)],
        [result()],
      );
      expect(advice.afterTools([adhoc], [result()])).toBeNull();
    }
  });
  it.each(['denied_by_policy', 'blocked_by_hook', 'declined'] as ToolSettlement[])(
    'does not steer around %s',
    async (settlement) => {
      const { advice } = await advisor();
      advice.afterTools(
        [call('project_kit_run', { name: 'settings.parity' })],
        [result(true)],
        new Map([['u1', settlement]]),
      );
      expect(advice.afterTools([adhoc], [result()])).toBeNull();
    },
  );
  it('does not interpret an aborted or unsuccessful write as duplication', async () => {
    const { advice } = await advisor();
    expect(advice.afterTools([adhoc], [result(true)])).toBeNull();
    expect(advice.afterTools([adhoc], [result()], new Map([['u1', 'aborted']]))).toBeNull();
  });

  it('suppresses reminders when a deferred Kit failure has lost its nested settlement', async () => {
    const { advice } = await advisor();
    advice.afterTools(
      [call('tool_use', { tool: 'project_kit_run', input: { name: 'settings.parity' } })],
      [result(true)],
      new Map([['u1', 'failed']]),
    );
    expect(advice.afterTools([adhoc], [result()])).toBeNull();
  });
  it('distinguishes temporary scripts from ordinary source edits and kit development', () => {
    expect(isAdHocScriptCall(adhoc)).toBe(true);
    expect(isAdHocScriptCall(call('write', { path: 'src/settings.js', content: 'settings' }))).toBe(
      false,
    );
    expect(
      isAdHocScriptCall(
        call('write', { path: '.wrongstack/project-kit/settings.parity/main.mjs' }),
      ),
    ).toBe(false);
    expect(isAdHocScriptCall(call('exec', { cmd: 'node', args: ['-p', 'process.version'] }))).toBe(
      false,
    );
    expect(isAdHocScriptCall(call('tool_use', { tool: 'write', input: adhoc.input }))).toBe(true);
    expect(
      isAdHocScriptCall(
        call('exec', {
          cmd: 'node',
          args: [
            '-e',
            `const fs = require('node:fs'); JSON.parse(fs.readFileSync('settings.json')); ${'// compare settings\n'.repeat(12)}`,
          ],
        }),
      ),
    ).toBe(true);
  });

  it('recognizes native PowerShell, Python heredocs and Windows executable names', () => {
    const ps = `get-childitem settings | convertfrom-json; ${'# compare setting parity\n'.repeat(10)}`;
    expect(isAdHocScriptCall(call('pwsh', { script: ps }))).toBe(true);
    const python = `import json\ndata = json.load(open('settings.json'))\n${'# compare setting parity\n'.repeat(10)}`;
    expect(isAdHocScriptCall(call('bash', { command: `python - <<'PY'\n${python}\nPY` }))).toBe(
      true,
    );
    expect(isAdHocScriptCall(call('exec', { cmd: 'python.exe', args: ['-c', python] }))).toBe(true);
    expect(isAdHocScriptCall(call('pwsh', { script: `@'\n${python}\n'@ | python -` }))).toBe(true);
    expect(isAdHocScriptCall(call('pwsh', { script: 'Get-Date' }))).toBe(false);
  });
});
