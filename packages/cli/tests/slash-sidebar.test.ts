import { describe, expect, it } from 'vitest';
import type { SlashCommandContext } from '../src/slash-commands/index.js';
import { buildSidebarCommand } from '../src/slash-commands/sidebar.js';

const makeCtx = (initialShowSidebar = true) => {
  let state = { autonomy: { showSidebar: initialShowSidebar } };
  const configStore = {
    get: () => state,
    update: (patch: any) => {
      state = { ...state, ...patch, autonomy: { ...(state.autonomy || {}), ...(patch.autonomy || {}) } };
      return state;
    },
  };
  return { configStore } as unknown as SlashCommandContext;
};

describe('/sidebar slash command', () => {
  it('reports name, description and help text', () => {
    const cmd = buildSidebarCommand(makeCtx());
    expect(cmd.name).toBe('sidebar');
    expect(cmd.description).toContain('sidebar');
    expect(cmd.help).toContain('/sidebar on');
    expect(cmd.help).toContain('/sidebar off');
  });

  it('toggles sidebar when called with no arguments', async () => {
    const ctx = makeCtx(true);
    const cmd = buildSidebarCommand(ctx);
    const res1 = await cmd.run!('');
    expect(res1?.message).toContain('off');
    expect(ctx.configStore.get().autonomy?.showSidebar).toBe(false);

    const res2 = await cmd.run!('');
    expect(res2?.message).toContain('on');
    expect(ctx.configStore.get().autonomy?.showSidebar).toBe(true);
  });

  it('sets sidebar explicitly with on and off', async () => {
    const ctx = makeCtx(true);
    const cmd = buildSidebarCommand(ctx);

    await cmd.run!('off');
    expect(ctx.configStore.get().autonomy?.showSidebar).toBe(false);

    await cmd.run!('on');
    expect(ctx.configStore.get().autonomy?.showSidebar).toBe(true);
  });

  it('returns current status with status argument', async () => {
    const ctx = makeCtx(true);
    const cmd = buildSidebarCommand(ctx);
    const res = await cmd.run!('status');
    expect(res?.message).toContain('on');
  });
});
