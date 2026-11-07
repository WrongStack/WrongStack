/**
 * The WrongForge tool gateway lives with the embedder (the CLI's in-process
 * `wstack tools serve` surface), so the host takes it through
 * `MultiAgentDeps.wrongForgeGateway`. Wired, every WrongForge runner gets it;
 * absent, the runner is built without a gateway.
 */
import { Container, EventBus } from '@wrongstack/contracts/kernel';
import type { Config } from '@wrongstack/contracts/types';
import type { ExploreCompanion } from '@wrongstack/coordination';
import { describe, expect, it, vi } from 'vitest';
import { acpCommandOpts, type HostAcpRunnerHost } from '../src/host-acp-runner.js';
import { HostAcpRunnerCache } from '../src/host-acp-runner-cache.js';
import { createExploreCompanionRegistry } from '../src/host-explore-companion-registry.js';
import { setBoundedLruEntry } from '../src/host-helpers.js';
import type { WrongForgeGatewayFactory } from '../src/host-types.js';
import {
  followTask,
  WfAborted,
  type WfCall,
  WfHttpError,
  type WrongForgeGatewaySpec,
  wrongForgeCall,
} from '../src/wrongforge-client.js';

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

  it('returns a rejected Promise instead of throwing synchronously in HostAcpRunnerCache and bounds LRU safely (F18)', async () => {
    const cache = new HostAcpRunnerCache(4);
    const rejected = cache.get('nonexistent-acp-agent-xyz');
    await expect(rejected).rejects.toThrow(/Unknown ACP agent/);

    const map = new Map<string, number>();
    const order: string[] = [];
    setBoundedLruEntry(map, order, '', 1, 0);
    setBoundedLruEntry(map, order, 'next', 2, 1);
    expect(map.has('')).toBe(false);
    expect(map.get('next')).toBe(2);
  });

  it('does not evict or stop live explore companions when create() returns null (F19)', () => {
    let enabled = true;
    const stopped: string[] = [];
    const reg = createExploreCompanionRegistry({
      max: 2,
      create: (id) =>
        enabled
          ? ({
              stop: () => {
                stopped.push(id);
              },
            } as unknown as ExploreCompanion)
          : null,
    });
    reg.ensure('s1');
    reg.ensure('s2');
    enabled = false;
    reg.ensure('s3');
    expect(reg.ids()).toEqual(['s1', 's2']);
    expect(stopped).toEqual([]);
  });

  it('maps mid-body aborts/disconnects in wrongForgeCall and advances followTask cursor on full pages (F20)', async () => {
    const ep = { url: 'http://127.0.0.1:8787', apiKey: 'wf_test_key_0123456789abcdef' };
    const ctrl = new AbortController();
    const callAbort = wrongForgeCall(ep, (async () => ({
      ok: true,
      status: 200,
      text: async () => {
        ctrl.abort();
        throw new Error('aborted');
      },
    })) as unknown as typeof fetch);
    await expect(callAbort('GET', '/v1/tasks/t1', undefined, ctrl.signal)).rejects.toBeInstanceOf(
      WfAborted,
    );

    const callDrop = wrongForgeCall(ep, (async () => ({
      ok: true,
      status: 200,
      text: async () => {
        throw new TypeError('terminated');
      },
    })) as unknown as typeof fetch);
    await expect(callDrop('GET', '/v1/tasks/t1')).rejects.toBeInstanceOf(WfHttpError);

    let polls = 0;
    const fullEvents = Array.from({ length: 1000 }, (_, i) => ({
      seq: i + 1,
      type: 'agent.text',
      data: { text: 'x' },
    }));
    const call: WfCall = async <T>(_method: string, route: string): Promise<T> => {
      polls += 1;
      const after = Number(/after=(\d+)/.exec(route)?.[1] ?? 0);
      if (after >= 1000) {
        return {
          status: 'completed',
          events: [],
          terminal: true,
          next_after: after,
        } as unknown as T;
      }
      return {
        status: 'completed',
        events: fullEvents,
        terminal: true,
        next_after: 0,
      } as unknown as T;
    };
    let count = 0;
    for await (const _ev of followTask(call, 't-loop', new AbortController().signal)) {
      count += 1;
    }
    expect(count).toBe(1000);
    expect(polls).toBe(2);
  });
});
