import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readActivePlanBlock } from '../../src/core/system-prompt-plan.js';

const temps: string[] = [];

afterEach(async () => {
  for (const dir of temps.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe('readActivePlanBlock (F503)', () => {
  it('parses UTF-8 BOM plan JSON and handles JSON null without throwing', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'f503-'));
    temps.push(dir);

    const bomPath = path.join(dir, 'plan-bom.json');
    await fs.writeFile(
      bomPath,
      `\uFEFF${JSON.stringify({ title: 'BomPlan', items: [{ status: 'open', title: 'Task B' }] })}`,
      'utf8',
    );
    const bomRes = await readActivePlanBlock({ planPath: bomPath, cache: undefined });
    expect(bomRes.text).toContain('BomPlan');
    expect(bomRes.cache).toBeDefined();

    const nullPath = path.join(dir, 'plan-null.json');
    await fs.writeFile(nullPath, 'null', 'utf8');
    const nullRes = await readActivePlanBlock({ planPath: nullPath, cache: undefined });
    expect(nullRes.text).toBe('');
    expect(nullRes.cache).toBeDefined();
  });
});
