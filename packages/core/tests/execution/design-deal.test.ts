import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DesignKitEntry, DesignKitLoader } from '@wrongstack/contracts/types/design-kit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ensureDesignDeal,
  getDesignDeal,
  recordDesignChoice,
  renderDesignDeal,
} from '../../src/execution/design-deal.js';

const entry = (id: string, aesthetic: string, stacks = ['web']): DesignKitEntry =>
  ({ id, name: id, aesthetic, bestFor: 'apps', stacks, source: 'bundled' }) as DesignKitEntry;

const KITS = [
  entry('alpha', 'Calm editorial serif.'),
  entry('bravo', 'Dense console.'),
  entry('charlie', 'Playful rounded.'),
  entry('delta', 'Editorial magazine grid.'),
  entry('echo', 'Brutalist mono.'),
  entry('foxtrot', 'Soft glass.'),
  entry('golf', 'Native only.', ['flutter']),
  entry('hotel', 'Editorial longform.'),
];

const loader = { listEntries: async () => KITS } as unknown as DesignKitLoader;

let home: string;
let project: string;
let prevHome: string | undefined;

beforeEach(async () => {
  prevHome = process.env['WRONGSTACK_HOME'];
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-deal-home-'));
  project = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-deal-proj-'));
  process.env['WRONGSTACK_HOME'] = home;
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env['WRONGSTACK_HOME'];
  else process.env['WRONGSTACK_HOME'] = prevHome;
  await fs.rm(home, { recursive: true, force: true });
  await fs.rm(project, { recursive: true, force: true });
});

const ctx = () => ({ meta: {} as Record<string, unknown>, projectRoot: project });

describe('ensureDesignDeal', () => {
  it('draws three distinct stack-compatible kits, reproducibly for a seed', async () => {
    const a = await ensureDesignDeal(ctx(), loader, { seed: 's1', stack: 'web' });
    const b = await ensureDesignDeal(ctx(), loader, { seed: 's1', stack: 'web' });
    expect(a.deal.kits).toHaveLength(3);
    expect(new Set(a.deal.kits).size).toBe(3);
    expect(a.deal.kits).not.toContain('golf');
    expect(b.deal.kits).toEqual(a.deal.kits);
    // Different seeds spread over the catalogue instead of repeating one pick.
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) {
      for (const k of (await ensureDesignDeal(ctx(), loader, { seed: `s${i}`, stack: 'web' })).deal
        .kits)
        seen.add(k);
    }
    expect(seen.size).toBe(7);
  });

  it('keeps the session deal until redealt', async () => {
    const c = ctx();
    const first = await ensureDesignDeal(c, loader);
    expect(getDesignDeal(c)).toEqual(first.deal);
    expect((await ensureDesignDeal(c, loader)).deal).toEqual(first.deal);
    const again = await ensureDesignDeal(c, loader, { redeal: true });
    expect(again.deal.seed).not.toBe(first.deal.seed);
  });

  it('leaves recently chosen kits out of the draw', async () => {
    for (const kit of ['alpha', 'bravo', 'charlie'])
      await recordDesignChoice(project, { kit, dealt: true });
    for (let i = 0; i < 10; i++) {
      const { deal } = await ensureDesignDeal(ctx(), loader, { seed: `x${i}`, stack: 'web' });
      expect(deal.excluded).toEqual(['charlie', 'bravo', 'alpha']);
      expect(deal.kits.filter((k) => deal.excluded.includes(k))).toEqual([]);
    }
  });

  it('narrows to kits matching the query when enough match', async () => {
    for (let i = 0; i < 5; i++) {
      const { deal } = await ensureDesignDeal(ctx(), loader, { seed: `q${i}`, query: 'editorial' });
      expect(deal.kits.sort()).toEqual(['alpha', 'delta', 'hotel']);
    }
  });

  it('renders the seed and the reason requirement', async () => {
    const { deal, entries } = await ensureDesignDeal(ctx(), loader, { seed: 'r' });
    const text = renderDesignDeal(deal, entries);
    expect(text).toContain('seed "r"');
    for (const id of deal.kits) expect(text).toContain(`**${id}**`);
    expect(text).toContain('reason');
  });
});
