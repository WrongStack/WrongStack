import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
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

  it('swaps to a different kit and pins it fresh', async () => {
    const cmd = buildDesignCommand(opts);
    const ctx = makeCtx();
    const res = await cmd.run('swap linear-dark web', ctx);
    expect(res?.runText).toBe('design use linear-dark --stack web');
    expect(res?.message).toMatch(/Swapped/i);
    expect((ctx.meta.designStudio as any)?.activeKit).toBe('linear-dark');
    expect((ctx.meta.designStudio as any)?.overrides).toEqual({});
  });

  it('tune with unknown knobs shows usage', async () => {
    const cmd = buildDesignCommand(opts);
    const res = await cmd.run('tune radius=bogus', makeCtx());
    expect(res?.message).toMatch(/Usage: \/design tune/);
  });

  it('tune without an active kit reports so', async () => {
    const cmd = buildDesignCommand(opts);
    const res = await cmd.run('tune radius=lg', makeCtx());
    expect(res?.message).toMatch(/No active kit/i);
  });

  it('routes "extract <url> [maxPages]" to design_reference via runText', async () => {
    const cmd = buildDesignCommand(opts);
    const res = await cmd.run('extract https://stripe.com 6', makeCtx());
    expect(res?.runText).toBe(
      'design_reference {"action":"extract","url":"https://stripe.com","maxPages":6}',
    );
    const missing = await cmd.run('extract', makeCtx());
    expect(missing?.message).toMatch(/Usage: \/design extract/);
  });

  it('routes "compare" and "inspect" to design_reference via runText', async () => {
    const cmd = buildDesignCommand(opts);
    const cmp = await cmd.run('compare stripe-com index.html', makeCtx());
    expect(cmp?.runText).toBe(
      'design_reference {"action":"compare","reference":"stripe-com","file":"index.html"}',
    );
    const insp = await cmd.run('inspect https://stripe.com', makeCtx());
    expect(insp?.runText).toBe('design_reference {"action":"inspect","url":"https://stripe.com"}');
  });

  it('captures DESIGN.md and materializes tokens without a pinned kit', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-cli-design-'));
    try {
      await fs.writeFile(
        path.join(tmp, 'DESIGN.md'),
        [
          '---',
          'version: alpha',
          'name: Stripe',
          'colors:',
          '  primary: "#533AFD"',
          '  canvas: "#F6F9FC"',
          '  ink: "#0A2540"',
          'themes:',
          '  dark:',
          '    bg: "#0B0B14"',
          '    text: "#F8F7FF"',
          'rounded:',
          '  sm: 4px',
          'spacing:',
          '  md: 16px',
          '---',
          '',
          '## 1. Visual Theme & Atmosphere',
          'Authoritative fintech.',
        ].join('\n'),
      );
      const cmd = buildDesignCommand({ projectRoot: tmp } as any);
      const cap = await cmd.run('capture', makeCtx());
      expect(cap?.message).toMatch(/Captured \d+ token value\(s\)/);
      expect(cap?.message).toContain('DESIGN.md');

      const mat = await cmd.run('materialize web src/tokens.css', makeCtx());
      expect(mat?.message).toContain('src/tokens.css');
      const css = await fs.readFile(path.join(tmp, 'src', 'tokens.css'), 'utf8');
      expect(css).toContain('#533AFD');
      expect(css).toContain('#0B0B14');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
