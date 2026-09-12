import {
  getSessionSubagentModelPlan,
  resetSessionSubagentModelPlan,
} from '@wrongstack/core/coordination';
import type { Config, SessionEvent } from '@wrongstack/core/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SlashCommandContext } from '../src/slash-commands/index.js';
import { buildSubagentModelsCommand } from '../src/slash-commands/subagent-models.js';

const SESSION_ID = 'sess_slash_plan';

function baseConfig(): Partial<Config> {
  return {
    version: 1,
    provider: 'anthropic',
    model: 'anthropic-test-model',
    providers: {
      anthropic: { type: 'anthropic', apiKey: 'sk-ant-x' },
      openai: { type: 'openai', apiKey: 'sk-oai-y' },
      nokey: { type: 'nokey' },
    },
    fallbackProfiles: { cheap: ['openai/gpt-5-mini', 'anthropic/haiku'] },
    modelMatrix: { reviewer: { provider: 'routed', model: 'routed-model' } },
  };
}

function makeCtx(): SlashCommandContext {
  return {
    configStore: { get: () => baseConfig() },
  } as never as SlashCommandContext;
}

function makeAgentCtx(): { ctx: never; appended: SessionEvent[] } {
  const appended: SessionEvent[] = [];
  const ctx = {
    meta: {} as Record<string, unknown>,
    session: {
      id: SESSION_ID,
      append: async (event: SessionEvent) => void appended.push(event),
    },
  };
  return { ctx: ctx as never, appended };
}

const cmd = () => buildSubagentModelsCommand(makeCtx());

beforeEach(() => resetSessionSubagentModelPlan(SESSION_ID));
afterEach(() => resetSessionSubagentModelPlan(SESSION_ID));

