import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentPrompt } from '../../src/coordination/agents/agent-prompts.js';
import { captureLearnedFromAgentOutputDetailed } from '../../src/coordination/agents/project-agent-identity.js';

/**
 * B1 regression coverage: `agentPrompt` memoizes resolved prompts, but the
 * memoized string embeds the project overlay files (identity.md /
 * learned.md / consolidated.md) which DO change mid-process. The overlay
 * (mtimeMs, size) fingerprint is part of the cache key so a capture or an
 * identity edit is visible to the next spawn in the same process — the
 * capture→inject feedback loop. These tests pin that behavior.
 */
describe('agentPrompt overlay fingerprint', () => {
  let projectRoot = '';
  let savedProjectRoot: string | undefined;
  let savedInstructionsDir: string | undefined;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wrongstack-agent-prompts-'));
    savedProjectRoot = process.env['WRONGSTACK_PROJECT_ROOT'];
    savedInstructionsDir = process.env['WRONGSTACK_AGENT_INSTRUCTIONS_DIR'];
    process.env['WRONGSTACK_PROJECT_ROOT'] = projectRoot;
    // The env override dir disables the project overlay entirely — make sure
    // it is unset so the overlay (and its fingerprint) apply.
    delete process.env['WRONGSTACK_AGENT_INSTRUCTIONS_DIR'];
  });

  afterEach(() => {
    if (savedProjectRoot === undefined) delete process.env['WRONGSTACK_PROJECT_ROOT'];
    else process.env['WRONGSTACK_PROJECT_ROOT'] = savedProjectRoot;
    if (savedInstructionsDir === undefined) delete process.env['WRONGSTACK_AGENT_INSTRUCTIONS_DIR'];
    else process.env['WRONGSTACK_AGENT_INSTRUCTIONS_DIR'] = savedInstructionsDir;
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  function writeIdentity(content: string): void {
    const dir = path.join(projectRoot, '.wrongstack', 'agents', 'executor');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'identity.md'), content);
  }

  it('serves the cached prompt while the overlay is unchanged', () => {
    writeIdentity('Identity marker ALPHA');
    const first = agentPrompt('executor');
    const second = agentPrompt('executor');
    expect(first).toContain('Identity marker ALPHA');
    // Same overlay fingerprint → same memoized string instance.
    expect(second).toBe(first);
  });

  it('invalidates the memoized prompt when identity.md changes mid-process', () => {
    writeIdentity('Identity marker ALPHA');
    const before = agentPrompt('executor');
    expect(before).toContain('Identity marker ALPHA');

    writeIdentity('Identity marker BRAVO — rewritten after first resolve');
    const after = agentPrompt('executor');
    expect(after).toContain('Identity marker BRAVO');
    expect(after).not.toContain('Identity marker ALPHA');
  });

  it('invalidates the memoized prompt when identity.md appears after first resolve', () => {
    const bare = agentPrompt('executor');
    expect(bare).not.toContain('Project custom identity');

    writeIdentity('Late-arriving identity');
    const overlaid = agentPrompt('executor');
    expect(overlaid).toContain('Late-arriving identity');
  });

  it('a mid-process learned.md capture reaches the next agentPrompt call (capture→inject loop)', () => {
    const before = agentPrompt('executor');

    const learning =
      'Run the narrow package test before the workspace suite so failures remain attributable.';
    const result = captureLearnedFromAgentOutputDetailed(
      `Done.\n\n## LEARNED\n${learning}`,
      'executor',
      projectRoot,
    );
    expect(result.status).toBe('captured');

    const after = agentPrompt('executor');
    expect(after).not.toBe(before);
    expect(after).toContain('Run the narrow package test before the workspace suite');
  });

  it('does not leak one project overlay into another project root', () => {
    writeIdentity('Project ONE identity');
    expect(agentPrompt('executor')).toContain('Project ONE identity');

    const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wrongstack-agent-prompts-other-'));
    try {
      process.env['WRONGSTACK_PROJECT_ROOT'] = otherRoot;
      expect(agentPrompt('executor')).not.toContain('Project ONE identity');
    } finally {
      process.env['WRONGSTACK_PROJECT_ROOT'] = projectRoot;
      fs.rmSync(otherRoot, { recursive: true, force: true });
    }
  });
});
