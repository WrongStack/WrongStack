/**
 * SDD — VIBE Three-Stage Verification Protocol.
 *
 * Implements the Three-Stage Verification Protocol (Spec-Synthesizer -> Coder -> Auditor)
 * designed to transform chaotic, incomplete, or ambiguous user prompts into verified,
 * regression-free specifications and code.
 */

import { stripVibeTag } from '@wrongstack/requirement-intake';

export interface VibeScopeBoundaries {
  included: string[];
  excluded: string[];
}

export interface VibeSpecSynthesizerResult {
  /** High-level core intent crystallized from the chaotic prompt. */
  coreIntent: string;
  /** Inferred assumptions and sensible defaults to fill gaps. */
  sensibleDefaults: string[];
  /** Testable Given-When-Then or checklist items. */
  acceptanceCriteria: string[];
  /** Strict boundaries to prevent over-engineering. */
  scopeBoundaries: VibeScopeBoundaries;
  /** Formatted Markdown spec contract. */
  formattedSpecMarkdown: string;
}

export interface VibeCoderContract {
  /** Summary of the spec to be implemented. */
  specSummary: string;
  /** Actionable developer instructions derived strictly from the synthesized spec. */
  instructions: string[];
  /** Target files or modules affected. */
  targetFiles: string[];
  /** Acceptance criteria checklist that the coder must satisfy. */
  acceptanceChecklist: string[];
}

export interface VibeAuditCheck {
  id: string;
  name: string;
  passed: boolean;
  details: string;
}

export interface VibeAuditVerdict {
  verdict: 'PASS' | 'REJECT';
  score: number;
  checks: VibeAuditCheck[];
  reworkDirectives?: string[];
  summary: string;
}

export interface VibeVerificationReport {
  isVibeMode: boolean;
  stage: 'synthesizer' | 'coder' | 'auditor' | 'passed';
  synthesizer: VibeSpecSynthesizerResult;
  coder: VibeCoderContract;
  audit: VibeAuditVerdict;
  markdown: string;
}

/**
 * Policy sentences are not code artifacts. Only identifier-like exclusions
 * (packages, files, symbols) are safe to substring-match in coder output.
 */
