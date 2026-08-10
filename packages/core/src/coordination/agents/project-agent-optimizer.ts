/**
 * Learning optimization pass: raw captures → consolidated role document +
 * per-skill project addenda → pruned capture buffer.
 *
 * One implementation, shared by every surface. The CLI used to build the
 * instruction and hand it to the chat loop with nothing on the other end to
 * persist the result, so `/agent-improve <role> consolidate` produced a wall of
 * markdown and no state change; the WebUI had the only working pipeline.
 */

import { isTextBlock } from '../../types/blocks.js';
import type { Provider, Request } from '../../types/index.js';
import {
  buildConsolidationInstruction,
  readRawLearnedEntries,
  saveProjectAgentConsolidated,
} from './project-agent-consolidation.js';
import { recordProjectAgentOptimizePass } from './project-agent-learning-policy.js';
import {
  directiveTrials,
  type StructuredLearnedEntry,
} from './project-agent-learning-structured.js';
import { assertProjectAgentRole } from './project-agent-paths.js';
import { retiredDirectivesToWarnAbout } from './project-agent-quarantine.js';
import {
  buildSkillDistillInstruction,
  loadProjectSkillAugmentation,
  renderSkillAugmentation,
  saveProjectSkillAugmentation,
} from './project-agent-skill-layer.js';

/** Resolved model handle used for headless synthesis. */
export interface LearningOptimizerLlm {
  provider: Provider;
  model: string;
}

export interface OptimizeLearningOptions {
  llm?: LearningOptimizerLlm | undefined;
  trigger?: 'manual' | 'automatic' | undefined;
  /** Archive + reset the raw buffer after a successful pass. Default true. */
  prune?: boolean | undefined;
  maxTokens?: number | undefined;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
}

export interface OptimizeLearningResult {
  role: string;
  status: 'optimized' | 'no-entries' | 'no-llm' | 'empty-synthesis' | 'failed';
  rawEntryCount: number;
  /** Skills whose project addendum was refreshed by this pass. */
  skills: string[];
  content?: string | undefined;
  model?: string | undefined;
  pruned?: boolean | undefined;
  /** Present on `no-llm`: the caller may drive the pass through a chat agent. */
  instruction?: string | undefined;
  error?: string | undefined;
}

const DEFAULT_MAX_TOKENS = 8_000;
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * One directive as the distiller sees it: the rule, its runnable anchors, and
 * its track record when it has one.
 *
 * The track record is what turns distillation from a summarisation pass into a
 * selection pass. Without it the model is choosing between directives on
 * plausibility alone, which is exactly the judgement the project already made
 * when it captured them.
 */
function describeDirective(entry: StructuredLearnedEntry): string {
  const parts = [entry.what];
  if (entry.how) parts.push(`(anchors: ${entry.how.split('\n').join(', ')})`);
  const { applied, wins } = directiveTrials(entry);
  if (applied > 0) parts.push(`[applied ${applied}×, ${wins} ok]`);
  return parts.join(' ');
}

/** Strip a whole-document code fence a model sometimes wraps output in. */
export function unwrapWholeDocumentFence(text: string): string {
  const wholeDocFence = /^```(?:markdown|md)?[^\n]*\n([\s\S]*?)\n?```\s*$/i;
  const inner = wholeDocFence.exec(text.trim())?.[1];
  return inner !== undefined ? inner.trim() : text.trim();
}

