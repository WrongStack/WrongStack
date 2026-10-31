/**
 * The WrongForge tool gateway lives with the embedder (the CLI's in-process
 * `wstack tools serve` surface), so the host takes it through
 * `MultiAgentDeps.wrongForgeGateway`. Wired, every WrongForge runner gets it;
 * absent, the runner is built without a gateway.
 */
import { Container, EventBus } from '@wrongstack/contracts/kernel';
import type { Config } from '@wrongstack/contracts/types';
import { describe, expect, it, vi } from 'vitest';
import { acpCommandOpts, type HostAcpRunnerHost } from '../src/host-acp-runner.js';
import type { WrongForgeGatewayFactory } from '../src/host-types.js';
import type { WrongForgeGatewaySpec } from '../src/wrongforge-client.js';

function host(gateway?: WrongForgeGatewayFactory): HostAcpRunnerHost {
  const config = { autonomy: { yoloPlus: true } } as unknown as Config;
  const registry = { get: vi.fn() };
  return {
    deps: {
      events: new EventBus(),
      container: new Container(),
      configStore: { get: () => config },
      toolRegistry: registry,
      projectRoot: '/proj',
      ...(gateway ? { wrongForgeGateway: gateway } : {}),
    } as unknown as HostAcpRunnerHost['deps'],
    getDirector: vi.fn(),
    ensureCoordinator: vi.fn(async () => undefined),
    getCoordinator: vi.fn() as unknown as HostAcpRunnerHost['getCoordinator'],
    buildACPRunner: vi.fn() as unknown as HostAcpRunnerHost['buildACPRunner'],
    recordLearningRole: vi.fn(),
    directorRunnerSet: false,
    sessionForSubagent: vi.fn(() => 'session'),
  };
}

describe('WrongForge gateway injection', () => {
  it('starts the embedder-supplied gateway with the host project and registry', async () => {
    const spec = { url: 'http://127.0.0.1:1', token: 't' } as unknown as WrongForgeGatewaySpec;
    const factory = vi.fn<WrongForgeGatewayFactory>(async () => spec);
    const h = host(factory);
    const opts = acpCommandOpts.call(h);
    expect(opts.wrongforgeGateway).toBeTypeOf('function');
    await expect(opts.wrongforgeGateway?.()).resolves.toBe(spec);
    expect(factory).toHaveBeenCalledTimes(1);
    const arg = factory.mock.calls[0]![0];
    expect(arg.projectRoot).toBe('/proj');
    expect(arg.registry).toBe(h.deps.toolRegistry);
    expect(arg.yoloPlus?.()).toBe(true);
  });

  it('offers no gateway when none is wired', () => {
    expect(acpCommandOpts.call(host())).not.toHaveProperty('wrongforgeGateway');
  });
});
