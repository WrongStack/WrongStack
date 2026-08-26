/**
 * Build the CLI's REAL tool + system-prompt surface for tests.
 *
 * This calls `setupCliPromptAndTools` — the exact function `cli-main.ts` runs
 * on every boot — rather than reproducing its steps. That matters: these
 * helpers back the token-saving measurement tests, and a measurement is only
 * meaningful if it measures what ships.
 *
 * There used to be a second, parallel wiring function (`wiring/tools.ts`
 * `setupTools`) that nothing in production called. The measurement tests were
 * written against it and their header claimed it was "the same path production
 * uses". It was not — among other drift it never registered the four
 * `vector_memory_*` tools that the real path registers — so every reported
 * tier number was taken against a tool surface the product does not ship.
 * Route new tests through here instead of hand-rolling a registry.
 */
import * as path from 'node:path';
import { Container, TOKENS } from '@wrongstack/core/kernel';
import type { ToolRegistry } from '@wrongstack/core/registry';
import type { Config, SessionWriter, TextBlock } from '@wrongstack/core/types';
import type { WstackPaths } from '@wrongstack/core/utils';
import { vi } from 'vitest';
import { setupCliPromptAndTools } from '../src/wiring/cli-prompt-and-tools-setup.js';

export interface CliToolSurface {
  toolRegistry: ToolRegistry;
  /** Built from the container-bound builder — the one the agent loop resolves. */
  buildSystemPrompt(): Promise<TextBlock[]>;
}

export interface CliToolSurfaceOptions {
  config: Config;
  memoryStore: unknown;
  /** Temp directory used for every path in `WstackPaths`. */
  tmp: string;
  /** Defaults to `tmp`. */
  projectRoot?: string;
  cwd?: string;
  modelCapabilities?: unknown;
}

export function makeWstackPaths(tmp: string): WstackPaths {
  return {
    configDir: tmp,
    globalConfig: path.join(tmp, 'config.json'),
    projectDir: tmp,
    projectSessions: tmp,
    globalRoot: tmp,
    logFile: path.join(tmp, 'log.txt'),
    historyFile: path.join(tmp, 'history'),
    modelsCache: path.join(tmp, 'models.json'),
    inProjectAgentsFile: path.join(tmp, 'AGENTS.md'),
    projectMemory: path.join(tmp, 'project-memory.md'),
    globalMemory: path.join(tmp, 'global-memory.md'),
    globalInstructions: tmp,
    inProjectInstructions: tmp,
  } as WstackPaths;
}

/** Container with the one binding `setupCliPromptAndTools` resolves. */
export function makeToolSurfaceContainer(): Container {
  const c = new Container();
  c.bind(TOKENS.Compactor, () => ({ compact: vi.fn() }) as never);
  return c;
}

export async function buildCliToolSurface(opts: CliToolSurfaceOptions): Promise<CliToolSurface> {
  const { config, memoryStore, tmp } = opts;
  const projectRoot = opts.projectRoot ?? tmp;
  const cwd = opts.cwd ?? tmp;
  const container = makeToolSurfaceContainer();
  const wpaths = makeWstackPaths(tmp);

  const { toolRegistry } = await setupCliPromptAndTools({
    container,
    // A null modeStore keeps the builder on its default mode; these helpers
    // measure the tool/prompt surface, not mode composition.
    modeStore: null,
    memoryStore,
    skillLoader: undefined,
    sessionRef: { current: undefined } as { current: SessionWriter | undefined },
    autonomyModeRef: { current: 'default' } as never,
    modeId: 'default',
    modePrompt: '',
    modelCapabilitiesRef: { current: opts.modelCapabilities },
    config,
    wpaths,
    projectRoot,
    events: { emit: vi.fn(), on: vi.fn(() => () => {}) },
  });

  return {
    toolRegistry,
    async buildSystemPrompt() {
      const builder = container.resolve(TOKENS.SystemPromptBuilder);
      return await builder.build({
        cwd,
        projectRoot,
        tools: toolRegistry.listForProvider(),
        catalogTools: toolRegistry.list(),
        provider: config.provider,
        model: config.model,
      });
    },
  };
}
