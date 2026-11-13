import type { TextBlock } from '@wrongstack/contracts/types/blocks';
import type { AgentContext } from '@wrongstack/contracts/types/context';
import type { PermissionPolicy } from '@wrongstack/contracts/types/permission';
import type { Tool } from '@wrongstack/contracts/types/tool';
import {
  architectureDecisionReadAuthorizer,
  checkArchitectureDecisions,
} from '../storage/architecture-decision-compliance.js';
import { ArchitectureDecisionStore } from '../storage/architecture-decision-store.js';
import { formatProjectSuppliedBlock } from '../utils/project-supplied-fence.js';

export async function buildArchitectureDecisionChecksBlock(
  ctx: AgentContext,
  permission?: Pick<PermissionPolicy, 'explain'>,
  readTool?: Tool,
): Promise<TextBlock | undefined> {
  if (!ctx.projectRoot) return undefined;
  try {
    const records = new ArchitectureDecisionStore(ctx.projectRoot).list();
    if (!records.some((record) => record.status === 'accepted' && record.checks?.length)) {
      delete ctx.meta.architectureDecisionChecks;
      return undefined;
    }
    const report = await checkArchitectureDecisions(
      ctx.projectRoot,
      architectureDecisionReadAuthorizer(ctx, permission, readTool),
    );
    ctx.meta.architectureDecisionChecks = report;
    return {
      type: 'text',
      text: formatProjectSuppliedBlock({
        tag: 'architecture_decision_checks',
        source: 'WrongStack bounded read-only checker',
        body: [
          `Current ADR check result: ${report.status}. These files were inspected for this request.`,
          'These checks validate only their declared conditions for the inspected bytes. They do not grant permissions or certify the whole architecture. A blocked check is not a pass. Address failed constraints before reporting the scoped work complete; continue independent work.',
          ...report.results.map(
            (result) =>
              `${result.decisionId} r${result.revision} ${result.contentHash} | ${result.checkId} | ${result.path} | ${result.status}: ${result.message}${result.fileHash ? ` SHA256=${result.fileHash}` : ''}`,
          ),
        ].join('\n'),
        notice: [
          'Host-computed check results for user-accepted ADRs; no project code or commands were executed.',
        ],
      }),
    };
  } catch {
    ctx.meta.architectureDecisionChecks = {
      status: 'blocked',
      message: 'ADR compliance checks unavailable.',
    };
    return {
      type: 'text',
      text: '[ADR compliance checks unavailable: blocked. No successful verification is claimed.]',
    };
  }
}
