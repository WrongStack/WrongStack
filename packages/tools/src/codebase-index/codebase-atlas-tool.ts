/**
 * `codebase-atlas` tool — query or project the repository's Codebase Atlas,
 * concept coverage, subsystem edges, Louvain file communities, and freshness.
 *
 * Bridges the persisted SQLite index (`file_concepts`, `subsystems`,
 * `concept_edges`, `file_rank`) and `.wrongstack/atlas/` projection so agents
 * and MCP clients can inspect high-level architecture, check drift, or write
 * `.wrongstack/atlas/atlas.json` + `ATLAS.md` on demand.
 */

import { existsSync } from 'node:fs';
import * as path from 'node:path';
import type { Tool } from '@wrongstack/contracts/types';
import { ToolValidationError } from '@wrongstack/contracts/types';
import { type AtlasBrief, buildAtlasBrief } from './atlas-brief.js';
import {
  type AtlasDocument,
  type AtlasFreshness,
  buildAtlas,
  checkAtlasFreshness,
  type WrittenAtlas,
  writeAtlas,
} from './atlas-projection.js';
import { detectStoreFileCommunities, type FileCommunity } from './louvain.js';
import { codebaseIndexDirOverride, indexStorePool, resolveIndexDir } from './writer.js';
import type { ConceptCoverage, ConceptEdge, Subsystem } from './writer-concepts.js';
import { posixIndexPath } from './writer-helpers.js';

export type CodebaseAtlasMode = 'brief' | 'full' | 'communities' | 'freshness' | 'write';

const VALID_MODES = new Set<CodebaseAtlasMode>([
  'brief',
  'full',
  'communities',
  'freshness',
  'write',
]);

export interface CodebaseAtlasInput {
  /**
   * Operation mode:
   * - `brief` (default): compact overview of packages, subsystems, hubs, Louvain communities, and freshness.
   * - `full`: full AtlasDocument (top ranked files, declarations, concepts, package edges) + conceptEdges.
   * - `communities`: deterministic Louvain file communities + subsystems + conceptEdges.
   * - `freshness`: check whether `.wrongstack/atlas/` matches the live index.
   * - `write`: project and write `.wrongstack/atlas/{atlas.json,manifest.json,ATLAS.md}`.
   */
  mode?: CodebaseAtlasMode | undefined;
  /** Maximum number of Louvain communities to return (default 15, max 50). */
  maxCommunities?: number | undefined;
}

export interface CodebaseAtlasOutput {
  mode: CodebaseAtlasMode;
  indexed: boolean;
  freshness?: AtlasFreshness | undefined;
  conceptCoverage?: ConceptCoverage | undefined;
  brief?: AtlasBrief | undefined;
  document?: AtlasDocument | undefined;
  communities?: FileCommunity[] | undefined;
  subsystems?: Subsystem[] | undefined;
  conceptEdges?: ConceptEdge[] | undefined;
  written?: WrittenAtlas | undefined;
}

export const codebaseAtlasTool: Tool<CodebaseAtlasInput, CodebaseAtlasOutput> = {
  name: 'codebase-atlas',
  category: 'Project',
  icon: 'index',
  description:
    'Inspect or project the Codebase Atlas: PageRank hubs, subsystem summaries, concept coverage, Louvain file communities, and `.wrongstack/atlas/` freshness.',
  usageHint:
    'ARCHITECTURE & CONCEPT OVERVIEW:\n\n' +
    '- Call `codebase-atlas({})` (`mode: "brief"`) for a fast architectural overview of packages, hubs, subsystems, and Louvain communities.\n' +
    '- Use `mode: "communities"` to inspect natural file clusters detected via weighted Louvain modularity.\n' +
    '- Use `mode: "freshness"` to verify if committed `.wrongstack/atlas/` files drifted from the live index.\n' +
    '- Use `mode: "write"` to regenerate `.wrongstack/atlas/atlas.json`, `manifest.json`, and `ATLAS.md`.',
  permission: 'auto',
  mutating: false,
  capabilities: ['fs.read'],
  timeoutMs: 35_000,
  inputSchema: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: ['brief', 'full', 'communities', 'freshness', 'write'],
        description:
          'Operation mode: "brief" (default), "full", "communities", "freshness", or "write".',
      },
      maxCommunities: {
        type: 'number',
        description: 'Maximum number of Louvain communities to include (default 15, max 50).',
      },
    },
    additionalProperties: false,
  },
  async execute(input, ctx, execOpts) {
    const signal = execOpts?.signal ?? ctx?.signal;
    signal?.throwIfAborted();

    const mode: CodebaseAtlasMode = input?.mode ?? 'brief';
    if (!VALID_MODES.has(mode)) {
      throw new ToolValidationError({
        message: `Invalid codebase-atlas mode "${String(input?.mode)}". Expected brief, full, communities, freshness, or write.`,
        field: 'mode',
      });
    }

    const maxCommunities = Math.max(
      1,
      Math.min(
        typeof input?.maxCommunities === 'number' && Number.isFinite(input.maxCommunities)
          ? Math.trunc(input.maxCommunities)
          : 15,
        50,
      ),
    );

    const indexDir = codebaseIndexDirOverride(ctx);
    const resolvedIndexDir = resolveIndexDir(ctx.projectRoot, indexDir);
    if (!existsSync(path.join(resolvedIndexDir, 'index.db'))) {
      return {
        mode,
        indexed: false,
      };
    }

    const store = indexStorePool.acquire(ctx.projectRoot, { indexDir });
    try {
      const stats = store.getStats();
      if (stats.totalFiles === 0) {
        return {
          mode,
          indexed: false,
        };
      }

      if (mode === 'freshness') {
        const freshness = await checkAtlasFreshness(store, ctx.projectRoot);
        return {
          mode,
          indexed: true,
          freshness,
          conceptCoverage: store.getConceptCoverage(),
        };
      }

      if (mode === 'write') {
        const written = await writeAtlas(store, ctx.projectRoot);
        const freshness = await checkAtlasFreshness(store, ctx.projectRoot);
        return {
          mode,
          indexed: true,
          written,
          freshness,
          conceptCoverage: store.getConceptCoverage(),
        };
      }

      const relativeOf = (file: string): string =>
        posixIndexPath(path.isAbsolute(file) ? path.relative(ctx.projectRoot, file) : file);

      if (mode === 'communities') {
        const communities = detectStoreFileCommunities(store, relativeOf).slice(0, maxCommunities);
        return {
          mode,
          indexed: true,
          communities,
          subsystems: store.getSubsystems(),
          conceptEdges: store.getConceptEdges(),
          conceptCoverage: store.getConceptCoverage(),
        };
      }

      if (mode === 'full') {
        const projection = buildAtlas(store, ctx.projectRoot);
        const freshness = await checkAtlasFreshness(store, ctx.projectRoot);
        return {
          mode,
          indexed: true,
          document: projection.document,
          freshness,
          conceptCoverage: store.getConceptCoverage(),
          subsystems: store.getSubsystems(),
          conceptEdges: store.getConceptEdges(),
        };
      }

      // Default: 'brief'
      const brief = await buildAtlasBrief(store, ctx.projectRoot);
      const freshness = await checkAtlasFreshness(store, ctx.projectRoot);
      const communities = detectStoreFileCommunities(store, relativeOf).slice(0, maxCommunities);
      return {
        mode,
        indexed: true,
        brief,
        freshness,
        conceptCoverage: store.getConceptCoverage(),
        communities,
        conceptEdges: store.getConceptEdges(),
      };
    } finally {
      indexStorePool.release(store);
    }
  },
};
