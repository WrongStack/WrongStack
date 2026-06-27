import { describe, expect, it } from 'vitest';
import { buildDesignCommand } from '../src/slash-commands/design.js';

const opts = { projectRoot: '/fake-project' } as any;
const makeCtx = () => ({ meta: {} }) as any;

describe('/design slash command', () => {
  it('lists kits with no args', async () => {
    const cmd = buildDesignCommand(opts);
    const res = await cmd.run('', makeCtx());
    expect(res?.message).toContain('minimal-clarity');
    expect(res?.message).not.toContain('_foundations');
  });

  it('pins a kit and emits runText to load it', async () => {
    const cmd = buildDesignCommand(opts);
    const ctx = makeCtx();
    const res = await cmd.run('neo-brutalist web', ctx);
    expect(res?.runText).toBe('design use neo-brutalist --stack web');
    expect(res?.metadata?.designKit).toBe('neo-brutalist');
    expect(res?.metadata?.designStack).toBe('web');
    expect((ctx.meta.designStudio as any)?.activeKit).toBe('neo-brutalist');
  });

  it('rejects an unknown kit with the menu', async () => {
    const cmd = buildDesignCommand(opts);
    const res = await cmd.run('does-not-exist', makeCtx());
    expect(res?.message).toMatch(/Unknown kit/i);
    expect(res?.message).toContain('minimal-clarity');
  });

  it('clears the active kit with "off"', async () => {
    const cmd = buildDesignCommand(opts);
    const ctx = makeCtx();
    await cmd.run('minimal-clarity', ctx);
    expect((ctx.meta.designStudio as any)?.activeKit).toBe('minimal-clarity');
    const res = await cmd.run('off', ctx);
    expect(res?.message).toMatch(/Cleared/i);
    expect((ctx.meta.designStudio as any)?.activeKit).toBeUndefined();
  });

  it('routes "foundations" to the tool via runText', async () => {
    const cmd = buildDesignCommand(opts);
    const res = await cmd.run('foundations', makeCtx());
    expect(res?.runText).toBe('design foundations');
  });
});
