import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import {
  CAPTURE_COOLDOWN_MS,
  CAPTURE_MAX_PER_SESSION,
  captureWindowState,
  recordCaptureAttempt,
} from './project-agent-capture-window.js';
import {
  type ConsolidationMetadata,
  isConsolidated,
  loadConsolidationMetadata,
} from './project-agent-consolidation.js';
import { listProjectAgentRoles } from './project-agent-files.js';
import type { LearnedCaptureResult } from './project-agent-identity-types.js';
import { splitLearnedEntries, tokenOverlap } from './project-agent-learning-entries.js';
import {
  LEARNED_HARD_LIMIT,
  LEARNED_SOFT_LIMIT,
  normalizeForComparison,
  normalizeLearnedEntry,
} from './project-agent-learning-normalize.js';
import {
  loadProjectAgentLearningPolicy,
  type ProjectAgentLearningPolicy,
  updateProjectAgentLearningPolicy,
} from './project-agent-learning-policy.js';
import {
  directiveTrials,
  enforceLearnedBudget,
  mergeStructuredEntries,
  parseStructuredLearnedEntriesFromContent,
  renderLearnedInstructions,
  type StructuredLearnedEntry,
} from './project-agent-learning-structured.js';
import { assertProjectAgentRole, roleDir, writeTextAtomically } from './project-agent-paths.js';
import {
  listProjectSkillAugmentations,
  recordSkillLearned,
  resolveRoleSkillCandidates,
  routeDirectiveToSkill,
} from './project-agent-skill-layer.js';

export function loadProjectAgentLearned(role: string, projectRoot?: string): string {
  const learnedPath = path.join(roleDir(role, projectRoot), 'learned.md');
  try {
    return readFileSync(learnedPath, 'utf8').trim();
  } catch {
    return '';
  }
}

export function listProjectAgentLearnedEntries(role: string, projectRoot?: string): string[] {
  return splitLearnedEntries(loadProjectAgentLearned(role, projectRoot));
}

export function parseStructuredLearnedEntries(
  role: string,
  projectRoot?: string,
): StructuredLearnedEntry[] {
  const raw = loadProjectAgentLearned(role, projectRoot);
  return parseStructuredLearnedEntriesFromContent(
    raw,
    listProjectAgentLearnedEntries(role, projectRoot),
  );
}

export function resolveCaptureKey(role: string, projectRoot?: string): string {
  return `${path.resolve(projectRoot ?? process.cwd())}\0${assertProjectAgentRole(role)}`;
}

export function canCaptureNewLearned(
  role: string,
  _existingSize: number,
  isManual: boolean,
  projectRoot?: string,
): string | undefined {
  if (isManual) return undefined;
  const key = resolveCaptureKey(role, projectRoot);
  const now = Date.now();
  const state = captureWindowState(key, now);

  if (state.lastCaptureAt !== undefined && now - state.lastCaptureAt < CAPTURE_COOLDOWN_MS) {
    const remaining = Math.ceil((CAPTURE_COOLDOWN_MS - (now - state.lastCaptureAt)) / 1000);
    return `Cooldown active for role "${role}" (${remaining}s remaining)`;
  }
  if (state.remaining <= 0) {
    return `Frequency cap reached for role "${role}" (${state.count}/${CAPTURE_MAX_PER_SESSION} in this window). Use /agent-improve ${role} capture for manual override.`;
  }
  return undefined;
}

export interface ProjectAgentLearnStats {
  role: string;
  exists: boolean;
  entryCount: number;
  totalBytes: number;
  lastCapture: string | null;
  lastCaptureTimestamp: number | null;
  cooldownRemainingMs: number;
  sessionCaptureCount: number;
  needsSummarization: boolean;
  learnedPath: string | null;
  identityPath: string | null;
  hasIdentity: boolean;
  hasConfig: boolean;
  hasKnowledge: boolean;
  learningEnabled: boolean;
  lifetimeCaptureCount: number;
  lastCaptureSource: ProjectAgentLearningPolicy['lastCaptureSource'] | null;
  isConsolidated: boolean;
  consolidation?: ConsolidationMetadata | undefined;
  skills: string[];
  skilledEntryCount: number;
  appliedEntryCount: number;
  deadEntryCount: number;
  directiveHitRate: number | null;
}

