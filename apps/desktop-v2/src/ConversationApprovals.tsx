import type { Ref } from 'react';
import { useDesktopText } from './desktop-i18n';
import type { EngineSend } from './engine-operations';
import { ToolApprovalCard } from './ToolApprovalCard';

/** The tool calls waiting for a decision; only the first answers Y/N, so a key never skips one. */
export function ConversationApprovals({
  approvals,
  send,
  connected,
  shortcuts,
  queueRef,
}: {
  approvals: readonly Record<string, unknown>[];
  send: EngineSend;
  connected: boolean;
  /** The conversation is the visible tab. */
  shortcuts: boolean;
  queueRef: Ref<HTMLElement>;
}) {
  const { t } = useDesktopText();
  if (!approvals.length) return null;
  return (
    <section ref={queueRef} className="session-approval-queue" aria-label={t('approval.eyebrow')}>
      {approvals.map((approval, index) => (
        <ToolApprovalCard
          key={String(approval['id'])}
          approval={approval}
          send={send}
          connected={connected}
          shortcuts={shortcuts && index === 0}
        />
      ))}
    </section>
  );
}

export function ConversationApprovalNotice({
  approvals,
  onReview,
}: {
  approvals: readonly Record<string, unknown>[];
  onReview: () => void;
}) {
  const { t } = useDesktopText();
  if (!approvals.length) return null;
  const count = approvals.length;
  const tool = String(approvals[0]?.['toolName'] ?? 'Tool');
  return (
    <div className="input-waiting-controls" role="status">
      <span>
        {t('chatView.approvalPending', {
          count,
          tool,
          defaultValue:
            count === 1 ? `Approval needed for ${tool}` : `${count} tool approvals waiting`,
        })}
      </span>
      <button type="button" className="button secondary" onClick={onReview}>
        {t('chatView.reviewApproval', { defaultValue: 'Review approval' })}
      </button>
    </div>
  );
}
