#!/usr/bin/env bun
/**
 * WrongStack Skill Engine & Smart Router
 * Dynamically analyzes user prompts, applies semantic & negative trigger gating,
 * and outputs optimal single-skill selection or multi-skill execution pipelines.
 *
 * Usage:
 *   bun run scripts/wrongstack-skill-engine.ts "Bana cyberpunk temalı tanıtım videosu ve müzik yap"
 *   bun run scripts/wrongstack-skill-engine.ts "Review this PR for race conditions and auth vulnerabilities"
 *   bun run scripts/wrongstack-skill-engine.ts --list
 */

import fs from 'node:fs/promises';
import path from 'node:path';

interface SkillMetadata {
  name: string;
  path: string;
  description: string;
  domain: string;
  layer: 'core' | 'workspace';
  triggers: string[];
  exclusions: string[];
}

interface MatchResult {
  skill: SkillMetadata;
  score: number;
  matchedKeywords: string[];
  reasons: string[];
  excludedReason?: string;
}

const CORE_SKILLS_DIR = path.resolve(process.cwd(), 'packages', 'core', 'skills');
const WORKSPACE_SKILLS_DIR = path.resolve(process.cwd(), '.agents', 'skills');
const FALLBACK_SKILLS_DIR = 'C:\\Users\\ersin\\.agents\\skills';

// Domain classifier rules
const DOMAIN_MAP: Record<string, string[]> = {
  'Creative & Media': [
    'media-production',
    'ai-media-production',
    'threejs-3d',
    'threejs-webgpu-3d',
    'motion-design',
    'modern-motion',
    'audio-studio',
    'suno-audio-studio',
    'design-craft',
  ],
  'Frontier AI & Codex': [
    'codex-runtime',
    'codex-adversarial-review',
    'frontier-prompt-engineer',
    'agents-sdk',
    'orchestration',
    'orca-cli',
    'multi-agent',
    'prompt-engineering',
    'chimera',
    'mnemosyne',
  ],
  'Architecture & Fullstack': [
    'nextjs-modern',
    'nextjs-fullstack-architect',
    'react-modern',
    'node-modern',
    'typescript-strict',
    'design-system',
    'design-system-foundry',
    'code-quality-auditor',
    'nextjs-on-cloudflare',
    'api-design',
    'docker-deploy',
    'tech-stack',
    'sdd',
  ],
  'Documents & Office': ['office-documents', 'docx', 'xlsx', 'pptx', 'pdf', 'google-workspace'],
  'Security & Auditing': [
    'security-scanner',
    'security-audit',
    'security-check',
    'ghost-scan-secrets',
    'evidence-audit',
    'insecure-deserialization-checker',
    'cors-cross-origin-misconfiguration',
    'data-governance',
    'audit-log',
  ],
  'Testing & Quality Gate': [
    'testing',
    'verify-before-done',
    'auto-review',
    'code-review',
    'bug-hunter',
    'debugging',
  ],
  'Cloudflare & Edge': [
    'cloudflare',
    'cloudflare-one',
    'cloudflare-email-service',
    'cloudflare-one-migrations',
    'durable-objects',
    'turnstile-spin',
    'workers-best-practices',
    'wrangler',
  ],
  'Tooling & Meta': [
    'mcp-builder',
    'skill-creator',
    'npm-package-planner',
    'x-persona-brand',
    'wrongstack-orchestrator',
    'mailbox-bridge',
    'wrongstack-mailbox',
    'wrongstack-kanban',
    'web-platform-baseline',
    'web-perf',
    'git-flow',
    'refactor-planner',
  ],
};