export function getProjectAgentLearnStats(
  role: string,
  projectRoot?: string,
): ProjectAgentLearnStats {
  const dir = roleDir(role, projectRoot);
  const learnedPath_ = path.join(dir, 'learned.md');
  const identityPath_ = path.join(dir, 'identity.md');
  const configPath_ = path.join(dir, 'config.json');
  const knowledgePath_ = path.join(dir, 'knowledge.json');
  let learnedText = '';
  try {
    learnedText = readFileSync(learnedPath_, 'utf8');
  } catch {
    /* no file */
  }
  const entries = parseStructuredLearnedEntries(role, projectRoot);
  const skillAugmentations = listProjectSkillAugmentations(role, projectRoot);
  const exists = existsSync(dir);
  const policy = loadProjectAgentLearningPolicy(role, projectRoot);
  const captureKey = resolveCaptureKey(role, projectRoot);
  const window = captureWindowState(captureKey);
  const runtimeLastTs = window.lastCaptureAt ?? null;
  const persistedLastTs = policy.lastCaptureAt ? Date.parse(policy.lastCaptureAt) : Number.NaN;
  const lastTs = runtimeLastTs ?? (Number.isFinite(persistedLastTs) ? persistedLastTs : null);
  const cooldownRemaining = lastTs ? Math.max(0, CAPTURE_COOLDOWN_MS - (Date.now() - lastTs)) : 0;
  const freq = window.count;

  const trials = entries.map((entry) => directiveTrials(entry));
  const totalApplied = trials.reduce((sum, trial) => sum + trial.applied, 0);
  const totalWins = trials.reduce((sum, trial) => sum + trial.wins, 0);

  return {
    role,
    exists,
    entryCount: entries.length,
    skills: skillAugmentations,
    skilledEntryCount: entries.filter((entry) => entry.skill).length,
    appliedEntryCount: trials.filter((trial) => trial.applied > 0).length,
    deadEntryCount: trials.filter((trial) => trial.applied === 0).length,
    directiveHitRate: totalApplied > 0 ? totalWins / totalApplied : null,
    totalBytes: Buffer.byteLength(learnedText, 'utf8'),
    lastCapture: lastTs ? new Date(lastTs).toISOString() : null,
    lastCaptureTimestamp: lastTs,
    cooldownRemainingMs: cooldownRemaining,
    sessionCaptureCount: freq,
    needsSummarization: exists
      ? hintLearnedNeedsSummarization(role, projectRoot).length > 0
      : false,
    learnedPath: existsSync(learnedPath_) ? learnedPath_ : null,
    identityPath: existsSync(identityPath_) ? identityPath_ : null,
    hasIdentity: existsSync(identityPath_),
    hasConfig: existsSync(configPath_),
    hasKnowledge: existsSync(knowledgePath_),
    learningEnabled: policy.enabled,
    lifetimeCaptureCount: policy.lifetimeCaptureCount,
    lastCaptureSource: policy.lastCaptureSource ?? null,
    isConsolidated: isConsolidated(role, projectRoot),
    consolidation: loadConsolidationMetadata(role, projectRoot),
  };
}

export function detectLearnedConflicts(projectRoot?: string): Array<{
  roleA: string;
  roleB: string;
  snippetA: string;
  snippetB: string;
  similarity: number;
  detectedAt: string;
}> {
  const roles = listProjectAgentRoles(projectRoot);
  const entries: { role: string; normalized: string; raw: string }[] = [];
  for (const role of roles) {
    for (const entry of parseStructuredLearnedEntries(role, projectRoot)) {
      if (entry.what.trim().length < 50) continue;
      entries.push({
        role,
        normalized: normalizeForComparison(entry.what),
        raw: entry.what,
      });
    }
  }
  const conflicts: Array<{
    roleA: string;
    roleB: string;
    snippetA: string;
    snippetB: string;
    similarity: number;
    detectedAt: string;
  }> = [];
  for (const [i, a] of entries.entries()) {
    for (const b of entries.slice(i + 1)) {
      const sim = tokenOverlap(a.normalized, b.normalized);
      if (sim >= 0.6) {
        conflicts.push({
          roleA: a.role,
          roleB: b.role,
          snippetA: a.raw.slice(0, 200),
          snippetB: b.raw.slice(0, 200),
          similarity: sim,
          detectedAt: new Date().toISOString(),
        });
      }
    }
  }
  return conflicts.sort((a, b) => b.similarity - a.similarity);
}

export function captureLearnedFromAgentOutput(
  output: string,
  role: string,
  projectRoot?: string,
  isManual = false,
): number {
  return captureLearnedFromAgentOutputDetailed(output, role, projectRoot, isManual).captured;
}

