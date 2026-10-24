import type { PromptLoader } from '@wrongstack/contracts/types/prompt';
import type { SlashCommand } from '@wrongstack/contracts/types/slash-command';
import type { Context } from '../core/context.js';
import {
  areSubagentsAllowed,
  setSessionSubagentPolicy,
} from '../security/session-subagent-policy.js';
import type { PromptUsageStore } from '../storage/prompt-usage-store.js';

interface ProofDrivenHuntSpec {
  /** Primary slash command name, e.g. 'bughunt', 'sechunt', 'debloat'. */
  name: string;
  /** Optional command aliases, e.g. ['deadcode', 'excise']. */
  aliases?: readonly string[] | undefined;
  /** Builtin prompt slug in `packages/core/data/prompts/prompts/`. */
  slug: string;
  /** Human-readable tool title used in status and error messages. */
  label: string;
  /** One-line slash command description. */
  description: string;
  /** Argument hint shown in command help. */
  argsHint: string;
  /** Detailed help text for `/help <name>`. */
  help: string;
}

export const PROOF_DRIVEN_HUNT_SPECS: readonly ProofDrivenHuntSpec[] = Object.freeze([
  {
    name: 'bughunt',
    slug: 'proof-driven-bug-hunter',
    label: 'Proof-Driven Bug Hunter',
    description: 'Start one Proof-Driven Bug Hunter round.',
    argsHint: '[package | path | feature | symptom]',
    help: [
      'Start one autonomous bug discovery, proof, fix, and verification round.',
      '',
      'Usage:',
      '  /bughunt                         Hunt across the current project',
      '  /bughunt --rounds 5              Run up to 5 TUI rounds (1-25)',
      '  /bughunt packages/core/storage  Restrict the round to a target',
      '  /bughunt --rounds 5 packages/tui Run up to 5 rounds in a target',
      '',
      'The agent handles exactly one bug and stops after its round report.',
    ].join('\n'),
  },
  {
    name: 'sechunt',
    aliases: ['secproof'],
    slug: 'proof-driven-security-hardener',
    label: 'Proof-Driven Security Hardener',
    description: 'Start one Proof-Driven Security Hardener round.',
    argsHint: '[package | path | feature | boundary]',
    help: [
      'Start one autonomous security boundary discovery, local breach proof, hardening, and verification round.',
      '',
      'Usage:',
      '  /sechunt                         Audit and harden across the current project',
      '  /sechunt --rounds 5              Run up to 5 TUI rounds (1-25)',
      '  /sechunt packages/webui-server   Restrict the round to a target',
      '  /secproof packages/tools         Alias for /sechunt',
      '',
      'The agent proves one reachable boundary flaw locally, hardens it, and stops after its round report.',
    ].join('\n'),
  },
  {
    name: 'racehunt',
    aliases: ['leakhunt', 'flakehunt'],
    slug: 'proof-driven-race-leak-hunter',
    label: 'Proof-Driven Race & Leak Hunter',
    description: 'Start one Proof-Driven Race & Leak Hunter round.',
    argsHint: '[package | path | feature | symptom]',
    help: [
      'Start one autonomous concurrency race, lifecycle violation, or resource leak hunt round.',
      '',
      'Usage:',
      '  /racehunt                        Hunt races and leaks across the current project',
      '  /racehunt --rounds 5             Run up to 5 TUI rounds (1-25)',
      '  /racehunt packages/core          Restrict the round to a target',
      '  /leakhunt | /flakehunt           Aliases for /racehunt',
      '',
      'The agent proves one race or leak with deterministic barriers/counters, fixes it, verifies 5x, and stops.',
    ].join('\n'),
  },
  {
    name: 'debloat',
    aliases: ['deadcode', 'excise'],
    slug: 'proof-driven-dead-code-excisor',
    label: 'Proof-Driven Dead-Code & Bloat Excisor',
    description: 'Start one Proof-Driven Dead-Code & Bloat Excisor round.',
    argsHint: '[package | path | module | symbol]',
    help: [
      'Start one autonomous dead-code and bloat excision ratchet round.',
      '',
      'Usage:',
      '  /debloat                         Excise proven dead code across the current project',
      '  /debloat --rounds 5              Run up to 5 TUI rounds (1-25)',
      '  /debloat packages/tools          Restrict the round to a target',
      '  /deadcode | /excise              Aliases for /debloat',
      '',
      'The agent proves zero static/dynamic reachability for one dead unit, removes it, and ratchets via build/typecheck/tests.',
    ].join('\n'),
  },
  {
    name: 'uipolish',
    aliases: ['a11yhunt', 'uihunt'],
    slug: 'proof-driven-ui-a11y-ratchet',
    label: 'Proof-Driven UI & Accessibility Ratchet',
    description: 'Start one Proof-Driven UI & Accessibility Ratchet round.',
    argsHint: '[package | path | component | route]',
    help: [
      'Start one autonomous UI layout and WCAG accessibility measurement-and-fix round.',
      '',
      'Usage:',
      '  /uipolish                        Audit and fix UI/a11y across the current project',
      '  /uipolish --rounds 5             Run up to 5 TUI rounds (1-25)',
      '  /uipolish packages/webui         Restrict the round to a target',
      '  /a11yhunt | /uihunt              Aliases for /uipolish',
      '',
      'The agent proves one measurable DOM/WCAG defect, fixes it using design tokens/semantics, and re-measures.',
    ].join('\n'),
  },
  {
    name: 'typehunt',
    aliases: ['boundaryhunt'],
    slug: 'proof-driven-type-boundary-guard',
    label: 'Proof-Driven Type & Boundary Guard',
    description: 'Start one Proof-Driven Type & Boundary Guard round.',
    argsHint: '[package | path | boundary | symbol]',
    help: [
      'Start one autonomous type-safety and runtime boundary hardening round.',
      '',
      'Usage:',
      '  /typehunt                        Harden unsafe casts/boundaries across the project',
      '  /typehunt --rounds 5             Run up to 5 TUI rounds (1-25)',
      '  /typehunt packages/core          Restrict the round to a target',
      '  /boundaryhunt                    Alias for /typehunt',
      '',
      'The agent proves how malformed runtime data breaches an unsafe cast/boundary, replaces it with a sound guard, and verifies.',
    ].join('\n'),
  },
  {
    name: 'testgap',
    aliases: ['covhunt', 'invarianthunt'],
    slug: 'proof-driven-blind-spot-tester',
    label: 'Proof-Driven Blind-Spot & Invariant Tester',
    description: 'Start one Proof-Driven Blind-Spot & Invariant Tester round.',
    argsHint: '[package | path | module | invariant]',
    help: [
      'Start one autonomous test blind-spot discovery and invariant regression-test round.',
      '',
      'Usage:',
      '  /testgap                         Close one high-impact test blind spot in the project',
      '  /testgap --rounds 5              Run up to 5 TUI rounds (1-25)',
      '  /testgap packages/core/storage   Restrict the round to a target',
      '  /covhunt | /invarianthunt        Aliases for /testgap',
      '',
      'The agent proves existing tests miss a critical invariant violation and authors a durable regression test without touching production code.',
    ].join('\n'),
  },
]);

