import type { Context } from '@wrongstack/core/agent';
import type { SlashCommand } from '@wrongstack/core/types';
import { color } from '@wrongstack/core/utils';
import type { SlashCommandContext } from './command-context.js';
import {
  type Classification,
  classifyError,
  isSimpleFix,
  needsSubagent,
} from './fix-classifier.js';

interface FixResult {
  message?: string | undefined;
  /** Text to inject as the next user message in the REPL. */
  runText?: string | undefined;
  /** Extra metadata for the REPL / coordinator. */
  metadata?: {
    skillHints?: string[] | undefined;
    delegateRequested?: boolean | undefined;
    delegateRole?: string | undefined;
    delegateTask?: string | undefined;
  };
}

/**
 * Build a per-turn agent directive based on classification.
 * This is the instruction block that goes into runText.
 */
function buildDirective(cli: Classification, errorText: string): string {
  const lang = cli.language === 'unknown' ? '' : ` (language: ${cli.language})`;

  switch (cli.category) {
    case 'ts':
      return [
        `## Fix: TypeScript Error${lang}`,
        '',
        '```',
        `${errorText}`,
        '```',
        '',
        'Your task:',
        `1. Search for the error location in the codebase (grep for the error code "${cli.errorCode ?? ''}" or relevant type names)`,
        '2. Read the source file(s)',
        '3. Identify the root cause',
        '4. Fix with strict types — no `as any` or `@ts-ignore`',
        '5. Verify with `typecheck` or `tsc --noEmit`',
      ].join('\n');

    case 'security':
      return [
        `## Fix: Security Issue${lang}`,
        '',
        '```',
        `${errorText}`,
        '```',
        '',
        'Your task:',
        '1. Locate the vulnerable code (grep for hardcoded secrets, eval, innerHTML, SQL concatenation)',
        '2. Classify severity: critical / high / medium',
        '3. Apply the fix:',
        '   - Secrets → rotate + use env vars or a secret manager',
        '   - Injection → parameterized queries, safe DOM APIs',
        '   - Auth → fix token handling',
        '4. Check for similar issues: `grep -r "password" --include="*.ts"` etc.',
        '5. Run security scan if available',
      ].join('\n');

    case 'runtime':
      return [
        `## Fix: Runtime Error${lang}`,
        '',
        '```',
        `${errorText}`,
        '```',
        '',
        'Your task:',
        '1. Locate the crash site (grep for error message or stack trace context)',
        '2. Read the relevant file(s)',
        '3. Identify root cause: null/undefined access, async race, wrong type, etc.',
        '4. Fix the error',
        '5. Verify — re-run or typecheck',
      ].join('\n');

    case 'compile':
      return [
        `## Fix: Compiler Error${lang}`,
        '',
        '```',
        `${errorText}`,
        '```',
        '',
        'Your task:',
        '1. Locate the file(s) with compile errors',
        '2. Read the error output carefully',
        '3. Fix the compile error',
        '4. Re-compile to verify',
      ].join('\n');

    case 'dep':
      return [
        `## Fix: Dependency / Import Error${lang}`,
        '',
        '```',
        `${errorText}`,
        '```',
        '',
        'Your task:',
        '1. Identify the missing module or failed import',
        '2. Fix: install the package, add to imports, or correct the path',
        '3. Verify imports resolve',
      ].join('\n');

    case 'infra':
      return [
        `## Fix: Infrastructure / Config Error${lang}`,
        '',
        '```',
        `${errorText}`,
        '```',
        '',
        'Your task:',
        '1. Locate the config file or infrastructure setup',
        '2. Identify the misconfiguration',
        '3. Fix the config',
        '4. Verify',
      ].join('\n');

    case 'tech':
      return [
        `## Tech Stack Validation${lang}`,
        '',
        '```',
        `${errorText}`,
        '```',
        '',
        'Your task:',
        '1. Detect the ecosystem from project files or context',
        '2. Verify the package/version against the correct registry',
        '3. Check if the package is dead, deprecated, or superseded (prehistoric)',
        '4. Check if the language standard library already covers this need',
        '5. Report APPROVED (with install command) or REJECTED (with replacement + migration)',
        '6. Use "This isn\'t code, this is X-year-old technology" when rejecting on age grounds',
      ].join('\n');

    case 'perf':
      return [
        `## Fix: Performance / Memory Issue${lang}`,
        '',
        '```',
        `${errorText}`,
        '```',
        '',
        'Your task:',
        '1. Profile or locate the bottleneck',
        '2. Identify root cause',
        '3. Fix: memoize, batch, lazy-load, remove leak, fix loop',
        '4. Verify performance improvement',
      ].join('\n');

    default:
      return [
        `## Fix: Problem Reported${lang}`,
        '',
        '```',
        `${errorText}`,
        '```',
        '',
        'Your task:',
        '1. Analyze the problem description',
        '2. Locate relevant files',
        '3. Identify the root cause',
        '4. Apply the fix',
        '5. Verify the fix works',
      ].join('\n');
  }
}

