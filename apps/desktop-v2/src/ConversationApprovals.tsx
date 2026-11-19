import type { EngineSend } from './engine-operations';
import { ToolApprovalCard } from './ToolApprovalCard';

/** The tool calls waiting for a decision; only the first answers Y/N, so a key never skips one. */
export function ConversationApprovals({
  approvals,
  send,
  connected,
  shortcuts,
}: {
  approvals: readonly Record<string, unknown>[];
  send: EngineSend;
  connected: boolean;
  /** The conversation is the visible tab. */
  shortcuts: boolean;
}) {
  return approvals.map((approval, index) => (
    <ToolApprovalCard
      key={String(approval['id'])}
      approval={approval}
      send={send}
      connected={connected}
      shortcuts={shortcuts && index === 0}
    />
  ));
}
