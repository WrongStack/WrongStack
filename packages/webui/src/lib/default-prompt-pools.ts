import type { LucideIcon } from 'lucide-react';
import { Crosshair, Lightbulb, Search, Sparkles } from 'lucide-react';

/** One category of starting prompt card shown on the welcome screen. */
export interface PromptCard {
  id: 'understand' | 'create' | 'investigate' | 'improve';
  icon: LucideIcon;
  title: string;
  hint: string;
  tone: string;
  /** Gradient strip color at the top of the card */
  gradient: string;
  /** Full pool of project-agnostic prompts. Only a random subset is shown
   *  at a time; the Shuffle control re-samples from this pool. */
  pool: string[];
}

/** How many prompts to surface per card at once. */
export const PROMPTS_PER_CARD = 4;

export const DEFAULT_PROMPT_CARDS: PromptCard[] = [
  {
    id: 'understand',
    icon: Search,
    title: 'Understand',
    hint: 'Explore and analyze the codebase',
    tone: 'text-info bg-info/10 border-info/20',
    gradient: 'from-info/25 via-info/10 to-transparent',
    pool: [
      'Map out the structure of this codebase: what are the main modules or components, how do they depend on each other, and what are the key patterns used throughout?',
      'Find and document the public API surface — all exported interfaces, functions, and types that other parts of the system depend on.',
      'Trace the flow of data through the system for a typical operation. Where does input validation happen? Where are side effects triggered?',
      'Give me a guided tour of this codebase as if I just joined the team — where should I start reading, and what are the handful of files I should understand first?',
      'Explain the overall architecture and the main design decisions behind it. What trade-offs were made, and why?',
      'Identify the core domain concepts and how they map to the code. What vocabulary do I need to understand this project?',
      'Where does execution begin? Trace the entry point through startup, configuration loading, and into the main loop or request handler.',
      'What external dependencies and integrations does this project rely on, and how does the code talk to each of them?',
      'How is state managed and where does it live? Walk me through the lifecycle of the most important piece of data in the system.',
      'Summarize what this project does, who it is for, and how the pieces fit together — in plain language, no jargon.',
      'Which parts of this codebase are the most complex or the hardest to change safely, and what makes them that way?',
      'Show me how a single request or command flows end to end, from the outer boundary down to where the real work happens.',
    ],
  },
  {
    id: 'create',
    icon: Lightbulb,
    title: 'Create',
    hint: 'Build new features and functionality',
    tone: 'text-success bg-success/10 border-success/20',
    gradient: 'from-success/25 via-success/10 to-transparent',
    pool: [
      'Add a new feature that covers the full stack: data model, business logic, and any UI or API layers. Follow existing patterns in this codebase.',
      'Write comprehensive tests for a module with low coverage. Include happy paths, edge cases, and error scenarios.',
      'Add observability to a critical path — structured logging, error tracking, or metrics that help diagnose issues in production.',
      'Scaffold a new module following the existing conventions — same structure, naming, and patterns as the rest of the codebase.',
      'Add input validation and clear error messages to a user-facing entry point that currently trusts its inputs.',
      'Write documentation for a part of the code that lacks it — usage examples, edge cases, and the gotchas worth warning about.',
      'Take a value that is currently hardcoded and turn it into a proper configuration option, wired through cleanly with a sensible default.',
      'Build a small CLI or script that automates a repetitive task in this project.',
      'Create an integration test that exercises a real end-to-end path instead of mocking everything away.',
      "Add a health check or self-diagnostic that reports whether the system's dependencies are reachable and configured correctly.",
      'Introduce a feature-flag mechanism so new behavior can be rolled out gradually and switched off without a redeploy.',
      'Add pagination, filtering, or sorting to a data-listing path that currently returns everything at once.',
    ],
  },
  {
    id: 'investigate',
    icon: Crosshair,
    title: 'Investigate',
    hint: 'Debug issues and find root causes',
    tone: 'text-warning bg-warning/10 border-warning/20',
    gradient: 'from-warning/25 via-warning/10 to-transparent',
    pool: [
      "Something isn't working as expected — help me trace from the symptom to the root cause. Follow the code path and identify where behavior diverges from intent.",
      "There's a difference between how this works locally versus in production or CI. Check for environment differences, configuration issues, or hidden assumptions.",
      'Performance is degrading. Identify the bottlenecks — whether N+1 queries, blocking I/O, unnecessary allocations, or something else — and propose targeted fixes.',
      'Help me reproduce an intermittent bug: what timing, ordering, or conditions could make it flaky, and how do I make it deterministic?',
      'This code throws or misbehaves under some inputs. Find the exact conditions that trigger it and explain why they do.',
      'Memory or resource usage keeps growing over time. Look for leaks — unclosed handles, unbounded caches, or retained references.',
      'A recent change broke something. Help me narrow down what introduced the regression and why it slipped through.',
      'Two parts of the system disagree about the same data. Find where they diverge and determine which one is actually wrong.',
      'Add targeted logging or assertions to narrow down where this bug really happens, then help me interpret the output.',
      "This test is failing or flaky. Figure out whether it's the test that's wrong or the code it's checking.",
      'Walk a confusing edge case through the code and tell me whether the resulting behavior is a genuine bug or intended.',
      "I suspect a race condition or ordering issue. Look for shared state that's read or written without proper coordination.",
    ],
  },
  {
    id: 'improve',
    icon: Sparkles,
    title: 'Improve',
    hint: 'Refactor and optimize existing code',
    tone: 'text-primary bg-primary/10 border-primary/20',
    gradient: 'from-primary/20 via-primary/8 to-transparent',
    pool: [
      'Find duplicated or similar logic that could be consolidated into shared utilities. Extract the common parts and update the call sites.',
      'Identify modules that have grown too large or handle too many responsibilities. Propose a cleaner separation that can be done incrementally.',
      'Review error handling across the codebase: are errors consistent, well-contextualized, and properly propagated? Suggest improvements to the worst cases.',
      'Reduce complexity in the most tangled function you can find — simplify the control flow without changing its behavior.',
      'Improve the naming and readability of a confusing area so the next person understands it faster.',
      'Find and remove dead code, unused exports, and obsolete branches that no longer serve a purpose.',
      'Tighten up the types (or add types) in a loosely-typed area so more bugs are caught at compile time instead of at runtime.',
      'Optimize a hot path for speed or memory — but measure before and after so the win is real, not assumed.',
      'Replace a fragile pattern — magic numbers, stringly-typed values, deep nesting — with something safer and clearer.',
      'Improve test quality: hunt down weak assertions, over-mocking, and tests that pass without really verifying anything.',
      'Make an inconsistent API consistent — align naming, argument order, and return shapes across similar functions.',
      'Harden the code against invalid states — make illegal states unrepresentable wherever the design allows it.',
    ],
  },
];