export function captureLearnedFromAgentOutputDetailed(
  output: string,
  role: string,
  projectRoot?: string,
  isManual = false,
): LearnedCaptureResult {
  const normalizedRole = assertProjectAgentRole(role);
  if (!output.trim()) {
    return { role: normalizedRole, captured: 0, skipped: 0, status: 'empty_output' };
  }
  const policy = loadProjectAgentLearningPolicy(normalizedRole, projectRoot);
  if (!policy.enabled && !isManual) {
    return {
      role: normalizedRole,
      captured: 0,
      skipped: 0,
      status: 'disabled',
      reason: 'Automatic learning is disabled for this role.',
    };
  }

  const regex = /^##[ \t]*LEARNED\b[^\n]*$/gim;
  const candidates: { heading: string; body: string }[] = [];
  let startMatch = regex.exec(output);
  while (startMatch !== null) {
    const blockStart = startMatch.index + startMatch[0].length;
    const rest = output.slice(blockStart);
    // The delimiter must recognise every heading the block-start regex accepts.
    // `/^##\s/` alone misses a no-space `##LEARNED` heading (`[ \t]*` allows
    // zero whitespace), silently absorbing the second block into the first.
    const nextHeading = /^##(?:\s|LEARNED\b)/gim.exec(rest);
    const blockEnd = nextHeading ? blockStart + nextHeading.index : output.length;
    candidates.push({
      heading: startMatch[0],
      body: output.slice(blockStart, blockEnd).trim(),
    });
    regex.lastIndex = Math.max(regex.lastIndex, blockEnd);
    startMatch = regex.exec(output);
  }
  if (candidates.length === 0) {
    return { role: normalizedRole, captured: 0, skipped: 0, status: 'no_blocks' };
  }

  const existingRaw = loadProjectAgentLearned(normalizedRole, projectRoot);
  const guard = canCaptureNewLearned(
    normalizedRole,
    Buffer.byteLength(existingRaw, 'utf8'),
    isManual,
    projectRoot,
  );
  if (guard) {
    return {
      role: normalizedRole,
      captured: 0,
      skipped: candidates.length,
      status: 'guarded',
      reason: guard,
    };
  }

  let structuredEntries = parseStructuredLearnedEntries(normalizedRole, projectRoot);
  const normalizedEntries = structuredEntries.map((entry) => entry.key);
  const skillCandidates = resolveRoleSkillCandidates(normalizedRole, projectRoot);
  const routedSkills: string[] = [];
  let captured = 0;
  let skipped = 0;
  const now = new Date();
  const nowIso = now.toISOString();
  const key = resolveCaptureKey(normalizedRole, projectRoot);
  const remainingSessionCaptures = isManual
    ? Number.POSITIVE_INFINITY
    : captureWindowState(key, now.getTime()).remaining;

  for (const { heading, body: content } of candidates) {
    if (captured >= remainingSessionCaptures) {
      skipped++;
      continue;
    }
    const normalized = normalizeLearnedEntry(content);
    if (!normalized) {
      skipped++;
      continue;
    }
    const totalLines = Math.max(1, content.split('\n').length);
    const codeBodyLines = (content.match(/```[\s\S]*?```/g) ?? []).reduce(
      (sum, block) => sum + Math.max(0, block.split('\n').length - 2),
      0,
    );
    if (totalLines > 5 && codeBodyLines / totalLines > 0.7) {
      skipped++;
      continue;
    }
    const candidateNorm = normalizeForComparison(normalized.text);
    if (normalizedEntries.some((entry) => tokenOverlap(candidateNorm, entry) >= 0.55)) {
      skipped++;
      continue;
    }
    normalizedEntries.push(candidateNorm);
    const skill =
      routeDirectiveToSkill(heading, skillCandidates) ??
      routeDirectiveToSkill(content, skillCandidates) ??
      routeDirectiveToSkill(normalized.text, skillCandidates);
    if (skill) routedSkills.push(skill);
    structuredEntries = mergeStructuredEntries(structuredEntries, {
      text: normalized.text,
      category: normalized.category,
      capturedAt: nowIso,
      ...(skill ? { skill } : {}),
    });
    captured++;
  }

  if (captured === 0) {
    return {
      role: normalizedRole,
      captured: 0,
      skipped,
      status: 'quality_rejected',
      reason:
        'Every LEARNED block was too short, too narrative, or a near-duplicate. Write directives, not session logs.',
    };
  }

  const budget = enforceLearnedBudget(
    structuredEntries,
    nowIso,
    Math.max(LEARNED_SOFT_LIMIT, Math.min(LEARNED_HARD_LIMIT, LEARNED_SOFT_LIMIT)),
    normalizedRole,
  );
  const newContent = renderLearnedInstructions(normalizedRole, budget.kept, nowIso);

  writeTextAtomically(path.join(roleDir(normalizedRole, projectRoot), 'learned.md'), newContent);
  recordCaptureAttempt(key, now.getTime());
  for (const skill of new Set(routedSkills)) {
    try {
      recordSkillLearned(normalizedRole, skill, projectRoot);
    } catch {
      // Affinity bookkeeping must never fail a capture.
    }
  }
  updateProjectAgentLearningPolicy(
    normalizedRole,
    {
      lifetimeCaptureCount: policy.lifetimeCaptureCount + captured,
      lastCaptureAt: now.toISOString(),
      lastCaptureSource: isManual ? 'manual' : 'automatic',
    },
    projectRoot,
  );
  return {
    role: normalizedRole,
    captured,
    skipped,
    status: 'captured',
    ...(routedSkills.length > 0 ? { skills: [...new Set(routedSkills)] } : {}),
    ...(budget.dropped.length > 0 ? { evicted: budget.dropped.length } : {}),
  };
}

export function hintLearnedNeedsSummarization(role: string, projectRoot?: string): string {
  const learned = loadProjectAgentLearned(role, projectRoot);
  if (!learned) return '';
  const bytes = Buffer.byteLength(learned, 'utf8');
  if (bytes < LEARNED_SOFT_LIMIT) return '';
  return `Learned wisdom for role "${role}" is ${bytes} B (soft limit ${LEARNED_SOFT_LIMIT}). Schedule a low-priority consolidation pass.`;
}
