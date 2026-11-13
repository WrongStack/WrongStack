import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DESIGN_JOBS,
  DESIGN_MATERIALS,
  drawDesignAnatomy,
  ensureDesignDraw,
  normalizeDesignJob,
  normalizeDesignMaterial,
  renderDesignDraw,
} from '../../src/execution/design-draw.js';

describe('design-draw — job & material page anatomy dealer', () => {
  let home: string;
  let project: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    prevHome = process.env['WRONGSTACK_HOME'];
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-draw-home-'));
    project = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-draw-proj-'));
    process.env['WRONGSTACK_HOME'] = home;
  });

  afterEach(async () => {
    if (prevHome === undefined) delete process.env['WRONGSTACK_HOME'];
    else process.env['WRONGSTACK_HOME'] = prevHome;
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(project, { recursive: true, force: true });
  });

  it('normalizes job and material aliases', () => {
    expect(normalizeDesignJob('newsletter')).toBe('subscribe');
    expect(normalizeDesignJob('signup')).toBe('sign-up');
    expect(normalizeDesignJob('console')).toBe('dashboard');
    expect(normalizeDesignJob('unknown-verb')).toBeUndefined();

    expect(normalizeDesignMaterial('photography')).toBe('photo');
    expect(normalizeDesignMaterial('code')).toBe('product');
    expect(normalizeDesignMaterial('prose')).toBe('words');
  });

  it('produces deterministic draws for every job × material combination', () => {
    for (const job of DESIGN_JOBS) {
      for (const material of DESIGN_MATERIALS) {
        const a = drawDesignAnatomy({ seed: 'det-1', job, material });
        const b = drawDesignAnatomy({ seed: 'det-1', job, material });
        expect(a).toEqual(b);
        expect(a.sections.length).toBeGreaterThanOrEqual(3);
        expect(a.skip.length).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('avoids recent macrostructures and warns against cloning kitPictured', async () => {
    const ctx1 = { meta: {} as Record<string, unknown>, projectRoot: project };
    const first = await ensureDesignDraw(ctx1, {
      job: 'subscribe',
      material: 'words',
      seed: 's-1',
      kitPictured: 'Quarterly frontispiece specimen for a print review',
    });
    expect(first.macrostructure.id).not.toBe('frontispiece');
    expect(first.skip[0]).toContain('Quarterly frontispiece specimen');

    const ctx2 = { meta: {} as Record<string, unknown>, projectRoot: project };
    const second = await ensureDesignDraw(ctx2, {
      job: 'subscribe',
      material: 'words',
      seed: 's-1',
    });
    expect(second.macrostructure.id).not.toBe(first.macrostructure.id);

    const rendered = renderDesignDraw(second);
    expect(rendered).toContain('Macrostructure');
    expect(rendered).toContain('Skip on this build');
    expect(rendered).toContain('stage:"hero"');
  });
});
