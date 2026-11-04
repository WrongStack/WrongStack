import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  buildWindowsRoute,
  configureSandboxPolicy,
  defaultWindowsHelperRunner,
  resetSandboxPolicy,
  resolveSandboxConfig,
  runHelperRoute,
} from '../../src/sandbox/index.js';

// Plan 28 T5.2 — helper exit-code/stdio propagation, always-run on win32
// (the .NET host is preinstalled on Windows; no toolchain gate needed).
// Proves the T5.2 contract without the integration env var: a failing
// payload's non-zero exit code and the child's stdout reach the launcher.

const win32 = process.platform === 'win32';
const describeWin = win32 ? describe : describe.skip;

describeWin('helper exit-code/stdio propagation (plan 28 T5.2)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wstack-t52-prop-'));

  afterEach(() => {
    resetSandboxPolicy();
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function helperExit(command: string): Promise<{ code: number | null; out: string }> {
    configureSandboxPolicy({
      mode: 'enforced',
      tier: 'workspace-write',
      backend: 'windows-native',
      writableRoots: [dir],
    });
    const helper = defaultWindowsHelperRunner();
    const route = (await helper(
      buildWindowsRoute(
        { tool: 'bash', kind: 'shell', command },
        resolveSandboxConfig({
          mode: 'enforced',
          tier: 'workspace-write',
          backend: 'windows-native',
          writableRoots: [dir],
        }),
      )!,
    )) as NonNullable<Awaited<ReturnType<typeof helper>>>;
    return runHelperRoute(route);
  }

  it('propagates a failing payload exit code through the helper', async () => {
    const failed = await helperExit('exit 7');
    expect(failed.code).toBe(7);
  });

  it('propagates child stdout through the inherited helper pipes', async () => {
    const echoed = await helperExit('echo t52-propagated-marker');
    expect(echoed.code).toBe(0);
    expect(echoed.out).toContain('t52-propagated-marker');
  });

  it('gates browser executeStream and threads per-agent sandbox config into windows helper', async () => {
    const {
      clearSandboxAgentOverrides,
      createSandboxBrowserTierGate,
      createSandboxExecWrapper,
      createWindowsNativeSandboxBackend,
      setSandboxAgentOverride,
    } = await import('../../src/sandbox/index.js');
    try {
      configureSandboxPolicy({
        mode: 'enforced',
        tier: 'workspace-write',
        backend: 'container',
        image: 'alpine:3.19',
        writableRoots: [dir],
      });
      const gatedBrowser = createSandboxBrowserTierGate()({
        name: 'browser_open',
        description: 'open browser',
        parameters: { type: 'object', properties: {} },
        capabilities: ['network.http'],
        execute: async () => ({ content: 'ok' }),
        executeStream: async function* () {
          yield 'chunk';
        },
      });
      await expect(async () => {
        for await (const _ of gatedBrowser.executeStream!(
          { url: 'https://example.com' },
          {} as never,
        )) {
          // consume
        }
      }).rejects.toThrow();

      configureSandboxPolicy({
        mode: 'enforced',
        tier: 'workspace-write',
        backend: 'windows-native',
        writableRoots: ['D:\\global-root', dir],
      });
      setSandboxAgentOverride('sub-narrow', {
        tier: 'workspace-write',
        writableRoots: [dir],
      });
      let capturedCmd = '';
      const backend = createWindowsNativeSandboxBackend({
        platform: 'win32',
        helperRunner: defaultWindowsHelperRunner(),
      });
      const wrappedBash = createSandboxExecWrapper(backend)({
        name: 'bash',
        description: 'shell',
        parameters: { type: 'object', properties: {} },
        capabilities: ['shell.exec'],
        execute: async (input: { command: string }) => {
          capturedCmd = input.command;
          return { content: 'ok' };
        },
      });
      await wrappedBash.execute({ command: 'echo test' }, { agentId: 'sub-narrow' } as never);
      expect(capturedCmd).not.toContain('D:\\global-root');
    } finally {
      clearSandboxAgentOverrides();
    }
  });
});