async function complete(
  llm: LearningOptimizerLlm,
  system: string,
  instruction: string,
  options: OptimizeLearningOptions,
): Promise<string> {
  const req: Request = {
    model: llm.model,
    system: [{ type: 'text', text: system }],
    messages: [{ role: 'user', content: instruction }],
    maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
  };
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('optimization timeout'));
  }, timeoutMs);
  timer.unref?.();
  const onOuterAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', onOuterAbort, { once: true });
  try {
    const res = await llm.provider.complete(req, { signal: controller.signal });
    return unwrapWholeDocumentFence(
      res.content
        .filter(isTextBlock)
        .map((block) => block.text)
        .join('\n'),
    );
  } catch (error) {
    if (timedOut) throw new Error(`optimization timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onOuterAbort);
  }
}

const CONSOLIDATION_SYSTEM =
  "You are a precise technical editor. You consolidate an AI agent role's captured " +
  'learning entries into a single, durable, role-scoped instruction document. Output ' +
  'ONLY the consolidated markdown document — no preamble, no code fences, no commentary ' +
  'about the consolidation process.';

const SKILL_SYSTEM =
  'You are a precise technical editor. You write the project-specific addendum for one ' +
  'skill of one AI agent role: the delta between the general skill and how it must be ' +
  'applied in this codebase. Output ONLY the markdown addendum.';

/**
 * Run the full optimization pass for one role.
 *
 * Without an LLM the pass degrades rather than failing: the role-level
 * instruction is returned for a caller-driven consolidation, and each skill
 * still gets a deterministically rendered addendum from its routed directives,
 * so tagged learning reaches the skill layer even on a headless box.
 */
export async function optimizeProjectAgentLearning(
  role: string,
  projectRoot?: string,
  options: OptimizeLearningOptions = {},
): Promise<OptimizeLearningResult> {
  const normalizedRole = assertProjectAgentRole(role);
  const entries = readRawLearnedEntries(normalizedRole, projectRoot);
  const base = { role: normalizedRole, rawEntryCount: entries.length, skills: [] as string[] };
  if (entries.length === 0) return { ...base, status: 'no-entries' };

  const bySkill = new Map<string, string[]>();
  for (const entry of entries) {
    if (!entry.skill) continue;
    const bucket = bySkill.get(entry.skill) ?? [];
    bucket.push(describeDirective(entry));
    bySkill.set(entry.skill, bucket);
  }
  const at = new Date().toISOString();

  // ── Skill addenda ───────────────────────────────────────────────────────
  // Written before the role document so a failure part-way through still
  // leaves the skill layer improved rather than leaving nothing behind.
  const refreshed: string[] = [];
  for (const [skill, directives] of bySkill) {
    const existing = loadProjectSkillAugmentation(normalizedRole, skill, projectRoot);
    // The fallback merges onto the existing addendum. Rendering from the
    // buffer alone and writing it over the file deleted everything distilled
    // by earlier passes, because the buffer is pruned after each one.
    let body = renderSkillAugmentation(normalizedRole, skill, directives, at, existing);
    if (options.llm) {
      try {
        const synthesized = await complete(
          options.llm,
          SKILL_SYSTEM,
          buildSkillDistillInstruction(
            normalizedRole,
            skill,
            directives,
            existing,
            retiredDirectivesToWarnAbout(normalizedRole, directives, projectRoot, skill),
          ),
          options,
        );
        if (synthesized) body = synthesized;
      } catch {
        // Fall back to the merged rendering: an un-distilled addendum is still
        // the project's practice for that skill.
      }
    }
    saveProjectSkillAugmentation(normalizedRole, skill, body, projectRoot);
    refreshed.push(skill);
  }

  // ── Role-level consolidation ────────────────────────────────────────────
  const { instruction } = buildConsolidationInstruction(normalizedRole, projectRoot);
  if (!options.llm) {
    // A model-less pass still rewrote the skill layer, so it counts as a pass.
    // Leaving it unstamped is what made `minIntervalMs` a no-op on a headless
    // box: the cooldown only ever read consolidation metadata, which this path
    // never writes.
    recordProjectAgentOptimizePass(normalizedRole, projectRoot, at);
    return { ...base, status: 'no-llm', skills: refreshed, instruction };
  }

  let content: string;
  try {
    content = await complete(options.llm, CONSOLIDATION_SYSTEM, instruction, options);
  } catch (error) {
    return {
      ...base,
      status: 'failed',
      skills: refreshed,
      error: error instanceof Error ? error.message : 'optimization failed',
    };
  }
  if (!content) {
    recordProjectAgentOptimizePass(normalizedRole, projectRoot);
    return { ...base, status: 'empty-synthesis', skills: refreshed, model: options.llm.model };
  }

  const prune = options.prune ?? true;
  try {
    saveProjectAgentConsolidated(normalizedRole, content, projectRoot, {
      trigger: options.trigger ?? 'manual',
      model: options.llm.model,
      prune,
      skills: refreshed,
    });
  } catch (error) {
    return {
      ...base,
      status: 'failed',
      skills: refreshed,
      error: error instanceof Error ? error.message : 'failed to persist consolidation',
    };
  }

  recordProjectAgentOptimizePass(normalizedRole, projectRoot);
  return {
    ...base,
    status: 'optimized',
    skills: refreshed,
    content,
    model: options.llm.model,
    pruned: prune,
  };
}
