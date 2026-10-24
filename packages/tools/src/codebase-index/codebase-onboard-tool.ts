/**
 * `codebase-onboard` tool — Guided Architectural Tour & Onboarding Generator.
 *
 * Synthesizes PageRank centrality (`file_rank`), Louvain architectural
 * communities (`detectStoreFileCommunities`), `file_concepts` summaries + crux
 * line spans, and forward execution flows (`discoverEntryPoints`) into a
 * dependency-ordered `TourStep[]` walk and a structured Markdown onboarding
 * guide.
 */

import { existsSync } from 'node:fs';

import * as path from 'node:path';
import type { Tool } from '@wrongstack/contracts/types';
import { ATLAS_DIR, ensureAtlasDir, writeAtlasFile } from './atlas-projection.js';
import {
  discoverEntryPoints,
  type ExecutionFlow,
  sliceExecutionFlow,
} from './codebase-flow-trace-tool.js';
import { isTestFilePath } from './codebase-impact-analysis-tool.js';
import { type AnchoredSageInsight, findAnchoredSageMemories } from './ecosystem-bridge.js';
import { detectStoreFileCommunities, type FileCommunity } from './louvain.js';
import {
  codebaseIndexDirOverride,
  type IndexStore,
  indexStorePool,
  resolveIndexDir,
} from './writer.js';
import type { FileConcept } from './writer-concepts.js';
import { posixIndexPath } from './writer-helpers.js';

export const ATLAS_ONBOARDING = 'ONBOARDING.md';

export type TourStage = 'foundation' | 'hub' | 'subsystem' | 'entry-flow';

export type OnboardingPersona = 'junior' | 'experienced' | 'architect' | 'non-technical';

export interface TourStep {
  order: number;
  stage: TourStage;
  title: string;
  file: string;
  lineSpan: { start: number; end: number };
  rank: number;
  inDeg: number;
  outDeg: number;
  symbols: Array<{ name: string; kind: string; line: number; signature: string }>;
  explanation: string;
  /** Detected language/design patterns in the step's declarations (generics, async, inheritance, etc.). */
  languageNotes?: string[] | undefined;
  memories?: AnchoredSageInsight[] | undefined;
}

export interface CodebaseOnboardInput {
  /** Optional package, directory, or keyword filter to focus the tour. */
  focus?: string | undefined;
  /** Maximum number of tour steps to generate (3..20, default 8). */
  maxSteps?: number | undefined;
  /** Target reader persona: 'junior' | 'experienced' | 'architect' | 'non-technical'. */
  persona?: OnboardingPersona | undefined;
}

export interface CodebaseOnboardOutput {
  status: 'ok';
  persona: OnboardingPersona;
  summary: string;
  stats: {
    totalFiles: number;
    totalSymbols: number;
    communities: number;
    entryPoints: number;
  };
  communities: FileCommunity[];
  steps: TourStep[];
  flows: ExecutionFlow[];
  markdown: string;
}

/**
 * Extract concise language and design-pattern notes from a file's indexed symbol
 * signatures so onboarding readers understand idioms at a glance.
 */
export function extractLanguagePatternNotes(
  symbols: ReadonlyArray<{ name: string; kind: string; signature: string }>,
): string[] {
  const notes = new Set<string>();
  for (const s of symbols) {
    const sig = s.signature || '';
    if (/<[A-Z][A-Za-z0-9_,\s=extends]*>/.test(sig)) {
      notes.add('Uses generic type parameters (<T>) for type-safe polymorphism.');
    }
    if (/\basync\b|\bPromise\s*</.test(sig)) {
      notes.add('Asynchronous Promise/async execution boundary.');
    }
    if (/\bAbortSignal\b/.test(sig)) {
      notes.add('Supports cooperative cancellation via AbortSignal.');
    }
    if (/\bextends\b|\bimplements\b/.test(sig) || s.kind === 'interface' || s.kind === 'trait') {
      notes.add('Defines or implements a structural interface/inheritance contract.');
    }
    if (/=>/.test(sig)) {
      notes.add('Accepts or returns higher-order function callbacks.');
    }
    if (/^@|\bdecorator\b/i.test(sig)) {
      notes.add('Uses decorator metadata or aspect-oriented wrapping.');
    }
  }
  return [...notes];
}

