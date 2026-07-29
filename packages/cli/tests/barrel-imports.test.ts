/**
 * Barrel/re-export import tests for files that would otherwise show 0% coverage.
 * These files only re-export symbols — importing the module covers them.
 */
import { describe, expect, it } from 'vitest';

describe('barrel modules (import coverage)', () => {
  it('auth-menu/index.ts re-exports symbols', async () => {
    const mod = await import('../src/auth-menu/index.js');
    expect(mod.runAuthDirect).toBeDefined();
    expect(mod.runAuthMenu).toBeDefined();
    expect(mod.runCodexOAuthLogin).toBeDefined();
    expect(mod.runClaudeOAuthLogin).toBeDefined();
    expect(mod.runCopilotOAuthLogin).toBeDefined();
    expect(mod.runAuthLocal).toBeDefined();
    expect(mod.resolveModelList).toBeDefined();
    expect(mod.probeLocalLlm).toBeDefined();
    expect(mod.LOCAL_LLM_PRESETS).toBeDefined();
  });

  it('multi-agent.ts re-exports types and classes', async () => {
    const mod = await import('../src/multi-agent.js');
    expect(mod.MultiAgentHost).toBeDefined();
    expect(mod.buildRoutingRunner).toBeDefined();
  });

  it('pre-launch.ts re-exports symbols', async () => {
    const mod = await import('../src/pre-launch.js');
    expect(mod.detectProjectKind).toBeDefined();
    expect(mod.runProjectCheck).toBeDefined();
    expect(mod.LaunchAbortedError).toBeDefined();
    expect(mod.persistLaunchChoices).toBeDefined();
    expect(mod.runLaunchPrompts).toBeDefined();

  });

  it('short-circuit-flags.ts exports help/version handler', async () => {
    const mod = await import('../src/boot/short-circuit-flags.js');
    expect(mod.handleHelpVersionShortCircuit).toBeDefined();
    expect(typeof mod.handleHelpVersionShortCircuit).toBe('function');
  });

  it('auth-menu/types.ts exports types', async () => {
    const mod = await import('../src/auth-menu/types.js');
    // Just verify the module loads — it's type-only exports
    expect(mod).toBeDefined();
  });
});
