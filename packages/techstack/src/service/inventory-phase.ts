import { randomUUID } from 'node:crypto';
import type { EcosystemAdapter, InventoryOptions } from '../adapters/interface.js';
import { cppAdapter } from '../adapters/cpp.js';
import { dartAdapter } from '../adapters/dart.js';
import { dotNetAdapter } from '../adapters/dotnet.js';
import { elixirAdapter } from '../adapters/elixir.js';
import { goAdapter } from '../adapters/go.js';
import { gradleAdapter } from '../adapters/gradle.js';
import { mavenAdapter } from '../adapters/maven.js';
import { npmAdapter } from '../adapters/npm.js';
import { phpAdapter } from '../adapters/php.js';
import { pythonAdapter } from '../adapters/python.js';
import { rubyAdapter } from '../adapters/ruby.js';
import { rustAdapter } from '../adapters/rust.js';
import { swiftAdapter } from '../adapters/swift.js';
import { discoverWorkspaces } from '../discovery/workspace.js';
import type { TechStackStore } from '../store/sqlite.js';
import type { Coverage, DependencyObservation, EcosystemId, Snapshot } from '../types.js';
import { computeDependencyFingerprint } from './finding-factory.js';

export const ADAPTER_VERSION = '0.1.0';

const ADAPTERS: Readonly<Record<EcosystemId, EcosystemAdapter>> = {
  npm: npmAdapter,
  python: pythonAdapter,
  rust: rustAdapter,
  go: goAdapter,
  dotnet: dotNetAdapter,
  php: phpAdapter,
  dart: dartAdapter,
  maven: mavenAdapter,
  gradle: gradleAdapter,
  ruby: rubyAdapter,
  swift: swiftAdapter,
  elixir: elixirAdapter,
  cpp: cppAdapter,
};

export interface InventoryPhaseOptions extends InventoryOptions {
  readonly onProgress?: ((phase: string, completed: number, total: number) => void) | undefined;
}

export async function runInventoryPhase(
  store: TechStackStore,
  projectId: string,
  targetRoot: string,
  options: InventoryPhaseOptions = {},
): Promise<Snapshot> {
  options.onProgress?.('discovering', 0, 1);
  const workspaces = await discoverWorkspaces(targetRoot, { signal: options.signal });
  options.onProgress?.('inventorying', 0, workspaces.length);
  const dependencies: DependencyObservation[] = [];
  let coverage: Coverage = 'full';
  let completed = 0;
  for (const workspace of workspaces) {
    if (options.signal?.aborted) throw new DOMException('TechStack job cancelled', 'AbortError');
    try {
      dependencies.push(
        ...(await ADAPTERS[workspace.ecosystem].inventory(workspace, {
          projectRoot: targetRoot,
          includeTransitive: options.includeTransitive,
          signal: options.signal,
        })),
      );
    } catch {
      // One malformed workspace must not discard other ecosystem inventories.
    }
    if (workspace.coverage === 'unsupported') coverage = 'partial';
    completed++;
    options.onProgress?.('inventorying', completed, workspaces.length);
  }
  const snapshot: Snapshot = {
    id: randomUUID(),
    projectId,
    targetRoot,
    fingerprint: computeDependencyFingerprint(dependencies),
    createdAt: new Date().toISOString(),
    workspaces,
    dependencies,
    findings: [],
    coverage,
    adapterVersion: ADAPTER_VERSION,
  };
  store.saveSnapshot(snapshot);
  return snapshot;
}