export const SLASH_REFS: Array<{ id: string; name: string; hint: string }> = [
  { id: 'help', name: '/help', hint: 'list every slash command' },
  { id: 'diag', name: '/diag', hint: 'runtime diagnostics' },
  { id: 'stats', name: '/stats', hint: 'tokens · cache · cost · elapsed' },
  { id: 'tools', name: '/tools', hint: 'show registered tools' },
  { id: 'memory', name: '/memory', hint: 'show remembered notes' },
  { id: 'compact', name: '/compact', hint: 'shrink context' },
  { id: 'clear', name: '/clear', hint: 'wipe current context' },
  { id: 'new', name: '/new', hint: 'fresh session' },
];

/** Pick `n` distinct random items from `pool` (Fisher–Yates on a copy). */
export function sampleN<T>(pool: readonly T[], n: number): T[] {
  if (Number.isNaN(n) || n <= 0) return [];
  const copy = pool.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  const count = Number.isFinite(n) ? Math.min(Math.floor(n), copy.length) : copy.length;
  return copy.slice(0, count);
}

/** Sample a fresh subset of prompts for every card. */
export function shuffleAllCards(cards: PromptCard[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const card of cards) out[card.id] = sampleN(card.pool, PROMPTS_PER_CARD);
  return out;
}
