import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverE2EProjects, e2ePlanTool } from '../src/e2e.js';
import { mkSandbox, newSignal, type Sandbox } from './fixtures.js';

const sandboxes: Sandbox[] = [];

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((sandbox) => sandbox.cleanup()));
});

async function sandbox(): Promise<Sandbox> {
  const value = await mkSandbox();
  sandboxes.push(value);
  return value;
}

describe('E2E project discovery', () => {
  it('discovers Playwright config, server hints, scripts, and specs without loading config', async () => {
    const box = await sandbox();
    await fs.mkdir(path.join(box.dir, 'e2e'), { recursive: true });
    await fs.writeFile(path.join(box.dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
    await fs.writeFile(
      path.join(box.dir, 'package.json'),
      JSON.stringify({
        packageManager: 'pnpm@11.0.0',
        scripts: { 'test:e2e': 'playwright test' },
        devDependencies: { '@playwright/test': '1.61.1' },
      }),
    );
    await fs.writeFile(
      path.join(box.dir, 'playwright.config.ts'),
      `throw new Error('must not load');
       export default defineConfig({
         testDir: './e2e',
         webServer: { command: 'pnpm dev', url: 'http://127.0.0.1:4173' }
       });`,
    );
    await fs.writeFile(path.join(box.dir, 'e2e', 'login.spec.ts'), 'test("login", () => {});');

    const result = await discoverE2EProjects(box.dir, { signal: newSignal() });

    expect(result.projects).toHaveLength(1);
    expect(result.projects[0]).toMatchObject({
      framework: 'playwright',
      root: '.',
      configPath: 'playwright.config.ts',
      packageManager: 'pnpm',
      scripts: ['test:e2e'],
      specCount: 1,
      specSamples: ['e2e/login.spec.ts'],
      execution: {
        command: 'pnpm',
        args: ['run', 'test:e2e'],
        cwd: '.',
        source: 'package-script',
      },
    });
    expect(result.projects[0]?.serverHints).toEqual([
      {
        kind: 'managed',
        command: 'pnpm dev',
        url: 'http://127.0.0.1:4173',
        source: 'static-config',
        incomplete: false,
      },
    ]);
  });

  it('discovers Cypress from a nested package and returns a default exact-argv plan', async () => {
    const box = await sandbox();
    const app = path.join(box.dir, 'apps', 'shop');
    await fs.mkdir(path.join(app, 'cypress', 'e2e'), { recursive: true });
    await fs.writeFile(path.join(box.dir, 'yarn.lock'), '');
    await fs.writeFile(
      path.join(app, 'package.json'),
      JSON.stringify({ devDependencies: { cypress: '15.0.0' } }),
    );
    await fs.writeFile(
      path.join(app, 'cypress.config.ts'),
      `export default defineConfig({ e2e: { baseUrl: 'http://localhost:3000' } });`,
    );
    await fs.writeFile(
      path.join(app, 'cypress', 'e2e', 'cart.cy.ts'),
      'describe("cart", () => {});',
    );

    const result = await discoverE2EProjects(box.dir, {
      framework: 'cypress',
      signal: newSignal(),
    });

    expect(result.projects[0]).toMatchObject({
      framework: 'cypress',
      root: 'apps/shop',
      packageManager: 'yarn',
      specCount: 1,
      serverHints: [
        {
          kind: 'attach',
          url: 'http://localhost:3000',
          source: 'static-config',
          incomplete: false,
        },
      ],
      execution: {
        command: 'yarn',
        args: ['exec', 'cypress', 'run', '--config-file', 'cypress.config.ts'],
        cwd: 'apps/shop',
        source: 'framework-default',
      },
    });
  });

  it('reports dynamic managed server values as incomplete instead of executing config', async () => {
    const box = await sandbox();
    await fs.writeFile(path.join(box.dir, 'package.json'), '{}');
    await fs.writeFile(
      path.join(box.dir, 'playwright.config.js'),
      `module.exports = { webServer: { command: process.env.START, port: Number(process.env.PORT) } };`,
    );

    const result = await discoverE2EProjects(box.dir, {
      includeSpecs: false,
      signal: newSignal(),
    });

    expect(result.projects[0]?.serverHints).toEqual([
      { kind: 'managed', source: 'static-config', incomplete: true },
    ]);
    expect(result.projects[0]?.warnings).toContain(
      'Configured server contains dynamic values; only static hints are shown.',
    );
  });

  it('does not follow configured Playwright test directories outside the discovery root', async () => {
    const box = await sandbox();
    const project = path.join(box.dir, 'project');
    await fs.mkdir(project);
    await fs.writeFile(
      path.join(project, 'playwright.config.ts'),
      `export default { testDir: '../../outside' };`,
    );

    const result = await discoverE2EProjects(project, { signal: newSignal() });

    expect(result.projects[0]?.specCount).toBe(0);
    expect(result.projects[0]?.warnings).toContain(
      'Configured testDir resolves outside the requested discovery root and was not scanned.',
    );
  });

  it('uses package-manager-correct default argv for npm and bun', async () => {
    const npmBox = await sandbox();
    await fs.writeFile(path.join(npmBox.dir, 'package.json'), '{}');
    await fs.writeFile(path.join(npmBox.dir, 'playwright.config.ts'), 'export default {};');
    const npm = await discoverE2EProjects(npmBox.dir, {
      includeSpecs: false,
      signal: newSignal(),
    });
    expect(npm.projects[0]?.execution).toMatchObject({
      command: 'npm',
      args: ['exec', '--', 'playwright', 'test', '--config', 'playwright.config.ts'],
    });

    const bunBox = await sandbox();
    await fs.writeFile(
      path.join(bunBox.dir, 'package.json'),
      JSON.stringify({ packageManager: 'bun@1.2.0' }),
    );
    await fs.writeFile(path.join(bunBox.dir, 'cypress.config.ts'), 'export default {};');
    const bun = await discoverE2EProjects(bunBox.dir, {
      includeSpecs: false,
      signal: newSignal(),
    });
    expect(bun.projects[0]?.execution).toMatchObject({
      command: 'bunx',
      args: ['cypress', 'run', '--config-file', 'cypress.config.ts'],
    });
  });
});

describe('e2e_plan tool', () => {
  it('is an auto-approved, read-only filesystem inspection tool', () => {
    expect(e2ePlanTool).toMatchObject({
      name: 'e2e_plan',
      permission: 'auto',
      mutating: false,
      riskTier: 'safe',
      capabilities: ['fs.read'],
    });
  });

  it('honors framework filtering and rejects traversal outside the project root', async () => {
    const box = await sandbox();
    await fs.writeFile(path.join(box.dir, 'playwright.config.ts'), 'export default {};');
    await fs.writeFile(path.join(box.dir, 'cypress.config.ts'), 'export default {};');

    const output = await e2ePlanTool.execute({ framework: 'cypress' }, box.ctx, {
      signal: newSignal(),
    });
    expect(output.projects.map((project) => project.framework)).toEqual(['cypress']);

    await expect(
      e2ePlanTool.execute({ cwd: '..' }, box.ctx, { signal: newSignal() }),
    ).rejects.toThrow(/outside project root/);
  });

  it('observes cancellation before walking the workspace', async () => {
    const box = await sandbox();
    const controller = new AbortController();
    controller.abort(new Error('stop discovery'));

    await expect(e2ePlanTool.execute({}, box.ctx, { signal: controller.signal })).rejects.toThrow(
      'stop discovery',
    );
  });

  it('executes cleanly when opts parameter is omitted', async () => {
    const box = await sandbox();
    const output = await e2ePlanTool.execute({}, box.ctx);
    expect(output.projects).toBeDefined();
    expect(Array.isArray(output.projects)).toBe(true);
  });
});
