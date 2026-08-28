import type { GovernanceDaemonOperatorStatusReadResult } from '@wrongstack/runtime/governance-bootstrap';
import type { SubcommandDeps, SubcommandHandler } from '../contracts.js';

interface GovernanceStatusCommandDependencies {
  readonly readStatus: (projectRoot: string) => Promise<GovernanceDaemonOperatorStatusReadResult>;
}

const DEFAULT_DEPENDENCIES: GovernanceStatusCommandDependencies = {
  readStatus: async (projectRoot) => {
    const runtime = await import('@wrongstack/runtime/governance-bootstrap');
    return runtime.readGovernanceDaemonOperatorStatus(projectRoot);
  },
};

function usage(): string {
  return (
    'Usage:\n' +
    '  wstack governance status [--json]\n\n' +
    'Reads the project daemon through its local read-only status capability.\n' +
    'Warnings are advisory and do not stop active tasks or model execution.\n'
  );
}

function jsonRequested(args: readonly string[], deps: SubcommandDeps): boolean {
  return args.includes('--json') || deps.flags?.['json'] === true;
}

export async function runGovernanceStatusCommand(
  args: string[],
  deps: SubcommandDeps,
  dependencies: GovernanceStatusCommandDependencies = DEFAULT_DEPENDENCIES,
): Promise<number> {
  const json = jsonRequested(args, deps);
  const result = await dependencies.readStatus(deps.projectRoot);
  if (json) {
    deps.renderer.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.available ? 0 : 1;
  }
  if (!result.available) {
    deps.renderer.writeError(`Governance status unavailable (${result.code}): ${result.message}\n`);
    return 1;
  }
  const { status } = result;
  const broker = status.attachmentBroker;
  const lines = [
    `Governance daemon: running (pid ${status.pid}, instance ${status.instanceId})`,
    `Attachment broker: ${broker?.health ?? 'unavailable'}`,
    `Operator signal: ${status.signal.level} (${status.signal.code})`,
    `Operator action: ${status.signal.operatorAction}`,
    'Execution: continue (advisory only; no automatic task or model stop)',
  ];
  if (broker) {
    lines.push(`Consecutive failures: ${broker.consecutiveFailures}`);
    lines.push(`Pending revocations: ${broker.pendingRevocations}`);
    lines.push(`Audit persistence: ${broker.auditHealthy ? 'healthy' : 'unhealthy'}`);
  }
  deps.renderer.write(`${lines.join('\n')}\n`);
  return 0;
}

export const governanceCmd: SubcommandHandler = async (args, deps) => {
  const subcommand = args[0];
  if (!subcommand || subcommand === 'status') {
    return runGovernanceStatusCommand(subcommand ? args.slice(1) : args, deps);
  }
  if (subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    deps.renderer.write(usage());
    return 0;
  }
  deps.renderer.writeError(`Unknown governance subcommand: ${subcommand}\n`);
  deps.renderer.write(usage());
  return 1;
};
