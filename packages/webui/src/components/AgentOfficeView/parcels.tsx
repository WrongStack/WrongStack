import { Check, Code2, File, Inbox, Mail, Send, X } from 'lucide-react';
import { useAppTranslation } from '@/i18n';
import type { OfficeMailActivity, OfficeToolCall, OfficeToolKind } from '@/lib/agent-office';
import { cn } from '@/lib/utils';
import { AGENT_ROLE_ICONS, type AgentVisualRole, shortPath, TOOL_ICONS } from './model.js';

export function ToolGlyph({ kind, active }: { kind: OfficeToolKind; active?: boolean }) {
  const Icon = TOOL_ICONS[kind];
  return (
    <span className={cn('agent-office__tool-glyph', `is-${kind}`, active && 'is-active')}>
      {kind === 'read' && <File className="agent-office__file-underlay" aria-hidden="true" />}
      <Icon aria-hidden="true" />
    </span>
  );
}

export function AgentAvatar({
  active,
  failed,
  role,
  variant,
  motion,
}: {
  active: boolean;
  failed: boolean;
  role: AgentVisualRole;
  variant: number;
  motion: number;
}) {
  const RoleIcon = AGENT_ROLE_ICONS[role];
  return (
    <div
      className={cn(
        'agent-office__avatar',
        `is-${role}`,
        `is-avatar-${variant}`,
        `is-motion-${motion}`,
        active && 'is-active',
        !active && !failed && 'is-idle',
        failed && 'is-failed',
      )}
      aria-hidden="true"
    >
      <span className="agent-office__avatar-chair" />
      <span className="agent-office__avatar-body" />
      <span className="agent-office__avatar-head">
        <span className="agent-office__avatar-hair" />
        <span className="agent-office__avatar-face" />
        <span className="agent-office__avatar-mouth" />
        <span className="agent-office__avatar-headset" />
      </span>
      <span className="agent-office__avatar-arm" />
      <span className="agent-office__avatar-prop" />
      <span className="agent-office__avatar-role-badge">
        <RoleIcon />
      </span>
    </div>
  );
}

export function ToolParcel({
  call,
  compact = false,
  onSelect,
}: {
  call: OfficeToolCall;
  compact?: boolean;
  onSelect: () => void;
}) {
  const active = call.status === 'running';
  return (
    <button
      type="button"
      className={cn(
        'agent-office__parcel',
        `is-${call.kind}`,
        compact && 'is-compact',
        active && 'is-running',
        call.status === 'failed' && 'is-failed',
      )}
      onClick={onSelect}
      aria-label={`${call.toolName}: ${call.summary}`}
    >
      <ToolGlyph kind={call.kind} active={active} />
      <span className="agent-office__parcel-copy">
        <span className="agent-office__parcel-topline">
          <strong>{call.toolName}</strong>
          {call.lineLabel && <span className="agent-office__line-chip">{call.lineLabel}</span>}
        </span>
        {!compact && call.target && (
          <span className="agent-office__parcel-target">{shortPath(call.target)}</span>
        )}
        <span className="agent-office__parcel-summary">{call.summary}</span>
      </span>
      <span className="agent-office__parcel-state" aria-hidden="true">
        {active ? (
          <span className="agent-office__pulse-dot" />
        ) : call.status === 'failed' ? (
          <X />
        ) : (
          <Check />
        )}
      </span>
    </button>
  );
}

export function MailParcel({
  mail,
  compact = false,
  onSelect,
}: {
  mail: OfficeMailActivity;
  compact?: boolean;
  onSelect: () => void;
}) {
  const incoming = mail.direction === 'incoming';
  return (
    <button
      type="button"
      className={cn(
        'agent-office__mail-parcel',
        compact && 'is-compact',
        incoming ? 'is-incoming' : 'is-outgoing',
        mail.unread && 'is-unread',
      )}
      onClick={onSelect}
      aria-label={`${incoming ? 'Incoming' : 'Outgoing'} mail: ${mail.subject}`}
    >
      <span className="agent-office__mail-icon">
        {incoming ? <Inbox aria-hidden="true" /> : <Send aria-hidden="true" />}
      </span>
      <span className="agent-office__parcel-copy">
        <strong>{incoming ? `${mail.from} →` : `→ ${mail.to}`}</strong>
        <span className="agent-office__parcel-summary">{mail.subject}</span>
      </span>
      <Mail aria-hidden="true" />
    </button>
  );
}

export function EmptyParcel({ active }: { active: boolean }) {
  const { t } = useAppTranslation();
  return (
    <div className="agent-office__parcel agent-office__parcel--empty">
      <span className="agent-office__tool-glyph">
        <Code2 aria-hidden="true" />
      </span>
      <span className="agent-office__parcel-copy">
        <strong>
          {active ? t('activity:agentOffice.thinking') : t('activity:agentOffice.waiting')}
        </strong>
        <span>
          {active ? t('activity:agentOffice.preparing') : t('activity:agentOffice.deskReady')}
        </span>
      </span>
    </div>
  );
}
