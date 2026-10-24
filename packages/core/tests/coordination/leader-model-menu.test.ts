import type { Config } from '@wrongstack/contracts/types/config';
import { describe, expect, it } from 'vitest';
import { createDelegateTool } from '../../src/coordination/delegate-tool.js';
import { FLEET_ROSTER } from '../../src/coordination/fleet.js';
import { renderLeaderModelMenu } from '../../src/coordination/leader-model-menu.js';
import { DefaultSystemPromptBuilder } from '../../src/core/system-prompt-builder.js';

const SESSION = { provider: 'leader-co', model: 'leader-1' };

const CONFIG = {
  provider: 'leader-co',
  model: 'leader-1',
  providers: { 'cheap-co': {}, 'strong-co': {} },
  fallbackProfiles: {
    cheap: ['cheap-co/flash', 'strong-co/mini'],
    strong: ['strong-co/max'],
  },
  modelTiers: {
    enabled: true,
    default: 'standard',
    levels: {
      budget: { fallbackProfile: 'cheap', description: 'Mechanical work' },
      standard: { provider: 'strong-co', model: 'mid' },
      premium: { fallbackProfile: 'strong' },
    },
  },
  modelMatrix: {
    reviewer: { fallbackProfile: 'strong' },
    'bug-hunter': { fallbackProfile: 'strong' },
    explore: { fallbackProfile: 'cheap' },
  },
} as unknown as Config;

describe('renderLeaderModelMenu', () => {
  it('names the model each tier level, route and default actually lands on', () => {
    const menu = renderLeaderModelMenu(CONFIG, SESSION);
    expect(menu).toContain('- `budget` → cheap-co/flash — Mechanical work');
    expect(menu).toContain('- `standard` → strong-co/mid');
    expect(menu).toContain('- `premium` → strong-co/max');
    expect(menu).toContain('reviewer, bug-hunter → strong-co/max');
    expect(menu).toContain('explore → cheap-co/flash');
    expect(menu).toContain('Configured providers: cheap-co, strong-co');
    // Tiers on: an unrouted worker lands on the default level, not the leader's model.
    expect(menu).toContain(
      'runs on tier `standard` → strong-co/mid (you run on leader-co/leader-1)',
    );
  });

  it('says an unrouted worker inherits the leader model when tiers are off', () => {
    const config = { ...CONFIG, modelTiers: undefined } as unknown as Config;
    const menu = renderLeaderModelMenu(config, SESSION);
    expect(menu).toContain('runs on your own model, leader-co/leader-1');
    expect(menu).not.toContain('`tier` levels');
  });

  it('renders nothing when the config offers no choice', () => {
    expect(renderLeaderModelMenu({} as Config, SESSION)).toBe('');
    expect(renderLeaderModelMenu(undefined, SESSION)).toBe('');
  });
});

describe('delegate model menu', () => {
  it('reaches the delegation guidance and replaces the unconfigured provider examples', async () => {
    const tool = createDelegateTool({
      host: {} as never,
      roster: FLEET_ROSTER,
      modelMenu: () => renderLeaderModelMenu(CONFIG, SESSION),
    });
    const provider = (tool.inputSchema as { properties: { provider: { description: string } } })
      .properties.provider.description;
    expect(provider).not.toContain('anthropic');
    for (const tokenSavingMode of ['off', 'medium'] as const) {
      const b = new DefaultSystemPromptBuilder({ todayIso: '2026-10-20', tokenSavingMode });
      const text = (
        await b.build({ cwd: process.cwd(), projectRoot: process.cwd(), tools: [tool] })
      )
        .map((block) => block.text)
        .join('\n');
      expect(text).toContain('- `premium` → strong-co/max');
      expect(text).not.toContain('{{modelMenu}}');
    }
  });

  it('keeps the prompt intact when the menu throws or is absent', () => {
    const throwing = createDelegateTool({
      host: {} as never,
      roster: FLEET_ROSTER,
      modelMenu: () => {
        throw new Error('config unreadable');
      },
    });
    expect(throwing.promptVars?.modelMenu).toBeUndefined();
    expect(throwing.promptVars?.roleList).toContain('bug-hunter');
  });
});