/**
 * Build a deterministic, dependency-ordered architectural tour from `store`.
 */
export function buildArchitecturalTour(
  store: IndexStore,
  projectRoot: string,
  options: {
    focus?: string | undefined;
    maxSteps?: number | undefined;
    persona?: OnboardingPersona | undefined;
  } = {},
): Omit<CodebaseOnboardOutput, 'status'> {
  const maxSteps = Math.max(3, Math.min(options.maxSteps ?? 8, 20));
  const focus = options.focus?.trim().toLowerCase();
  const persona: OnboardingPersona = options.persona ?? 'experienced';

  const relativeOf = (file: string): string => {
    const rel = path.relative(projectRoot, file);
    if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      return posixIndexPath(file);
    }
    return posixIndexPath(rel);
  };

  const indexStats = store.getStats();
  const communities = detectStoreFileCommunities(store, relativeOf);
  const conceptsByFile = new Map<string, FileConcept>();
  for (const c of store.getAllFileConcepts()) {
    conceptsByFile.set(c.file, c);
    conceptsByFile.set(relativeOf(c.file), c);
  }

  const rankedRaw = store.getRankedFiles(200);
  const rankedProd = rankedRaw.filter((row) => {
    const rel = relativeOf(row.file);
    if (isTestFilePath(rel)) return false;
    if (focus && !rel.toLowerCase().includes(focus) && !row.package.toLowerCase().includes(focus)) {
      return false;
    }
    return true;
  });

  // Fallback when no ranked files exist yet (e.g. small repo with no cross-file refs)
  const candidateFiles: Array<{
    file: string;
    rel: string;
    rank: number;
    inDeg: number;
    outDeg: number;
    package: string;
  }> =
    rankedProd.length > 0
      ? rankedProd.map((r) => ({
          file: r.file,
          rel: relativeOf(r.file),
          rank: Number(r.rank.toFixed(4)),
          inDeg: r.inDeg,
          outDeg: r.outDeg,
          package: r.package,
        }))
      : store
          .getAllFileMetas()
          .map((m) => ({
            file: m.file,
            rel: relativeOf(m.file),
            rank: 0,
            inDeg: 0,
            outDeg: 0,
            package: '',
          }))
          .filter((m) => !isTestFilePath(m.rel) && (!focus || m.rel.toLowerCase().includes(focus)));

  // Order foundation-first among top central files:
  // Files with high inDeg and low outDeg (foundational schemas/types/kernels) go first,
  // followed by core hubs, then orchestrators/entry points.
  const topCandidates = candidateFiles.slice(0, maxSteps);
  const orderedCandidates = [...topCandidates].sort((a, b) => {
    const aFoundationRatio = (a.inDeg + 1) / (a.outDeg + 1);
    const bFoundationRatio = (b.inDeg + 1) / (b.outDeg + 1);
    return bFoundationRatio - aFoundationRatio || b.rank - a.rank || a.rel.localeCompare(b.rel);
  });

  const entryPoints = discoverEntryPoints(store, projectRoot, {
    fileFilter: focus,
    limit: 4,
  });
  const flows = entryPoints.map((ep) =>
    sliceExecutionFlow(store, projectRoot, ep, { maxDepth: 4, maxSteps: 8 }),
  );
  const entryFileSet = new Set(entryPoints.map((e) => e.file));

  const steps: TourStep[] = [];
  for (let i = 0; i < orderedCandidates.length; i++) {
    const item = orderedCandidates[i]!;
    const symbols = store.getFileSymbols(item.file, 6).map((s) => ({
      name: s.name,
      kind: s.kind,
      line: s.line,
      signature: s.signature,
    }));
    const concept = conceptsByFile.get(item.file) ?? conceptsByFile.get(item.rel);

    const firstLine = symbols[0]?.line ?? 1;
    const lastLine = symbols[symbols.length - 1]?.line ?? firstLine + 10;
    const lineSpan = {
      start: concept?.cruxStart ?? firstLine,
      end: concept?.cruxEnd ?? Math.max(firstLine, lastLine),
    };

    let stage: TourStage = 'hub';
    if (entryFileSet.has(item.rel)) {
      stage = 'entry-flow';
    } else if (item.outDeg === 0 || item.inDeg >= item.outDeg * 2) {
      stage = 'foundation';
    } else if (i >= Math.ceil(orderedCandidates.length / 2)) {
      stage = 'subsystem';
    }

    const conceptText = concept?.summary ? `${concept.summary} ` : '';
    const languageNotes = extractLanguagePatternNotes(symbols);
    const explanation =
      persona === 'non-technical'
        ? `${conceptText || `Core module in ${item.rel}.`} Participates in ${item.inDeg + item.outDeg} cross-module workflows.`
        : `${conceptText}Centrality rank ${item.rank.toFixed(4)} (${item.inDeg} incoming / ${item.outDeg} outgoing refs). ` +
          (symbols.length > 0
            ? `Key declarations: ${symbols.map((s) => `\`${s.name}\` (${s.kind})`).join(', ')}.`
            : 'Configuration or module boundary.');

    const stepMemories = findAnchoredSageMemories({
      projectRoot,
      files: [item.rel],
      symbols: symbols.map((s) => s.name),
      limit: 3,
    });

    steps.push({
      order: i + 1,
      stage,
      title: `Step ${i + 1}: ${item.rel} (${stage})`,
      file: item.rel,
      lineSpan,
      rank: item.rank,
      inDeg: item.inDeg,
      outDeg: item.outDeg,
      symbols,
      explanation,
      ...(languageNotes.length > 0 ? { languageNotes } : {}),
      ...(stepMemories.length > 0 ? { memories: stepMemories } : {}),
    });
  }

  // Build Markdown Onboarding Guide
  const mdLines: string[] = [
    '# Codebase Onboarding & Architecture Tour',
    '',
    `- **Indexed Files:** ${indexStats.totalFiles}`,
    `- **Indexed Symbols:** ${indexStats.totalSymbols}`,
    `- **Architectural Clusters (Louvain):** ${communities.length}`,
    `- **Discovered Entry Points:** ${entryPoints.length}`,
    '',
  ];

  if (communities.length > 0) {
    mdLines.push('## 1. Architectural Clusters (Louvain Communities)', '');
    mdLines.push('| Cluster | Hub File | Files | Cohesion | Rank |');
    mdLines.push('| --- | --- | ---: | ---: | ---: |');
    for (const comm of communities.slice(0, 10)) {
      mdLines.push(
        `| \`${comm.label}\` | \`${comm.hub}\` | ${comm.files.length} | ${(comm.cohesion * 100).toFixed(0)}% | ${comm.rank.toFixed(4)} |`,
      );
    }
    mdLines.push('');
  }

  mdLines.push('## 2. Dependency-Ordered Guided Tour', '');
  for (const step of steps) {
    mdLines.push(
      `### ${step.order}. \`${step.file}\` (L${step.lineSpan.start}–L${step.lineSpan.end}) — *${step.stage}*`,
    );
    mdLines.push(step.explanation);
    if (step.symbols.length > 0) {
      mdLines.push(
        `- **Declarations:** ${step.symbols.map((s) => `\`${s.name}\` (L${s.line})`).join(', ')}`,
      );
    }
    if (step.languageNotes && step.languageNotes.length > 0) {
      for (const note of step.languageNotes) {
        mdLines.push(`- **Language Pattern:** ${note}`);
      }
    }
    if (step.memories && step.memories.length > 0) {
      for (const mem of step.memories) {
        mdLines.push(`- **Institutional Knowledge (${mem.kind}):** ${mem.text}`);
      }
    }
    mdLines.push('');
  }

  if (flows.length > 0) {
    mdLines.push('## 3. Primary Execution Flows', '');
    for (const flow of flows) {
      mdLines.push(`### ${flow.title}`);
      for (const s of flow.steps) {
        const indent = '  '.repeat(Math.min(s.depth, 4));
        mdLines.push(
          `${indent}- **[${s.step}]** \`${s.symbol}\` (\`${s.file}:${s.line}\`)${s.calledFrom ? ` ← called by \`${s.calledFrom}\`` : ''}`,
        );
      }
      mdLines.push('');
    }
  }

  const markdown = `${mdLines.join('\n').trimEnd()}\n`;
  const summary =
    `Generated ${steps.length}-step guided architectural tour across ` +
    `${communities.length} cluster(s) and ${flows.length} execution flow(s).`;

  return {
    persona,
    summary,
    stats: {
      totalFiles: indexStats.totalFiles,
      totalSymbols: indexStats.totalSymbols,
      communities: communities.length,
      entryPoints: entryPoints.length,
    },
    communities,
    steps,
    flows,
    markdown,
  };
}

/**
 * Persist the Guided Architectural Tour to `.wrongstack/atlas/ONBOARDING.md`.
 */
export async function writeOnboardingAtlas(
  store: IndexStore,
  projectRoot: string,
  opts: CodebaseOnboardInput = {},
): Promise<{ path: string; tour: Omit<CodebaseOnboardOutput, 'status'> }> {
  const tour = buildArchitecturalTour(store, projectRoot, opts);
  const atlasDir = await ensureAtlasDir(projectRoot);
  await writeAtlasFile(atlasDir, ATLAS_ONBOARDING, tour.markdown);
  return {
    path: posixIndexPath(path.join(ATLAS_DIR, ATLAS_ONBOARDING)),
    tour,
  };
}

export const codebaseOnboardTool: Tool<CodebaseOnboardInput, CodebaseOnboardOutput> = {
  name: 'codebase-onboard',
  category: 'Project',
  icon: 'index',
  permission: 'auto',
  mutating: false,
  capabilities: ['fs.read'],
  timeoutMs: 35_000,
  description:
    'Generate a dependency-ordered Guided Architectural Tour and Onboarding Guide for the repository. ' +
    'Synthesizes PageRank hubs, Louvain community clusters, crux line spans, and forward execution flows.',
  usageHint:
    'USE WHEN ONBOARDING TO A NEW REPOSITORY OR SUBSYSTEM:\n\n' +
    '- Call `codebase-onboard({})` to get a step-by-step reading order from foundational types up to entry points.\n' +
    '- Pass `focus: "auth"` to generate a focused tour for a specific package or subsystem.',
  inputSchema: {
    type: 'object',
    properties: {
      focus: {
        type: 'string',
        description:
          'Optional package, directory, or topic substring to focus the onboarding tour.',
      },
      maxSteps: {
        type: 'number',
        description: 'Maximum number of tour steps to generate (3..20, default 8).',
      },
      persona: {
        type: 'string',
        enum: ['junior', 'experienced', 'architect', 'non-technical'],
        description:
          'Target reader persona (default "experienced"). Adapts explanations and language pattern notes.',
      },
    },
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const projectRoot = ctx.projectRoot ?? ctx.cwd ?? process.cwd();
    const indexDir = codebaseIndexDirOverride(ctx);
    const indexDbPath = path.join(resolveIndexDir(projectRoot, indexDir), 'index.db');

    if (!existsSync(indexDbPath)) {
      throw new Error(
        'No persisted index data found. Run codebase-index to build it, then retry codebase-onboard.',
      );
    }

    const store = indexStorePool.acquire(projectRoot, { indexDir });
    try {
      const tour = buildArchitecturalTour(store, projectRoot, {
        focus: input?.focus,
        maxSteps: input?.maxSteps,
        persona: input?.persona,
      });
      return {
        status: 'ok',
        ...tour,
      };
    } finally {
      indexStorePool.release(store);
    }
  },
};
