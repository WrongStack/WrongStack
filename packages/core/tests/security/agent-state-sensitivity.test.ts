/**
 * Which writes under `~/.wrongstack` are agent-state (prompt even under YOLO)
 * and which are the agent's own working state (no prompt).
 *
 * The whole tree used to be agent-state, so routine writes — plans, specs,
 * caches — stopped for approval with no visible reason. Only state a silent
 * write could turn against the user stays gated: code that runs, approval
 * state, secrets, and instructions every session obeys. These tests pin both
 * halves, plus the link tricks that narrowing the gate would otherwise open.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isAgentStateExtractionTarget,
  isAgentStateWriteTarget,
  isSensitiveAgentStateRelPath,
} from '../../src/security/agent-state-sensitivity.js';
import { writesAgentState } from '../../src/security/permission-helpers.js';
import { isClearlyDestructiveBashCommand } from '../../src/security/yolo-risk.js';

describe('isSensitiveAgentStateRelPath', () => {
  it.each([
    'config.json',
    'profiles/default/config.json',
    'projects/abc/config.local.json',
    'config-history/config.json.2026-10-05.bak',
    'trust.json',
    'projects/abc/trust.json',
    'plugin-trust.json',
    'auth.json',
    'hq/auth.json',
    '.key',
    'profiles/default/sync.json',
    'plugins/x.mjs',
    'plugins/x/lib/index.js',
    'updates/pending.json',
    'automation/jobs.json',
    'projects/abc/sessions/2026-10-05/s1.jsonl',
    'profiles/default/instructions/system.md',
    'profiles/default/skills/x/SKILL.md',
    'profiles/default/memory.md',
    'memory.md',
    'AGENTS.md',
    'adversary.md',
    'profiles/default/adversary.md',
    '',
    'PROFILES/Default/SKILLS/x.md',
  ])('gates %j', (rel) => {
    expect(isSensitiveAgentStateRelPath(rel)).toBe(true);
  });

  it.each([
    'projects/abc/plan.json',
    'projects/abc/goal.json',
    'projects/abc/specs/feature.md',
    'projects/abc/task-graphs/g.json',
    'projects/abc/sdd-boards/b.jsonl',
    'projects/abc/memory.md',
    'projects/abc/input-history.json',
    'cache/models.dev.json',
    'logs/wrongstack.log',
    'tool-output/x.txt',
    'diagnostics/report.json',
    'profiles/default/prompts/p.json',
    'profiles/default/design-kits/k/theme.css',
    'profiles/default/history',
    'statusline.json',
    'projects.json',
  ])('leaves %j to the agent', (rel) => {
    expect(isSensitiveAgentStateRelPath(rel)).toBe(false);
  });
});

describe('absolute targets under a real root (links, extraction, patch)', () => {
  let base: string;
  let home: string;
  let savedHome: string | undefined;

  beforeEach(async () => {
    base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-agent-state-')));
    home = path.join(base, '.wrongstack');
    await fs.mkdir(path.join(home, 'cache'), { recursive: true });
    await fs.mkdir(path.join(home, 'projects', 'abc'), { recursive: true });
    await fs.writeFile(path.join(home, 'trust.json'), '{}');
    savedHome = process.env['WRONGSTACK_HOME'];
    process.env['WRONGSTACK_HOME'] = home;
  });

  afterEach(async () => {
    if (savedHome === undefined) delete process.env['WRONGSTACK_HOME'];
    else process.env['WRONGSTACK_HOME'] = savedHome;
    await fs.rm(base, { recursive: true, force: true });
  });

  it('a benign name that links to trust.json is still trust.json', async () => {
    const link = path.join(home, 'cache', 't');
    try {
      await fs.symlink(path.join(home, 'trust.json'), link, 'file');
    } catch {
      return; // no symlink privilege (Windows without developer mode)
    }
    expect(isAgentStateWriteTarget(path.join(home, 'cache', 'other'))).toBe(false);
    expect(isAgentStateWriteTarget(link)).toBe(true);
    expect(isClearlyDestructiveBashCommand(`echo x > ${link}`, base)).toBe(true);
  });

  it('a link from outside the root into it is judged by where it lands', async () => {
    const link = path.join(base, 'outside-link');
    try {
      await fs.symlink(home, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return;
    }
    expect(isAgentStateWriteTarget(path.join(link, 'trust.json'))).toBe(true);
    expect(isAgentStateWriteTarget(path.join(link, 'cache', 'x'))).toBe(false);
  });

  it('shell writes: gated state prompts, working state does not', () => {
    expect(isClearlyDestructiveBashCommand(`echo x > ${path.join(home, 'trust.json')}`, base)).toBe(
      true,
    );
    expect(
      isClearlyDestructiveBashCommand(
        `echo x > ${path.join(home, 'projects', 'abc', 'plan.json')}`,
        base,
      ),
    ).toBe(false);
    expect(
      isClearlyDestructiveBashCommand(`echo x >> ${path.join(home, 'cache', 'n.txt')}`, base),
    ).toBe(false);
  });

  it.runIf(process.platform === 'win32')(
    'Windows trailing dots/spaces name the same file (cmd/PowerShell drop them)',
    () => {
      const local = path.join(home, 'config.local.json.');
      expect(isAgentStateWriteTarget(local)).toBe(true);
      expect(isClearlyDestructiveBashCommand(`echo {} > "${local}"`, base)).toBe(true);
      expect(isAgentStateWriteTarget(path.join(home, 'trust.json '))).toBe(true);
      expect(isAgentStateWriteTarget(path.join(home, 'plugins.', 'x.js'))).toBe(true);
      expect(isAgentStateWriteTarget(path.join(home, 'cache', 'notes.md.'))).toBe(false);
    },
  );

  it('ln and mv are judged by their source too (hard links hide from realpath)', () => {
    const trust = path.join(home, 'trust.json');
    const benign = path.join(home, 'cache', 't');
    expect(isClearlyDestructiveBashCommand(`ln ${trust} ${benign}`, base)).toBe(true);
    expect(isClearlyDestructiveBashCommand(`mv ${trust} ${path.join(base, 'gone')}`, base)).toBe(
      true,
    );
    expect(
      isClearlyDestructiveBashCommand(`mv ${benign} ${path.join(home, 'cache', 'u')}`, base),
    ).toBe(false);
  });

  it('archive extraction is gated where configs load, not into a benign subtree', () => {
    expect(isAgentStateExtractionTarget(home)).toBe(true);
    expect(isAgentStateExtractionTarget(path.join(home, 'profiles', 'default'))).toBe(true);
    expect(isAgentStateExtractionTarget(path.join(home, 'projects', 'abc'))).toBe(true);
    expect(isAgentStateExtractionTarget(path.join(home, 'plugins', 'x'))).toBe(true);
    expect(isAgentStateExtractionTarget(path.join(home, 'cache', 'unpack'))).toBe(false);
    expect(
      isClearlyDestructiveBashCommand(`tar -xf a.tar -C ${path.join(home, 'cache')}`, base),
    ).toBe(false);
    expect(isClearlyDestructiveBashCommand(`tar -xf a.tar -C ${home}`, base)).toBe(true);
  });

  it('a tool writing beneath a directory input is judged like an extraction', () => {
    expect(
      writesAgentState(undefined, { directory: path.join(home, 'projects', 'abc') }, base),
    ).toBe(true);
    expect(writesAgentState(undefined, { directory: path.join(home, 'cache') }, base)).toBe(false);
  });

  it('relative tool-declared targets resolve against the directory input (patch)', () => {
    const patchLike = {
      name: 'patch',
      writeTargets: (input: { files: string[] }) => input.files,
    } as never;
    const cache = path.join(home, 'cache');
    // `../trust.json` from `cache/` is trust.json, whatever the working dir.
    expect(writesAgentState(patchLike, { directory: cache, files: ['../trust.json'] }, base)).toBe(
      true,
    );
    expect(writesAgentState(patchLike, { directory: cache, files: ['notes.md'] }, base)).toBe(
      false,
    );
  });
});
