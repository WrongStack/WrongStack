import { DefaultPermissionPolicy } from '@wrongstack/core/security';
import type { PermissionTrace } from '@wrongstack/core/types';
import { resolveWstackPaths } from '@wrongstack/core/utils';
import type { Context } from '@wrongstack/core/agent';
import type { SubcommandHandler } from '../contracts.js';

/**
 * `wstack permissions explain <tool> --input '<json>' [--json]`
 *
 * Side-effect-free permission decision explainer. Evaluates the same
 * rules as `DefaultPermissionPolicy.evaluate()` without prompting the
 * user, writing to trust files, or mutating session state.
 */
export const permissionsCmd: SubcommandHandler = async (args, deps) => {
  const subCmd = args[0];

  if (subCmd === 'help' || subCmd === '--help' || subCmd === '-h' || !subCmd || subCmd === 'explain' && !args[1]) {
    if (subCmd !== 'explain' && subCmd !== 'help' && subCmd !== undefined) {
      deps.renderer.writeError(`Unknown permissions subcommand: ${subCmd}\n`);
    }
    deps.renderer.write(usage());
    return subCmd && subCmd !== 'explain' && subCmd !== 'help' && subCmd !== undefined ? 1 : 0;
  }

  if (subCmd !== 'explain') {
    deps.renderer.writeError(`Unknown permissions subcommand: ${subCmd}\n`);
    deps.renderer.write(usage());
    return 1;
  }

  // `wstack permissions explain <tool> [--input '<json>'] [--json]`
  const toolName = args[1];
  if (!toolName) {
    deps.renderer.writeError('Missing tool name.\n');
    deps.renderer.write(usage());
    return 1;
  }

  // Parse flags
  const inputIdx = args.indexOf('--input');
  const flagInput = deps.flags?.['input'];
  // Precedence: parsed top-level flags first, then positional --input/<value> as fallback.
  const rawInput =
    typeof flagInput === 'string'
      ? flagInput
      : inputIdx >= 0 && inputIdx + 1 < args.length
        ? args[inputIdx + 1]
        : undefined;
  const jsonOutput = deps.flags?.['json'] === true || args.includes('--json');

  // Parse input JSON
  let input: unknown = {};
  if (rawInput) {
    try {
      input = JSON.parse(rawInput);
    } catch {
      deps.renderer.writeError(`Invalid --input JSON: ${rawInput}\n`);
      return 1;
    }
  }

  // Resolve tool from registry
  if (!deps.toolRegistry) {
    deps.renderer.writeError('Tool registry is not available.\n');
    return 1;
  }
  const tool = deps.toolRegistry.get(toolName);
  if (!tool) {
    deps.renderer.writeError(`Unknown tool: "${toolName}". Available tools: ${deps.toolRegistry.list().map(t => t.name).join(', ')}\n`);
    return 1;
  }

  // Build trust file path
  const paths = resolveWstackPaths({ projectRoot: deps.projectRoot, userHome: deps.userHome });
  const trustFile = paths.projectTrust;

  // Build a minimal Context with hasRead stub
  const readSubjects = new Set<string>();
  const ctx: Context = {
    projectRoot: deps.projectRoot,
    cwd: deps.cwd,
    hasRead(subject: string) {
      return readSubjects.has(subject);
    },
  } as unknown as Context;

  // Create the policy and run explain
  const policy = new DefaultPermissionPolicy({
    trustFile,
    yolo: (deps.flags?.['yolo'] as boolean) ?? false,
  });
  await policy.reload();

  const trace: PermissionTrace = await policy.explain(tool, input, ctx);

  if (jsonOutput) {
    deps.renderer.write(JSON.stringify(trace, null, 2) + '\n');
  } else {
    deps.renderer.write(formatTrace(trace) + '\n');
  }

  return 0;
};

function formatTrace(trace: PermissionTrace): string {
  const lines: string[] = [];
  lines.push(`Permission trace for "${trace.toolName}"`);
  lines.push(`Subject: ${trace.subject ?? '(none)'}`);
  lines.push('');

  for (let i = 0; i < trace.steps.length; i++) {
    const step = trace.steps[i]!;
    const winner = i === trace.winnerIndex ? ' ← WINNER' : '';
    const matched = step.matched ? '✓' : ' ';
    lines.push(`  ${matched} [${i}] ${step.rule}${winner}`);
    lines.push(`        decision: ${step.decision}  source: ${step.source}`);
    lines.push(`        ${step.detail}`);
    if (i < trace.steps.length - 1) lines.push('');
  }

  lines.push('');
  lines.push(`Effective: ${trace.decision.permission} (source: ${trace.decision.source})`);
  if (trace.decision.reason) {
    lines.push(`Reason: ${trace.decision.reason}`);
  }
  if (trace.decision.riskTier) {
    lines.push(`Risk tier: ${trace.decision.riskTier}`);
  }

  return lines.join('\n');
}

function usage(): string {
  return (
    'Usage:\n' +
    '  wstack permissions explain <tool> --input \'<json>\' [--json]\n\n' +
    'Examples:\n' +
    '  wstack permissions explain bash --input \'{"command":"rm -rf /"}\'\n' +
    '  wstack permissions explain read --input \'{"path":".env"}\' --json\n\n' +
    'Flags:\n' +
    '  --input <json>   Tool input arguments as a JSON object\n' +
    '  --json           Output as structured JSON instead of human-readable text\n'
  );
}