// Turkish & English synonym dictionary
const SYNONYMS: Record<string, string[]> = {
  video: [
    'video',
    'klip',
    'clip',
    'film',
    'sinematik',
    'cinematic',
    'remotion',
    'kling',
    'luma',
    'runway',
    'sora',
    'animasyon',
  ],
  audio: [
    'ses',
    'audio',
    'müzik',
    'music',
    'sound',
    'seslendirme',
    'voice',
    'voiceover',
    'suno',
    'udio',
    'elevenlabs',
    'beat',
  ],
  '3d': [
    '3d',
    'threejs',
    'three.js',
    'webgl',
    'webgpu',
    'canvas 3d',
    'spline',
    'shader',
    'mesh',
    'gltf',
    'glb',
    'tsl',
  ],
  animation: [
    'motion',
    'hareket',
    'animasyon',
    'gsap',
    'framer',
    'spring',
    'transition',
    'micro-interaction',
  ],
  review: [
    'review',
    'incele',
    'denetle',
    'audit',
    'zafiyet',
    'vulnerability',
    'race condition',
    'adversarial',
    'açık',
  ],
  document: [
    'word',
    'docx',
    'excel',
    'xlsx',
    'tablo',
    'spreadsheet',
    'sunum',
    'pptx',
    'slide',
    'slayt',
    'pdf',
    'fatura',
    'rapor',
  ],
  nextjs: [
    'nextjs',
    'next.js',
    'react',
    'fullstack',
    'server actions',
    'drizzle',
    'prisma',
    'app router',
  ],
  codex: ['codex', 'gpt-5', 'rescue', 'kurtar', 'companion', 'operator prompt'],
  mcp: ['mcp', 'model context protocol', 'mcp server', 'mcp sunucusu', 'tools'],
  clean: [
    'dead code',
    'ölü kod',
    'unused',
    'kullanılmayan',
    'knip',
    'temizle',
    'refactor',
    'bloat',
  ],
  testing: [
    'test',
    'vitest',
    'unit test',
    'integration test',
    'regression test',
    'e2e',
    'coverage',
  ],
  bug: ['bug', 'bughunt', 'hata', 'defect', 'kusur', 'issue', 'problem', 'arıza', 'bug-hunter'],
  debugging: [
    'debug',
    'debugging',
    'hata ayıkla',
    'reproduce',
    'kök neden',
    'root cause',
    'crash',
    'regression',
    'failing',
  ],
  verification: ['verify', 'doğrula', 'kanıtla', 'proof', 'kanıt', 'verify-before-done'],
};

async function readSkillsFromDir(
  dirPath: string,
  layer: 'core' | 'workspace',
): Promise<SkillMetadata[]> {
  const result: SkillMetadata[] = [];
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const skillPath = path.join(dirPath, entry.name, 'SKILL.md');
        try {
          const content = await fs.readFile(skillPath, 'utf8');
          const frontmatterMatch = content.match(/^---\s*([\s\S]*?)\s*---/);
          if (frontmatterMatch) {
            const fm = frontmatterMatch[1];
            const nameMatch = fm.match(/name:\s*([^\n\r]+)/);
            const descMatch = fm.match(
              /description:\s*(?:>-\s*)?([\s\S]*?)(?=\n[a-zA-Z0-9_-]+:|$)/,
            );
            const name = nameMatch ? nameMatch[1].trim() : entry.name;
            const description = descMatch ? descMatch[1].replace(/\s+/g, ' ').trim() : '';

            // Determine Domain
            let domain = 'Other';
            for (const [dom, list] of Object.entries(DOMAIN_MAP)) {
              if (list.includes(name)) {
                domain = dom;
                break;
              }
            }

            // Extract Triggers & Exclusions
            const triggers: string[] = [];
            const exclusions: string[] = [];
            const useWhenMatch = description.match(/Use when[^.]+\./i);
            if (useWhenMatch) triggers.push(useWhenMatch[0]);
            const triggersMatch = description.match(/Triggers:[^.]+\./i);
            if (triggersMatch) triggers.push(triggersMatch[0]);

            const notUseMatch = description.match(/Do NOT use[^.]+\./i);
            if (notUseMatch) exclusions.push(notUseMatch[0]);

            result.push({
              name,
              path: skillPath,
              description,
              domain,
              layer,
              triggers,
              exclusions,
            });
          }
        } catch {
          // Ignore missing SKILL.md
        }
      }
    }
  } catch {
    // Directory not accessible
  }
  return result;
}

