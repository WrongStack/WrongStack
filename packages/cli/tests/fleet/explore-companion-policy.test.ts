import type { SubagentConfig } from '@wrongstack/contracts/types';
import { DEFAULT_EXPLORE_COMPANION_AGENT_ID, FLEET_ROSTER } from '@wrongstack/core/coordination';
import { describe, expect, it } from 'vitest';
import {
  constrainExploreCompanion,
  exploreCompanionSystemPrompt,
  isExploreCompanion,
} from '../../src/fleet/explore-companion-policy.js';
import { formatExploreNote } from '../../src/fleet/host-explore-companion.js';

const template = FLEET_ROSTER[DEFAULT_EXPLORE_COMPANION_AGENT_ID] as SubagentConfig;

describe('explore companion lean spawn policy', () => {
  it('matches only the host-spawned resident, not any spawn naming the role', () => {
    expect(isExploreCompanion({ ...template, id: 'explore-companion-abc12345-0f0f0f0f' })).toBe(
      true,
    );
    expect(isExploreCompanion({ ...template, id: 'my-explorer' })).toBe(false);
    expect(isExploreCompanion({ ...template, role: 'explore', id: 'explore-companion-x' })).toBe(
      false,
    );
  });

  it('reapplies the read-only tool surface and drops every skill over project overrides', () => {
    const constrained = constrainExploreCompanion({
      ...template,
      id: 'explore-companion-x',
      tools: ['bash', 'write'],
      skillNames: ['node-modern'],
      skillPool: ['typescript-strict'],
      skillContent: 'extra',
    });
    expect(constrained.tools).toEqual(template.tools);
    expect(constrained.tools).not.toContain('bash');
    expect(constrained.skillNames).toEqual([]);
    expect(constrained.skillPool).toEqual([]);
    expect(constrained.skillContent).toBeUndefined();
    expect(constrained.sealed).toBe(true);
    expect(constrained.gracefulFinish).toBe(false);
  });

  it('builds one cacheable block: the brief without the project overlay, plus the root', () => {
    const overlaid = [
      'You are the Explore Companion.',
      '',
      '<!-- wrongstack:project-agent-context:start -->',
      '## Knowledge capture',
      'end your response with a `## LEARNED` block',
      '<!-- wrongstack:project-agent-context:end -->',
    ].join('\n');
    const blocks = exploreCompanionSystemPrompt({
      rolePrompt: overlaid,
      projectRoot: '/repo',
      platform: 'linux',
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.cache_control).toEqual({ type: 'ephemeral' });
    const text = blocks[0]?.text ?? '';
    expect(text).toContain('You are the Explore Companion.');
    expect(text).toContain('- Project root: /repo');
    expect(text).toContain('- Platform: linux');
    expect(text).not.toContain('LEARNED');
    expect(text).not.toContain('wrongstack:project-agent-context');
  });

  it('keeps the real role brief small enough to be the whole prompt', () => {
    const [block] = exploreCompanionSystemPrompt({
      rolePrompt: template.prompt,
      projectRoot: '/repo',
    });
    expect(block?.text).toMatch(/Hard stop \(do not wander\)/);
    // ~1k tokens; the general subagent prompt it replaces measured ~27k.
    expect(block?.text.length ?? 0).toBeLessThan(5_000);
  });
});

describe('formatExploreNote', () => {
  it('renders only the answer: summary, cited findings, one next read', () => {
    const note = formatExploreNote({
      summary: 'parseFleetConfig lives in config-loader.ts.',
      findings: ['packages/core/src/config-loader.ts:42 — parseFleetConfig', '  '],
      files_examined: ['packages/core/src/config-loader.ts'],
      confidence: 0.9,
      suggested_next_steps: ['packages/core/src/config-loader.ts:60'],
    });
    expect(note).toBe(
      [
        'parseFleetConfig lives in config-loader.ts.',
        '- packages/core/src/config-loader.ts:42 — parseFleetConfig',
        'Next: packages/core/src/config-loader.ts:60',
        '(confidence 0.90)',
      ].join('\n'),
    );
    expect(note).not.toContain('Files examined');
    expect(note).not.toContain('(none)');
  });

  it('returns empty string when report has neither summary nor findings', () => {
    expect(
      formatExploreNote({
        summary: '   ',
        findings: ['  '],
        files_examined: ['src/a.ts'],
        confidence: 0.5,
        suggested_next_steps: ['src/a.ts:1'],
      }),
    ).toBe('');
  });
});
