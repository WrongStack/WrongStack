/**
 * MailboxComposeDialog — the wide compose surface for the Mailbox panel.
 *
 * The composer used to be an inline block inside the narrow SidePanel
 * column: four cramped selects, a 64px textarea, and a recipient typed from
 * memory against a datalist. This dialog gives the exact same
 * `mailbox.send` contract (webui-server `validateMailboxSendPayload`) a
 * full-width layout with a searchable agent roster, quick targets
 * (leader / broadcast / this session), a recipient scope chip, a
 * real-sized body textarea, and Ctrl+Enter to send.
 *
 * All draft state is owned by MailboxPanel — it is parked per session
 * there, so a draft survives both dialog closes and session switches.
 * This component is controlled and purely presentational.
 */

import { AlertTriangle, Lock, Search, Send } from 'lucide-react';
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { classifyMailboxRecipient, type MailboxAgent } from '@/stores/mailbox-store';

export type MailboxComposeType =
  | 'note'
  | 'ask'
  | 'assign'
  | 'steer'
  | 'btw'
  | 'broadcast'
  | 'status'
  | 'result'
  | 'review';

export const COMPOSE_TYPES: MailboxComposeType[] = [
  'note',
  'ask',
  'assign',
  'steer',
  'btw',
  'broadcast',
  'status',
  'result',
  'review',
];

export type MailboxSendState =
  | { phase: 'idle' }
  | { phase: 'sending'; requestId: string }
  | { phase: 'sent'; messageId?: string | undefined }
  | { phase: 'error'; message: string };

export interface MailboxComposeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Active session id — drives the `@session` quick target and session labels. */
  sessionId: string | null;
  /**
   * Full agent roster from the mailbox store. Messaging is project-wide, so
   * this is intentionally NOT the session-scoped subset the message list
   * uses — you can address any registered agent from here.
   */
  agents: MailboxAgent[];
  to: string;
  onToChange: (to: string) => void;
  type: MailboxComposeType;
  onTypeChange: (type: MailboxComposeType) => void;
  audience: 'all' | 'leaders';
  onAudienceChange: (audience: 'all' | 'leaders') => void;
  priority: 'low' | 'normal' | 'high';
  onPriorityChange: (priority: 'low' | 'normal' | 'high') => void;
  subject: string;
  onSubjectChange: (subject: string) => void;
  body: string;
  onBodyChange: (body: string) => void;
  /** Message id this draft replies to, or null for a fresh compose. */
  replyTo: string | null;
  ready: boolean;
  sendState: MailboxSendState;
  onSend: () => void;
}

function chipClass(active: boolean): string {
  return cn(
    'border border-border px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:border-primary/60 hover:text-foreground disabled:opacity-40',
    active && 'border-primary bg-primary/10 text-foreground',
  );
}

