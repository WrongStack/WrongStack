import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentPrompt, agentPromptCacheSize } from '../../src/coordination/agents/agent-prompts.js';
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

  let mtimeSeq = 1000;
  function writeIdentity(content: string): void {
    const dir = path.join(projectRoot, '.wrongstack', 'agents', 'executor');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'identity.md');
    fs.writeFileSync(file, content);
    mtimeSeq += 1000;
    const date = new Date(Date.now() + mtimeSeq);
    fs.utimesSync(file, date, date);
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

  it('keeps one cache entry per role across repeated overlay rewrites', () => {
    // The fingerprint used to be part of the cache key, so every capture minted
    // a fresh entry and the previous generation — a fully rendered prompt —
    // stayed resident forever. A host that captures often grew the map without
    // bound. Rewriting the overlay must overwrite, not accumulate.
    writeIdentity('generation 0');
    agentPrompt('executor');
    const afterFirst = agentPromptCacheSize();

    for (let generation = 1; generation <= 25; generation++) {
      writeIdentity(`generation ${generation}`);
      expect(agentPrompt('executor')).toContain(`generation ${generation}`);
    }

    expect(agentPromptCacheSize()).toBe(afterFirst);
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

/**
 * B3 regression: the tech-version policy body was memoized in a single
 * module-level `let`, so changing `WRONGSTACK_AGENT_INSTRUCTIONS_DIR` did
 * not re-resolve the policy — and the candidate list never included the
 * override dir, so `_policy/tech-version.md` placed there was invisible.
 * The memo is now keyed by env-dir, and both candidate lists include the
 * override dir when set.
 */
describe('agentPrompt tech-version policy env-dir (B3)', () => {
  let overrideDir: string;
  let savedInstructionsDir: string | undefined;
  let savedPolicy: string | undefined;

  beforeEach(() => {
    overrideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrongstack-b3-policy-'));
    savedInstructionsDir = process.env['WRONGSTACK_AGENT_INSTRUCTIONS_DIR'];
    savedPolicy = process.env['WRONGSTACK_AGENT_POLICY'];
    process.env['WRONGSTACK_AGENT_POLICY'] = 'on';
    delete process.env['WRONGSTACK_AGENT_INSTRUCTIONS_DIR'];
  });

  afterEach(() => {
    if (savedInstructionsDir === undefined) delete process.env['WRONGSTACK_AGENT_INSTRUCTIONS_DIR'];
    else process.env['WRONGSTACK_AGENT_INSTRUCTIONS_DIR'] = savedInstructionsDir;
    if (savedPolicy === undefined) delete process.env['WRONGSTACK_AGENT_POLICY'];
    else process.env['WRONGSTACK_AGENT_POLICY'] = savedPolicy;
    fs.rmSync(overrideDir, { recursive: true, force: true });
  });

  it('resolves the policy from the override dir when WRONGSTACK_AGENT_INSTRUCTIONS_DIR is set', () => {
    const policyDir = path.join(overrideDir, '_policy');
    fs.mkdirSync(policyDir, { recursive: true });
    fs.writeFileSync(
      path.join(policyDir, 'tech-version.md'),
      '# Override Policy\n\nAlways use Rust.',
    );

    process.env['WRONGSTACK_AGENT_INSTRUCTIONS_DIR'] = overrideDir;

    // The sentinel key returns just the policy body, bypassing the base
    // prompt resolution so the assertion is isolated to the policy layer.
    const prompt = agentPrompt('\u0000__tech_version_policy__');
    expect(prompt).toContain('Override Policy');
    expect(prompt).toContain('Always use Rust.');
    expect(prompt).not.toContain('Mandatory modern technology policy');
  });

  it('falls back to the inline policy when the override dir has no tech-version.md', () => {
    // Empty override dir → policy is not found there, falls back.
    process.env['WRONGSTACK_AGENT_INSTRUCTIONS_DIR'] = overrideDir;

    const prompt = agentPrompt('\u0000__tech_version_policy__');
    expect(prompt).toContain('Mandatory modern technology policy');
    expect(prompt).not.toContain('Override Policy');
  });

  it('invalidates the cached policy body when WRONGSTACK_AGENT_INSTRUCTIONS_DIR changes', () => {
    // First: no override → inline policy cached under key ''
    const inlinePrompt = agentPrompt('\u0000__tech_version_policy__');
    expect(inlinePrompt).toContain('Mandatory modern technology policy');

    // Now set the override dir with a custom policy
    const policyDir = path.join(overrideDir, '_policy');
    fs.mkdirSync(policyDir, { recursive: true });
    fs.writeFileSync(
      path.join(policyDir, 'tech-version.md'),
      '# Override Policy\n\nAlways use Rust.',
    );
    process.env['WRONGSTACK_AGENT_INSTRUCTIONS_DIR'] = overrideDir;

    // Same process — the env-dir-keyed memo must serve the new body, not the
    // stale one cached under the empty key.
    const overridePrompt = agentPrompt('\u0000__tech_version_policy__');
    expect(overridePrompt).toContain('Override Policy');
    expect(overridePrompt).not.toContain('Mandatory modern technology policy');
  });
});
