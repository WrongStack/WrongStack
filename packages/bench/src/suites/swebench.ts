import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BenchSuite, BenchTask } from '../types.js';

/**
 * SWE-bench Verified adapter (Phase 2).
 *
 * Unlike polyglot (a self-contained directory of exercises), SWE-bench requires
 * a materialized repo at a specific base commit AND the task's pinned execution
 * environment — which the official harness ships as per-instance Docker images.
 * Running it without Docker is not meaningful, so this adapter is wired and
 * fingerprint-aware but gated: `loadTasks` throws an actionable error unless a
 * prepared dataset directory is supplied and `docker` is enabled.
 *
 * The fixed instance subset lives in `subsets/swe-bench-verified-50.json` so a
 * model comparison always grades the exact same issues (reproducibility).
 */
export interface SwebenchOptions {
  /**
   * Directory of prepared instances. Expected layout (produced by your
   * SWE-bench setup step — see packages/bench/README.md):
   *   <datasetDir>/<instance_id>/
   *     repo/                 ← git checkout at base_commit
   *     instance.json         ← { problem_statement, test_patch, FAIL_TO_PASS, PASS_TO_PASS, image }
   */
  datasetDir?: string | undefined;
  /** Must be true to actually build tasks — the env is Docker-backed. */
  docker?: boolean | undefined;
  /** Override the committed subset file. */
  subsetFile?: string | undefined;
}

export interface SwebenchMeta {
  instanceId: string;
  instanceDir: string;
  image?: string | undefined;
  failToPass: string[];
  passToPass: string[];
  testPatch?: string | undefined;
}

const SUBSET_FILE = 'swe-bench-verified-50.json';

/**
 * Locate the committed subset file. The relative depth differs between the
 * bundled artifact (`dist/index.js` → `../subsets`) and source execution
 * (`src/suites/swebench.js` → `../../subsets`), so try both and use whichever
 * exists.
 */
async function resolveDefaultSubset(): Promise<string> {
  const candidates = [
    fileURLToPath(new URL(`../subsets/${SUBSET_FILE}`, import.meta.url)),
    fileURLToPath(new URL(`../../subsets/${SUBSET_FILE}`, import.meta.url)),
  ];
  for (const c of candidates) {
    try {
      await fs.access(c);
      return c;
    } catch {
      // try next
    }
  }
  /* v8 ignore next -- one candidate always resolves in a real checkout (the subset is committed); this fallback only fires if the artifact is missing. */
  return candidates[0] as string;
}

/** Read the pinned instance-id subset (the canonical task set). */
export async function loadSubset(subsetFile?: string): Promise<string[]> {
  const file = subsetFile ?? (await resolveDefaultSubset());
  const raw = await fs.readFile(file, 'utf8');
  const parsed = JSON.parse(raw) as { instances?: unknown };
  if (!Array.isArray(parsed.instances)) {
    throw new Error(`subset file ${file} is missing an "instances" array`);
  }
  return parsed.instances.filter((x): x is string => typeof x === 'string');
}

export function createSwebenchSuite(opts: SwebenchOptions = {}): BenchSuite {
  return {
    id: 'swebench',
    async loadTasks({ limit }) {
      const instanceIds = await loadSubset(opts.subsetFile);

      // A dataset dir (materialized repos at base commit) is required to run the
      // agent at all. Docker is only needed for INLINE grading; without it we
      // still run the agent and export predictions for the official harness.
      if (!opts.datasetDir) {
        throw new Error(
          'SWE-bench requires a prepared dataset directory (materialized repos).\n' +
            'Run with `--dataset-dir <path>`; add `--docker` to grade inline, or omit it to ' +
            'export predictions.jsonl for the official harness.\n' +
            `The pinned subset (${instanceIds.length} instances) is committed in ` +
            'packages/bench/subsets/swe-bench-verified-50.json. See packages/bench/README.md ' +
            'for the dataset-preparation steps.',
        );
      }

      const tasks: BenchTask[] = [];
      for (const id of instanceIds) {
        const instanceDir = path.join(opts.datasetDir, id);
        let meta: { problem_statement?: string } & Record<string, unknown>;
        try {
          meta = JSON.parse(await fs.readFile(path.join(instanceDir, 'instance.json'), 'utf8'));
        } catch {
          continue; // instance not materialized — skip
        }
        const swMeta: SwebenchMeta = {
          instanceId: id,
          instanceDir,
          image: meta['image'] as string | undefined,
          failToPass: (meta['FAIL_TO_PASS'] as string[] | undefined) ?? [],
          passToPass: (meta['PASS_TO_PASS'] as string[] | undefined) ?? [],
          testPatch: meta['test_patch'] as string | undefined,
        };
        tasks.push({
          id: `swebench/${id}`,
          suite: 'swebench',
          prompt: buildPrompt(
            typeof meta.problem_statement === 'string' ? meta.problem_statement : '',
          ),
          templateDir: path.join(instanceDir, 'repo'),
          meta: swMeta as never as Record<string, unknown>,
        });
        if (limit !== undefined && tasks.length >= limit) break;
      }
      return tasks;
    },
    subsetId(tasks) {
      const ids = tasks.map((t) => t.id).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      return `swebench:${createHash('sha256').update(ids.join('\n')).digest('hex').slice(0, 12)}`;
    },
  };
}

function buildPrompt(problemStatement: string): string {
  return [
    problemStatement,
    '',
    '---',
    '',
    'You are working in a checkout of the repository. Resolve the issue above by editing the',
    'source. Do not edit test files. Use the available tools to explore and modify the code.',
    'When the fix is complete, stop.',
  ].join('\n');
}