export function MailboxComposeDialog(props: MailboxComposeDialogProps) {
  const { t } = useAppTranslation();
  const [query, setQuery] = useState('');
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  // A stale roster filter from the previous open is never what you want.
  useEffect(() => {
    if (props.open) setQuery('');
  }, [props.open]);

  const effectiveTo = props.type === 'broadcast' ? '*' : props.to.trim();
  const scope = useMemo(() => classifyMailboxRecipient(effectiveTo), [effectiveTo]);

  const visibleAgents = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...props.agents]
      .filter(
        (agent) =>
          q.length === 0 ||
          agent.name.toLowerCase().includes(q) ||
          agent.agentId.toLowerCase().includes(q) ||
          (agent.role ?? '').toLowerCase().includes(q) ||
          (agent.currentTask ?? '').toLowerCase().includes(q),
      )
      .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  }, [props.agents, query]);

  const onlineCount = props.agents.filter((agent) => agent.online).length;

  // Mirrors the server rule in validateMailboxSendPayload: assign/steer
  // must name a specific recipient — '*'/'all' and a session scope
  // ('@session' / '@session:<id>', checkMailboxSendType) are rejected there.
  const needsSpecificRecipient =
    (props.type === 'assign' || props.type === 'steer') &&
    (effectiveTo === '*' ||
      effectiveTo.toLowerCase() === 'all' ||
      effectiveTo.toLowerCase() === '@session' ||
      effectiveTo.startsWith('@session:'));

  const canSend =
    props.ready &&
    props.body.trim().length > 0 &&
    (props.type === 'broadcast' || props.to.trim().length > 0) &&
    !needsSpecificRecipient &&
    props.sendState.phase !== 'sending';

  function pickRecipient(value: string) {
    // Broadcast locks the recipient to '*'; picking a target leaves that lock.
    if (props.type === 'broadcast') props.onTypeChange('note');
    props.onToChange(value);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && canSend) {
      event.preventDefault();
      props.onSend();
    }
  }

  const scopeLabel =
    scope.scope === 'project'
      ? t('activity:mailbox.projectScope')
      : scope.scope === 'session'
        ? t('activity:mailbox.sessionScope', { sid: scope.recipientSessionId ?? '' })
        : t('activity:mailbox.directScope');

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        className="gap-4 sm:max-w-2xl"
        onKeyDown={handleKeyDown}
        onOpenAutoFocus={(event) => {
          // Replies: the recipient is already decided — land in the body.
          if (props.replyTo) {
            event.preventDefault();
            bodyRef.current?.focus();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Send className="h-4 w-4 text-primary" />
            {t('activity:mailbox.compose')}
          </DialogTitle>
          <DialogDescription>{t('activity:mailbox.composeDescription')}</DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 gap-4 md:grid-cols-[minmax(13rem,16rem)_1fr]">
          {/* ── Agent roster ─────────────────────────────────────────── */}
          <div className="flex min-w-0 flex-col gap-2 border border-border bg-background/60 p-2">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {t('activity:nav.agents')}
              </span>
              <span className="tabular text-[10px] text-muted-foreground">
                {t('activity:mailbox.onlineCount', { count: onlineCount })} · {props.agents.length}
              </span>
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                className="h-7 w-full border border-border bg-background pl-7 pr-2 text-xs text-foreground"
                value={query}
                placeholder={t('activity:mailbox.searchAgents')}
                aria-label={t('activity:mailbox.searchAgents')}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <div className="flex flex-wrap gap-1">
              <button
                type="button"
                title={t('activity:mailbox.directScope')}
                onClick={() => pickRecipient('leader')}
                className={chipClass(effectiveTo === 'leader')}
              >
                leader
              </button>
              {props.sessionId && (
                <button
                  type="button"
                  title={t('activity:mailbox.sessionScopeTitle', { sid: props.sessionId })}
                  onClick={() => pickRecipient(`@session:${props.sessionId}`)}
                  className={chipClass(effectiveTo === `@session:${props.sessionId}`)}
                >
                  {t('activity:mailbox.sessionLabel')}
                </button>
              )}
              <button
                type="button"
                title="*"
                onClick={() => {
                  props.onToChange('*');
                  props.onTypeChange('broadcast');
                }}
                className={chipClass(props.type === 'broadcast')}
              >
                {t('activity:mailbox.type.broadcast')}
              </button>
            </div>
            <div className="-mr-1 max-h-56 min-h-16 flex-1 overflow-y-auto overscroll-contain pr-1 md:max-h-[min(22rem,calc(100dvh-24rem))]">
              {props.agents.length === 0 ? (
                <p className="py-3 text-center text-[10px] text-muted-foreground">
                  {t('activity:mailbox.noAgentsRegistered')}
                </p>
              ) : visibleAgents.length === 0 ? (
                <p className="py-3 text-center text-[10px] text-muted-foreground">
                  {t('activity:mailbox.noAgentsFound')}
                </p>
              ) : (
                visibleAgents.map((agent) => {
                  const selected = effectiveTo === agent.agentId;
                  return (
                    <button
                      key={agent.agentId}
                      type="button"
                      disabled={props.type === 'broadcast'}
                      onClick={() => pickRecipient(agent.agentId)}
                      className={cn(
                        'mb-0.5 flex w-full flex-col gap-0.5 border border-transparent px-2 py-1.5 text-left transition-colors hover:bg-accent/60 disabled:pointer-events-none disabled:opacity-40',
                        selected && 'border-primary bg-primary/5',
                      )}
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span
                          className={cn(
                            'h-1.5 w-1.5 shrink-0 rounded-full',
                            agent.online ? 'bg-success' : 'bg-muted-foreground/30',
                          )}
                        />
                        <span className="truncate text-xs font-medium text-foreground">
                          {agent.name}
                        </span>
                        {agent.role && (
                          <span className="shrink-0 text-[10px] text-muted-foreground">
                            ({agent.role})
                          </span>
                        )}
                      </span>
                      <span
                        className="truncate font-mono text-[10px] text-muted-foreground"
                        title={agent.agentId}
                      >
                        {agent.agentId}
                      </span>
                      {agent.currentTool && (
                        <span className="truncate text-[10px] text-foreground/80">
                          {agent.currentTool}
                        </span>
                      )}
                    </button>
                  );
                })
              )}
            </div>
          </div>

          {/* ── Message fields ───────────────────────────────────────── */}
          <div className="flex min-w-0 flex-col gap-3">
            <label className="space-y-1 text-[10px] text-muted-foreground">
              <span>{t('activity:mailbox.recipient')}</span>
              <span className="flex items-center gap-1.5">
                <input
                  className="h-8 min-w-0 flex-1 border border-border bg-background px-2 text-xs text-foreground disabled:opacity-50"
                  value={props.type === 'broadcast' ? '*' : props.to}
                  list="mailbox-agent-recipients"
                  disabled={props.type === 'broadcast'}
                  placeholder="leader"
                  onChange={(event) => props.onToChange(event.target.value)}
                />
                {effectiveTo.length > 0 && (
                  <span
                    className="shrink-0 bg-muted/40 px-1.5 py-0.5 text-[9px] font-semibold text-muted-foreground"
                    title={scopeLabel}
                  >
                    {scopeLabel}
                  </span>
                )}
              </span>
            </label>
            <div className="grid grid-cols-3 gap-2">
              <label className="space-y-1 text-[10px] text-muted-foreground">
                <span>{t('activity:mailbox.messageType')}</span>
                <select
                  className="h-8 w-full border border-border bg-background px-1.5 text-xs text-foreground"
                  value={props.type}
                  onChange={(event) => props.onTypeChange(event.target.value as MailboxComposeType)}
                >
                  {COMPOSE_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {t(`activity:mailbox.type.${type}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1 text-[10px] text-muted-foreground">
                <span>{t('activity:mailbox.audience')}</span>
                <select
                  className="h-8 w-full border border-border bg-background px-1.5 text-xs text-foreground"
                  value={props.audience}
                  onChange={(event) =>
                    props.onAudienceChange(event.target.value as 'all' | 'leaders')
                  }
                >
                  <option value="all">{t('activity:mailbox.audienceAll')}</option>
                  <option value="leaders">{t('activity:mailbox.audienceLeaders')}</option>
                </select>
              </label>
              <label className="space-y-1 text-[10px] text-muted-foreground">
                <span>{t('activity:mailbox.priority')}</span>
                <select
                  className="h-8 w-full border border-border bg-background px-1.5 text-xs text-foreground"
                  value={props.priority}
                  onChange={(event) =>
                    props.onPriorityChange(event.target.value as 'low' | 'normal' | 'high')
                  }
                >
                  <option value="low">{t('activity:mailbox.priorityLow')}</option>
                  <option value="normal">{t('activity:mailbox.priorityNormal')}</option>
                  <option value="high">{t('activity:mailbox.priorityHigh')}</option>
                </select>
              </label>
            </div>
            <datalist id="mailbox-agent-recipients">
              <option value="leader" />
              <option value="*" />
              {props.agents.map((agent) => (
                <option key={agent.agentId} value={agent.agentId} />
              ))}
            </datalist>
            <input
              className="h-8 w-full border border-border bg-background px-2 text-xs text-foreground"
              value={props.subject}
              aria-label={t('activity:mailbox.subjectPlaceholder')}
              placeholder={t('activity:mailbox.subjectPlaceholder')}
              onChange={(event) => props.onSubjectChange(event.target.value)}
            />
            <textarea
              ref={bodyRef}
              className="min-h-36 w-full resize-y border border-border bg-background px-2 py-1.5 text-xs leading-relaxed text-foreground"
              value={props.body}
              aria-label={t('activity:mailbox.bodyPlaceholder')}
              placeholder={t('activity:mailbox.bodyPlaceholder')}
              onChange={(event) => props.onBodyChange(event.target.value)}
            />
            {props.replyTo && (
              <div className="text-[10px] text-foreground/80">
                {t('activity:mailbox.replyTo', { id: props.replyTo.slice(0, 8) })}
              </div>
            )}
            {needsSpecificRecipient && (
              <div className="flex items-center gap-1 text-[10px] text-foreground/80">
                {/* Icon carries the warning hue — 10px warning text measured
                    3.16:1 on light theme, below the 4.5:1 text bar (icons
                    only need 3:1 non-text contrast). */}
                <AlertTriangle className="h-3 w-3 shrink-0 text-warning" />
                {t('activity:mailbox.specificRecipientRequired')}
              </div>
            )}
            {props.audience === 'leaders' && (
              <div className="flex items-center gap-1 text-[10px] text-foreground/80">
                <Lock className="h-3 w-3 text-primary" />
                {t('activity:mailbox.leadersOnlyHint')}
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="sm:gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-2 sm:justify-start">
            <span className="hidden shrink-0 text-[10px] text-muted-foreground sm:inline">
              {t('activity:mailbox.ctrlEnterHint')}
            </span>
            {props.sendState.phase === 'sent' && (
              <span className="text-[10px] text-success">
                {t('activity:mailbox.sent')}
                {props.sendState.messageId ? ` · ${props.sendState.messageId.slice(0, 8)}` : ''}
              </span>
            )}
            {props.sendState.phase === 'error' && (
              <span
                className="truncate text-[10px] text-destructive"
                title={props.sendState.message}
              >
                {props.sendState.message}
              </span>
            )}
          </div>
          <button
            type="button"
            className="inline-flex h-8 items-center gap-1.5 border border-primary bg-primary px-3 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
            disabled={!canSend}
            onClick={props.onSend}
          >
            <Send className="h-3.5 w-3.5" />
            {props.sendState.phase === 'sending'
              ? t('activity:mailbox.sending')
              : t('activity:mailbox.send')}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