/** Map classification category to delegate role. */
function delegateRoleFor(cli: Classification): string | undefined {
  switch (cli.category) {
    case 'ts':
      return 'typescript-strict';
    case 'security':
      return 'security-scanner';
    case 'perf':
      return 'refactor-planner';
    case 'tech':
      return 'tech-stack';
    default:
      return 'bug-hunter';
  }
}

function skillLabel(skillHints: string[]): string {
  return skillHints.map((s) => `\`${s}\``).join(', ');
}

function categoryLabel(cli: Classification): string {
  if (cli.language !== 'unknown') {
    return `${cli.subcategory} (${cli.category}, ${cli.language})`;
  }
  return `${cli.subcategory} (${cli.category})`;
}

export function buildFixCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'fix',
    category: 'Agent',
    description:
      'Classify a bug/error (any language), activate the right skill, and fix it — inline or via subagent.',
    argsHint: '<error message or problem description>',
    help: `
# /fix — Problem Solver

Classifies an error, bug, or problem description from **any language/framework**,
activates the right skill, and drives a focused fix workflow.

## Usage

\`\`\`
/fix <error message or problem description>
\`\`\`

## Supported languages & frameworks

TypeScript, Rust, Go, Python, Ruby, Java, Kotlin, Swift, C/C++, C#,
PHP, Scala, Perl, Haskell, Elixir, Node.js, React, Next.js, Vue, Angular,
Docker, Git, CI/CD, and more.

## Classification → skill mapping

| Error type           | Language(s)              | Skill activated       |
|---------------------|--------------------------|-----------------------|
| TypeScript          | TypeScript               | \`typescript-strict\`   |
| Runtime / crash     | Any                      | \`bug-hunter\`           |
| Security / secrets  | Any                      | \`security-scanner\`     |
| Compiler error      | Rust, Go, C/C++, Python  | \`bug-hunter\`           |
| Dependency / import | Any                      | \`bug-hunter\`           |
| Tech choice / pkg   | Any                      | \`tech-stack\`           |
| Performance / leak  | Any                      | \`bug-hunter\` + \`refactor-planner\` |
| Infrastructure      | Config, Docker, Git, CI  | \`bug-hunter\`           |
| React / Next.js     | JavaScript               | \`react-modern\`         |
| Node.js             | JavaScript               | \`node-modern\`           |

## Auto-delegation

When the error confidence is low (< 0.85) or the problem spans multiple files,
\`/fix\` automatically delegates to the matching specialist subagent via the
\`onFix\` callback. Set \`onFix\` in \`SlashCommandContext\` to enable this.

## Examples

\`\`\`
/fix TS2345: Argument of type 'string | null' is not assignable
/fix TypeError: Cannot read property 'map' of undefined
/fix error[E0503]: expected something but found E0503 in src/lib.rs
/fix Segmentation fault (core dumped) at main.rs:42
/fix AttributeError: 'NoneType' object has no attribute 'encode' (Python)
/fix react-dom.development.js:172 Error: Invalid hook call
/fix Security: hardcoded API key in config.ts
/fix ERRO1014: SQL injection vulnerability in query builder
/fix Should I use axios for API calls?
/fix is moment.js still maintained?
/fix pip install urllib2
/fix what replaces lodash?
\`\`\`
`,
    async run(args: string, _ctx: Context): Promise<FixResult> {
      const trimmed = args.trim();

      if (!trimmed) {
        return {
          message: [
            `${color.bold('/fix — Problem Solver')}`,
            '',
            'Classifies an error from any language/framework and activates the right skill.',
            '',
            'Usage:',
            '  /fix <error message or problem description>',
            '',
            'Examples:',
            `  /fix ${color.dim('TS2345: Argument of type "string | null" is not assignable')}`,
            `  /fix ${color.dim("TypeError: Cannot read property 'map' of undefined")}`,
            `  /fix ${color.dim('error[E0503]: expected something but found E0503 in src/lib.rs')}`,
            `  /fix ${color.dim("AttributeError: 'NoneType' object has no attribute 'encode'")}`,
            `  /fix ${color.dim('react-dom.development.js:172 Error: Invalid hook call')}`,
            `  /fix ${color.dim('Security: hardcoded API key in config.ts')}`,
            `  /fix ${color.dim('Should I use axios for API calls?')}`,
            '',
            'Run `/help fix` for full documentation.',
          ].join('\n'),
        };
      }

      const cli = classifyError(trimmed);
      const delegate = needsSubagent(cli);
      const delegateRole = delegate ? delegateRoleFor(cli) : undefined;

      const metadata: FixResult['metadata'] = {
        skillHints: cli.skillHints,
        delegateRequested: delegate,
        delegateRole: delegateRole,
      };

      // ── Inline fix: high-confidence single-location errors ──────────────
      if (isSimpleFix(cli) || (!delegate && opts.onFix)) {
        const runText =
          [
            '',
            `${color.bold('╔═══════ /fix — Problem Solver ═══════╗')}`,
            '',
            `**Classification:** ${categoryLabel(cli)}`,
            `**Confidence:** ${Math.round(cli.confidence * 100)}%`,
            `**Error code:** \`${cli.errorCode ?? 'n/a'}\``,
            '',
            `**Skills activated:** ${skillLabel(cli.skillHints)}`,
            '',
            `**Next step:** ${delegate ? 'Delegating to `' + delegateRole + '` subagent...' : 'Applying inline fix...'}`,
            '',
          ].join('\n') +
          '\n---\n' +
          buildDirective(cli, trimmed);

        if (opts.onFix) {
          const injected = await opts.onFix(trimmed);
          if (injected?.message) {
            return {
              message: injected.message,
              runText: injected.runText ?? runText,
              metadata,
            };
          }
        }

        return {
          message: `${color.green('✓')} [${categoryLabel(cli)}] — Skills: ${skillLabel(cli.skillHints)}`,
          runText,
          metadata,
        };
      }

      // ── Auto-delegate: low-confidence / complex fixes ─────────────────────
      if (delegate && delegateRole) {
        const taskPrompt = [
          `${color.bold('/fix — Auto-delegated fix')}`,
          '',
          `**Problem classification:** ${categoryLabel(cli)} (confidence: ${Math.round(cli.confidence * 100)}%)`,
          `**Error code:** \`${cli.errorCode ?? 'n/a'}\``,
          `**Skills activated:** ${skillLabel(cli.skillHints)}`,
          '',
          buildDirective(cli, trimmed),
        ].join('\n');

        metadata.delegateTask = taskPrompt;

        const runText = [
          '',
          `${color.bold('╔═══════ /fix — Auto-delegated ═══════╗')}`,
          '',
          `**Delegating to:** \`${delegateRole}\` subagent`,
          `**Classification:** ${categoryLabel(cli)}`,
          `**Confidence:** ${Math.round(cli.confidence * 100)}% — delegation triggered (confidence < 85%)`,
          `**Skills activated:** ${skillLabel(cli.skillHints)}`,
          '',
          'The specialist subagent will now fix the issue. Results will be reported when complete.',
        ].join('\n');

        return {
          message: `${color.green('✓')} Delegating to \`${delegateRole}\`...`,
          runText,
          metadata,
        };
      }

      // Fallback — general
      const runText =
        [
          '',
          `${color.bold('╔═══════ /fix — Problem Solver ═══════╗')}`,
          '',
          `**Classification:** ${categoryLabel(cli)} (confidence: ${Math.round(cli.confidence * 100)}%)`,
          `**Skills activated:** ${skillLabel(cli.skillHints)}`,
          '',
        ].join('\n') +
        '\n---\n' +
        buildDirective(cli, trimmed);

      return {
        message: `${color.green('✓')} [${categoryLabel(cli)}] — Skills: ${skillLabel(cli.skillHints)}`,
        runText,
        metadata,
      };
    },
  };
}