function parseHuntArgs(
  commandName: string,
  argsHint: string,
  args: string,
): {
  target: string;
  rounds?: number | undefined;
  error?: string | undefined;
} {
  const match = args.trim().match(/^--rounds(?:\s+|=)(\S+)(?:\s+([\s\S]*))?$/);
  if (!match) return { target: args.trim() };
  const rounds = Number(match[1]);
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 25) {
    return {
      target: '',
      error: `Usage: /${commandName} [--rounds 1..25] ${argsHint}`,
    };
  }
  return { target: match[2]?.trim() ?? '', rounds };
}

function buildSingleHuntCommand(
  spec: ProofDrivenHuntSpec,
  getLoader: () => PromptLoader | null,
  getUsage: () => PromptUsageStore | null,
): SlashCommand {
  return {
    name: spec.name,
    ...(spec.aliases ? { aliases: [...spec.aliases] } : {}),
    category: 'Run',
    description: spec.description,
    argsHint: spec.argsHint,
    help: spec.help,
    async run(args: string, ctx: Context) {
      const loader = getLoader();
      if (!loader) return { message: 'Prompt library not available.' };
      const entry = await loader.find(spec.slug);
      if (!entry) {
        return {
          message: `Builtin prompt "${spec.slug}" is unavailable. Rebuild or reinstall the prompt dataset.`,
        };
      }
      const parsed = parseHuntArgs(spec.name, spec.argsHint, args);
      if (parsed.error) return { message: parsed.error };
      // Solo, but the read-only companions (memory, explore) keep running:
      // they cannot change code, so one fix still maps to one outcome. A
      // session already solo — strict or not — is left as the user set it.
      try {
        if (areSubagentsAllowed(ctx)) await setSessionSubagentPolicy(ctx, 'companions');
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return { message: `${spec.label} could not start: ${reason}` };
      }
      try {
        await getUsage()?.record(entry.slug);
      } catch {
        // Usage tracking must never block a hunt.
      }
      const target = parsed.target;
      const runText = target
        ? `${entry.content}\n\n## User-selected target\nStay within this package, area, feature, or symptom for this round: ${target}`
        : entry.content;
      return {
        message: target
          ? `${spec.label} started for: ${target}`
          : `${spec.label} started for the current project.`,
        runText,
        metadata: { bugHunt: { rounds: parsed.rounds } },
      };
    },
  };
}

export function buildProofDrivenHuntCommands(
  getLoader: () => PromptLoader | null,
  getUsage: () => PromptUsageStore | null,
): SlashCommand[] {
  return PROOF_DRIVEN_HUNT_SPECS.map((spec) => buildSingleHuntCommand(spec, getLoader, getUsage));
}