describe('/subagent-models', () => {
  it('shows an empty plan without touching the session', async () => {
    const res = await cmd().run('', undefined);
    expect(res && 'message' in res ? res.message : '').toContain('no lane pinned');
    expect(getSessionSubagentModelPlan(SESSION_ID)).toBeUndefined();
  });

  it('pins a lane, journals it, and applies it live', async () => {
    const { ctx, appended } = makeAgentCtx();
    await cmd().run('set 2 openai/gpt-5', ctx);

    expect(appended.map((e) => e.type)).toEqual(['subagent_model_plan']);
    const plan = getSessionSubagentModelPlan(SESSION_ID);
    expect(plan?.slots[1]).toEqual({ provider: 'openai', model: 'gpt-5' });
    expect(plan?.slots[0]).toEqual({});
  });

  it('accepts the space-separated, bare-model, tier and profile forms', async () => {
    const { ctx } = makeAgentCtx();
    const c = cmd();
    await c.run('set 1 anthropic claude-opus-5', ctx);
    await c.run('set 2 some-model', ctx);
    await c.run('set 3 tier:budget', ctx);
    await c.run('set 4 cheap', ctx);

    const plan = getSessionSubagentModelPlan(SESSION_ID);
    expect(plan?.slots[0]).toEqual({ provider: 'anthropic', model: 'claude-opus-5' });
    expect(plan?.slots[1]).toEqual({ model: 'some-model' });
    expect(plan?.slots[2]).toEqual({ tier: 'budget' });
    expect(plan?.slots[3]).toEqual({ fallbackProfile: 'cheap' });
  });

  it('warns when the pinned provider has no configured key', async () => {
    const { ctx } = makeAgentCtx();
    const res = await cmd().run('set 1 nokey/some-model', ctx);
    expect(res && 'message' in res ? res.message : '').toContain('has no configured key');
  });

  it('rejects an out-of-range lane without writing anything', async () => {
    const { ctx, appended } = makeAgentCtx();
    const res = await cmd().run('set 99 openai/gpt-5', ctx);
    expect(res && 'message' in res ? res.message : '').toContain('between 1 and');
    expect(appended).toHaveLength(0);
  });

  it('clears one lane and all lanes', async () => {
    const { ctx } = makeAgentCtx();
    const c = cmd();
    await c.run('set 1 openai/gpt-5', ctx);
    await c.run('set 2 anthropic/opus', ctx);
    await c.run('clear 1', ctx);
    expect(getSessionSubagentModelPlan(SESSION_ID)?.slots[0]).toEqual({});
    expect(getSessionSubagentModelPlan(SESSION_ID)?.slots[1]).toEqual({
      provider: 'anthropic',
      model: 'opus',
    });

    await c.run('clear all', ctx);
    expect(
      getSessionSubagentModelPlan(SESSION_ID)?.slots.every((s) => Object.keys(s).length === 0),
    ).toBe(true);
  });

  it('sets and drops a role override', async () => {
    const { ctx } = makeAgentCtx();
    const c = cmd();
    await c.run('role reviewer openai/gpt-5', ctx);
    expect(getSessionSubagentModelPlan(SESSION_ID)?.roles).toEqual({
      reviewer: { provider: 'openai', model: 'gpt-5' },
    });

    await c.run('role reviewer clear', ctx);
    expect(getSessionSubagentModelPlan(SESSION_ID)?.roles).toBeUndefined();
  });

  it('toggles lock and enabled', async () => {
    const { ctx } = makeAgentCtx();
    const c = cmd();
    await c.run('lock off', ctx);
    expect(getSessionSubagentModelPlan(SESSION_ID)?.lock).toBe(false);
    await c.run('off', ctx);
    expect(getSessionSubagentModelPlan(SESSION_ID)?.enabled).toBe(false);
    await c.run('on', ctx);
    expect(getSessionSubagentModelPlan(SESSION_ID)?.enabled).toBe(true);
  });

  it('toggles "use my model" for every plain subagent', async () => {
    const { ctx } = makeAgentCtx();
    const c = cmd();
    await c.run('session on', ctx);
    expect(getSessionSubagentModelPlan(SESSION_ID)?.followSessionModel).toBe(true);
    await c.run('session off', ctx);
    expect(getSessionSubagentModelPlan(SESSION_ID)?.followSessionModel).toBe(false);
  });

  it('rejects a session switch that is neither on nor off', async () => {
    const { ctx, appended } = makeAgentCtx();
    const res = await cmd().run('session maybe', ctx);
    expect(res && 'message' in res ? res.message : '').toContain('expected "on" or "off"');
    expect(appended).toHaveLength(0);
  });

  it('resizes lanes and reports dropped pins', async () => {
    const { ctx } = makeAgentCtx();
    const c = cmd();
    await c.run('set 8 openai/gpt-5', ctx);
    const res = await c.run('lanes 4', ctx);
    expect(getSessionSubagentModelPlan(SESSION_ID)?.slots).toHaveLength(4);
    expect(res && 'message' in res ? res.message : '').toContain('pinned lane(s) dropped');
  });

  it('previews the next spawn without stranding the lane', async () => {
    const { ctx } = makeAgentCtx();
    const c = cmd();
    await c.run('set 1 openai/gpt-5', ctx);

    const first = await c.run('resolve', ctx);
    const second = await c.run('resolve', ctx);
    expect(first && 'message' in first ? first.message : '').toContain('lane 1');
    expect(second && 'message' in second ? second.message : '').toContain('lane 1');
  });

  it('says a routed role is left to /setmodel', async () => {
    const { ctx } = makeAgentCtx();
    const c = cmd();
    await c.run('set 1 openai/gpt-5', ctx);

    const res = await c.run('resolve reviewer', ctx);
    expect(res && 'message' in res ? res.message : '').toContain('routed by /setmodel');
  });

  it('previews the session model when "use my model" is on', async () => {
    const { ctx } = makeAgentCtx();
    const c = cmd();
    await c.run('session on', ctx);

    const res = await c.run('resolve', ctx);
    const message = res && 'message' in res ? (res.message ?? '') : '';
    expect(message).toContain('anthropic-test-model');
    expect(message).toContain('use my model');
  });

  it('refuses to write without an active session', async () => {
    const res = await cmd().run('set 1 openai/gpt-5', undefined);
    expect(res && 'message' in res ? res.message : '').toContain('No active session');
  });
});