export async function loadSkills(): Promise<SkillMetadata[]> {
  const coreSkills = await readSkillsFromDir(CORE_SKILLS_DIR, 'core');

  let workspaceDir = WORKSPACE_SKILLS_DIR;
  try {
    await fs.access(workspaceDir);
  } catch {
    workspaceDir = FALLBACK_SKILLS_DIR;
  }
  const workspaceSkills = await readSkillsFromDir(workspaceDir, 'workspace');

  // De-duplicate by name: core skills take precedence if names match
  const skillMap = new Map<string, SkillMetadata>();
  for (const s of workspaceSkills) {
    skillMap.set(s.name, s);
  }
  for (const s of coreSkills) {
    skillMap.set(s.name, s);
  }

  return Array.from(skillMap.values());
}

export function matchSkills(prompt: string, skills: SkillMetadata[]): MatchResult[] {
  const lowerPrompt = prompt.toLowerCase();
  const results: MatchResult[] = [];

  for (const skill of skills) {
    let score = 0;
    const matchedKeywords: string[] = [];
    const reasons: string[] = [];
    let excludedReason: string | undefined;

    // 1. Direct Name Match
    if (lowerPrompt.includes(skill.name.toLowerCase())) {
      score += 40;
      matchedKeywords.push(skill.name);
      reasons.push(`Direct skill name match: "${skill.name}"`);
    }

    // 2. Keyword & Synonym Expansion with Root/Stem Matching (Turkish & English)
    for (const [concept, words] of Object.entries(SYNONYMS)) {
      const promptHasConcept = words.some((w) => {
        // Match root word at word start (handles Turkish inflections like videosu, müzikli)
        const regex = new RegExp(`\\b${w}`, 'i');
        return regex.test(lowerPrompt);
      });
      if (promptHasConcept) {
        const descHasConcept = words.some((w) => {
          const regex = new RegExp(`\\b${w}`, 'i');
          return regex.test(skill.description);
        });
        if (descHasConcept) {
          score += 35;
          matchedKeywords.push(concept);
          reasons.push(`Matched concept: [${concept}]`);
        }
      }
    }

    // 3. Description Token Overlap
    const descWords = skill.description
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 4);
    for (const word of descWords) {
      if (lowerPrompt.includes(word) && !matchedKeywords.includes(word)) {
        score += 5;
        matchedKeywords.push(word);
      }
    }

    // 4. Negative Exclusion Check
    for (const exclusion of skill.exclusions) {
      const lowerEx = exclusion.toLowerCase();
      // Check if prompt specifically asks for what is excluded
      if (lowerEx.includes('do not use for') || lowerEx.includes('not for')) {
        if (lowerPrompt.includes('3d') && lowerEx.includes('3d')) {
          score = 0;
          excludedReason = `Explicitly excluded: ${exclusion}`;
          break;
        }
        if (lowerPrompt.includes('static') && lowerEx.includes('static')) {
          score = 0;
          excludedReason = `Explicitly excluded: ${exclusion}`;
          break;
        }
      }
    }

    if (score > 10 && !excludedReason) {
      results.push({ skill, score, matchedKeywords, reasons, excludedReason });
    }
  }

  return results.sort((a, b) => b.score - a.score);
}

export function buildExecutionPipeline(
  matches: MatchResult[],
): { order: number; skill: string; domain: string; rationale: string }[] {
  const pipeline: { order: number; skill: string; domain: string; rationale: string }[] = [];

  // Domain execution precedence order:
  // 1. Architecture / Planning -> 2. Audio/Creative assets -> 3. Video / 3D Canvas -> 4. Quality & Audit
  const orderedSkills = [...matches];
  orderedSkills.sort((a, b) => {
    const priority = (name: string, dom: string) => {
      // Proof-driven bug hunt execution order
      if (name === 'bug-hunter') return 1;
      if (name === 'debugging') return 2;
      if (name === 'testing') return 3;
      if (name === 'verify-before-done') return 4;
      if (dom.includes('Testing')) return 5;

      if (dom.includes('Architecture')) return 10;
      if (dom.includes('Documents')) return 11;
      if (dom.includes('Creative')) return 12;
      if (dom.includes('Frontier')) return 13;
      if (dom.includes('Security') || dom.includes('Tooling')) return 14;
      return 15;
    };
    return priority(a.skill.name, a.skill.domain) - priority(b.skill.name, b.skill.domain);
  });

  orderedSkills.slice(0, 4).forEach((match, idx) => {
    pipeline.push({
      order: idx + 1,
      skill: match.skill.name,
      domain: match.skill.domain,
      rationale: match.reasons.join(' | ') || `Relevance score: ${match.score}`,
    });
  });

  return pipeline;
}