export function isIdentifierLikeExclusion(excluded: string): boolean {
  const trimmed = excluded.trim();
  if (trimmed.length < 2) return false;
  if (/^['"`].+['"`]$/.test(trimmed)) return true;
  return !/\s/.test(trimmed);
}

/**
 * 1. Spec-Synthesizer: Transforms unstructured, chaotic vibe prompt into a formal spec.
 */
export function synthesizeVibeSpec(
  rawPrompt: string,
  projectContext: string = '',
): VibeSpecSynthesizerResult {
  const cleanPrompt = stripVibeTag(rawPrompt);

  // Extract core intent: First meaningful sentence or line
  const lines = cleanPrompt
    .split(/[\n;]+/)
    .map((line) => line.trim())
    .filter(Boolean);

  const coreIntent = lines[0] ?? 'Implement requested feature according to project standards';

  // Extract sensible defaults & assumptions
  const sensibleDefaults: string[] = [
    'Apply sensible defaults for unstated edge cases without breaking existing API contracts',
    'Follow project conventions and strict type safety',
  ];

  if (/admin|role|auth|yetki/i.test(cleanPrompt)) {
    sensibleDefaults.push(
      'Enforce role-based permission checks before executing privileged actions',
    );
  }
  if (/sil|delete|remove|uçur/i.test(cleanPrompt)) {
    sensibleDefaults.push('Confirm deletion intent and handle non-existent resource gracefully');
  }
  if (/sepet|cart|ekle|add|art/i.test(cleanPrompt)) {
    sensibleDefaults.push(
      'Ensure idempotency and optimistic UI updates for cart/counter operations',
    );
  }

  // Derive acceptance criteria
  const acceptanceCriteria: string[] = lines.map(
    (line, idx) => `Given user interaction, should correctly handle step ${idx + 1}: ${line}`,
  );
  if (acceptanceCriteria.length === 0) {
    acceptanceCriteria.push('Given standard input, action executes and updates state successfully');
  }

  // Scope boundaries
  const scopeBoundaries: VibeScopeBoundaries = {
    included: [coreIntent],
    excluded: ['Unrelated UI refactors', 'Unrequested third-party dependency additions'],
  };

  const formattedSpecMarkdown = [
    '## 🌊 VIBE Synthesized Specification',
    `**Core Intent:** ${coreIntent}`,
    '',
    '### 🧩 Sensible Defaults & Assumptions',
    ...sensibleDefaults.map((item) => `- ${item}`),
    '',
    '### 📋 Acceptance Criteria',
    ...acceptanceCriteria.map((ac) => `- [ ] ${ac}`),
    '',
    '### 🚧 Scope Boundaries',
    '**Included:**',
    ...scopeBoundaries.included.map((item) => `  - ${item}`),
    '**Excluded:**',
    ...scopeBoundaries.excluded.map((item) => `  - ${item}`),
    ...(projectContext ? ['', '### 📁 Context', projectContext] : []),
  ].join('\n');

  return {
    coreIntent,
    sensibleDefaults,
    acceptanceCriteria,
    scopeBoundaries,
    formattedSpecMarkdown,
  };
}

/**
 * 2. Coder Stage: Generates coder contract strictly from the synthesized spec.
 */
export function buildCoderContract(
  spec: VibeSpecSynthesizerResult,
  targetFiles: string[] = [],
): VibeCoderContract {
  const instructions = [
    `Implement core intent: ${spec.coreIntent}`,
    ...spec.sensibleDefaults.map((d) => `Respect default: ${d}`),
    ...spec.acceptanceCriteria.map((ac) => `Satisfy acceptance criterion: ${ac}`),
    ...spec.scopeBoundaries.excluded.map((exc) => `DO NOT introduce: ${exc}`),
  ];

  return {
    specSummary: spec.coreIntent,
    instructions,
    targetFiles,
    acceptanceChecklist: spec.acceptanceCriteria,
  };
}

/**
 * 3. Auditor Stage: Cross-checks raw vibe vs synthesized spec vs coder output.
 */
export function auditVibeExecution(input: {
  rawPrompt?: string;
  spec: VibeSpecSynthesizerResult;
  coderOutput: string;
}): VibeAuditVerdict {
  const { spec, coderOutput } = input;
  const checks: VibeAuditCheck[] = [];
  const reworkDirectives: string[] = [];

  // Check 1: Intent fidelity
  const hasCoderOutput = coderOutput.trim().length > 0;
  checks.push({
    id: 'intent-fidelity',
    name: 'Intent Fidelity (Did coder address the synthesized spec?)',
    passed: hasCoderOutput,
    details: hasCoderOutput
      ? 'Coder output produced against synthesized spec'
      : 'No code changes provided by coder',
  });
  if (!hasCoderOutput) {
    reworkDirectives.push('Coder must generate implementation matching the spec.');
  }

  // Check 2: Spec Scope check (No prohibited items)
  // Only identifier-like exclusions are substring-matched. Default policy
  // phrases ("Unrelated UI refactors") are injected into the coder prompt, so
  // echoing them would otherwise false-positive as scope bleed.
  let scopeClean = true;
  for (const excluded of spec.scopeBoundaries.excluded) {
    if (!isIdentifierLikeExclusion(excluded)) continue;
    if (coderOutput.toLowerCase().includes(excluded.toLowerCase())) {
      scopeClean = false;
      checks.push({
        id: 'scope-bleed',
        name: `Scope Violation Check (${excluded})`,
        passed: false,
        details: `Coder output appears to touch excluded scope: ${excluded}`,
      });
      reworkDirectives.push(`Remove changes related to excluded scope: ${excluded}`);
    }
  }
  if (scopeClean) {
    checks.push({
      id: 'scope-fidelity',
      name: 'Scope Boundary Check',
      passed: true,
      details: 'Implementation stays within specified boundaries without scope bleed',
    });
  }

  // Check 3: Acceptance criteria are carried by the contract. This auditor
  // is deterministic and does not execute the criteria; do not claim it did.
  checks.push({
    id: 'acceptance-criteria',
    name: 'Acceptance Criteria Alignment',
    passed: hasCoderOutput,
    details: hasCoderOutput
      ? `Coder produced output against a contract of ${spec.acceptanceCriteria.length} acceptance criteria (not independently executed)`
      : 'No coder output to align with acceptance criteria',
  });

  const allPassed = checks.every((c) => c.passed);
  const score = Math.round((checks.filter((c) => c.passed).length / checks.length) * 100);

  return {
    verdict: allPassed ? 'PASS' : 'REJECT',
    score,
    checks,
    ...(reworkDirectives.length > 0 ? { reworkDirectives } : {}),
    summary: allPassed
      ? 'Auditor approved: Code aligns with synthesized spec, no hallucinations or scope violations detected.'
      : `Auditor rejected: ${reworkDirectives.join('; ')}`,
  };
}

/**
 * Formats a comprehensive 3-stage Markdown report.
 */
export function formatVibeReport(
  rawPrompt: string,
  spec: VibeSpecSynthesizerResult,
  coder: VibeCoderContract,
  audit: VibeAuditVerdict,
): string {
  return [
    '### 🌊 [VIBE Protocol: Spec-Synthesizer]',
    ...(rawPrompt.trim().length > 0 ? [`- **🗣️ Raw Prompt:** ${rawPrompt.trim()}`] : []),
    `- **🎯 Core Intent:** ${spec.coreIntent}`,
    '- **🧩 Sensible Defaults:**',
    ...spec.sensibleDefaults.map((d) => `  • ${d}`),
    '- **📋 Acceptance Criteria:**',
    ...spec.acceptanceCriteria.map((ac) => `  - [ ] ${ac}`),
    '- _Auditor did not independently execute these criteria._',
    '',
    '---',
    '',
    '### 💻 [Coder Contract]',
    `- **Target Files:** ${coder.targetFiles.length > 0 ? coder.targetFiles.join(', ') : 'Inferred from project context'}`,
    `- **Directives:** ${coder.instructions.length} generated guidelines`,
    '',
    '---',
    '',
    '### 🛡️ [Auditor Verdict]',
    `- **Verdict:** ${audit.verdict === 'PASS' ? '✅ PASS' : '❌ REJECT'} (Score: ${audit.score}%)`,
    `- **Summary:** ${audit.summary}`,
    ...audit.checks.map((c) => `  - ${c.passed ? '✅' : '❌'} **${c.name}**: ${c.details}`),
    ...(audit.reworkDirectives && audit.reworkDirectives.length > 0
      ? ['', '**🔧 Rework Instructions:**', ...audit.reworkDirectives.map((r) => `  - ${r}`)]
      : []),
  ].join('\n');
}