async function inspectRepoVersions(): Promise<{
  found: boolean;
  versions: Record<string, string>;
  path: string;
} | null> {
  try {
    const pkgPath = path.resolve(process.cwd(), 'package.json');
    const content = await fs.readFile(pkgPath, 'utf8');
    const pkg = JSON.parse(content);
    const allDeps = {
      ...(pkg.dependencies || {}),
      ...(pkg.devDependencies || {}),
    };
    return { found: true, versions: allDeps, path: pkgPath };
  } catch {
    return null;
  }
}

// CLI Execution
async function main() {
  const args = process.argv.slice(2);
  const prompt = args.join(' ').trim();

  const skills = await loadSkills();

  if (args.includes('--list')) {
    console.log(`\n📦 WrongStack Skill Inventory (Total: ${skills.length} skills):\n`);
    const byDomain: Record<string, string[]> = {};
    for (const s of skills) {
      byDomain[s.domain] = byDomain[s.domain] || [];
      byDomain[s.domain].push(s.name);
    }
    for (const [dom, list] of Object.entries(byDomain)) {
      console.log(`\x1b[36m${dom}\x1b[0m (${list.length}):`);
      console.log(`  ${list.join(', ')}\n`);
    }
    return;
  }

  if (!prompt) {
    console.log(`
⚡ WrongStack Skill Engine & Smart Router
Usage:
  bun run scripts/wrongstack-skill-engine.ts "<your request or prompt>"
  bun run scripts/wrongstack-skill-engine.ts --list
`);
    return;
  }

  console.log(`\n🔍 Analyzing Prompt: "\x1b[33m${prompt}\x1b[0m"\n`);

  // Step 1: Pre-flight repo inspection
  const repoInfo = await inspectRepoVersions();
  if (repoInfo) {
    console.log(`📋 \x1b[1mPre-flight Repo Inspection\x1b[0m (package.json):`);
    const relevantDeps: string[] = [];
    for (const [dep, ver] of Object.entries(repoInfo.versions)) {
      if (
        prompt.toLowerCase().includes(dep.toLowerCase()) ||
        [
          'react',
          'next',
          'typescript',
          'vitest',
          'tailwindcss',
          'three',
          'motion',
          'remotion',
          'biome',
        ].some((k) => dep.toLowerCase().includes(k))
      ) {
        relevantDeps.push(`${dep}@${ver}`);
      }
    }
    if (relevantDeps.length > 0) {
      console.log(`   Installed in repo: \x1b[33m${relevantDeps.slice(0, 8).join(', ')}\x1b[0m`);
    } else {
      console.log(`   Scanned dependencies; no direct name overlap with prompt query.`);
    }
    console.log(
      `   \x1b[90mRule: Check live registry (e.g. registry.npmjs.org/<pkg>/latest) before changing or adding dependencies.\x1b[0m\n`,
    );
  }

  const matches = matchSkills(prompt, skills);

  if (matches.length === 0) {
    console.log(
      '⚠️ No specialized skill matched with high confidence. Defaulting to standard agent workflow.',
    );
    return;
  }

  console.log('🎯 Top Matching Skills:');
  matches.slice(0, 5).forEach((m, i) => {
    const layerTag =
      m.skill.layer === 'core' ? '\x1b[34m[Core Bundled]\x1b[0m' : '\x1b[90m[Workspace Ext]\x1b[0m';
    console.log(
      `  ${i + 1}. \x1b[32m${m.skill.name}\x1b[0m ${layerTag} (Score: ${m.score}) [${m.skill.domain}]`,
    );
    console.log(`     Keywords: ${m.matchedKeywords.slice(0, 5).join(', ')}`);
  });

  if (matches.length > 1) {
    console.log('\n🚀 Recommended Execution Pipeline:');
    const pipeline = buildExecutionPipeline(matches);
    pipeline.forEach((p) => {
      console.log(`  [Step ${p.order}] \x1b[35m${p.skill}\x1b[0m (${p.domain}) ➔ ${p.rationale}`);
    });
  }

  console.log('\n');
}

main();
