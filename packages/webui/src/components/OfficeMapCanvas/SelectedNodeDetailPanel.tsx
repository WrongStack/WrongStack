import type { Node } from '@xyflow/react';
import { Bot, Cpu, Mail, Maximize2, Monitor, Terminal } from 'lucide-react';
import type { ReactNode } from 'react';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import type { AgentTranscriptEntry, MailboxMessage } from '@/stores';
import { AgentTranscript } from '../AgentTranscript';
import { SessionWatchPanel } from '../SessionWatchPanel';
import {
  fmtAgo,
  fmtCompact,
  fmtUptime,
  type OfficeNodeData,
  shortModel,
  surfaceLabel,
} from './utils.js';
import { clampCtxPct } from './nodes.js';

interface SelectedNodeDetailPanelProps {
  selectedNode: Node<OfficeNodeData>;
  selectedAgentTranscript: AgentTranscriptEntry[];
  mailboxMessages: MailboxMessage[];
  onClose: () => void;
  onOpenWatch: (watch: { sessionId: string; label: string }) => void;
}

function DetailRow({ k, v, accent }: { k: string; v: ReactNode; accent?: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-muted-foreground shrink-0">{k}</span>
      <span className={cn('font-mono truncate text-right', accent ?? 'text-foreground/80')}>
        {v}
      </span>
    </div>
  );
}

export function SelectedNodeDetailPanel({
  selectedNode,
  selectedAgentTranscript,
  mailboxMessages,
  onClose,
  onOpenWatch,
}: SelectedNodeDetailPanelProps) {
  const { t } = useAppTranslation();
  const d = selectedNode.data;
  const now = Date.now();
  const isAgent = d.kind === 'agent';
  const isClient = d.kind === 'webui' || d.kind === 'tui' || d.kind === 'repl';
  const tokTotal = (d.tokensIn || 0) + (d.tokensOut || 0);
  const ctxPct = clampCtxPct(d.ctxPct);

  return (
    <div
      className={cn(
        'absolute top-20 right-4 bg-background border border-border rounded-lg p-4 shadow-xl z-20',
        d.kind === 'agent' ? 'w-[28rem] max-w-[calc(100%-2rem)]' : d.sessionId ? 'w-80' : 'w-64',
      )}
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          {d.kind === 'webui' && <Monitor className="h-4 w-4 text-info" />}
          {d.kind === 'tui' && <Terminal className="h-4 w-4 text-success" />}
          {d.kind === 'coordinator' && <Cpu className="h-4 w-4 text-primary" />}
          {d.kind === 'agent' && <Bot className="h-4 w-4 text-primary" />}
          {d.kind === 'mailbox' && <Mail className="h-4 w-4 text-warning" />}
          <span className="text-sm font-bold text-foreground">{d.label}</span>
        </div>
        <div className="flex items-center gap-1.5">
          {d.sessionId && (
            <button
              type="button"
              title={t('activity:office.openFullView')}
              onClick={() => onOpenWatch({ sessionId: d.sessionId!, label: d.label })}
              className="text-muted-foreground hover:text-primary"
            >
              <Maximize2 className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground text-lg leading-none"
          >
            ×
          </button>
        </div>
      </div>

      <div className="space-y-1.5 text-xs">
        <DetailRow
          k="Status"
          v={String(d.status).toUpperCase()}
          accent={cn(
            d.status === 'active' && 'text-success',
            d.status === 'streaming' && 'text-primary',
            d.status === 'error' && 'text-destructive',
            d.status === 'idle' && 'text-muted-foreground',
            d.status === 'offline' && 'text-muted-foreground/70',
          )}
        />

        {isAgent && (
          <>
            {d.model && <DetailRow k="Model" v={shortModel(d.model)} accent="text-primary" />}
            {d.currentTask && (
              <div className="pt-1">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  {t('activity:agentOffice.currentTask')}
                </div>
                <div className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[10px] text-primary">
                  {d.currentTask}
                </div>
              </div>
            )}
            <DetailRow k="Iterations" v={d.iteration || 0} accent="text-primary" />
            <DetailRow k="Tool calls" v={d.toolCalls || 0} accent="text-warning" />
            <DetailRow k="Tokens in" v={fmtCompact(d.tokensIn)} />
            <DetailRow k="Tokens out" v={fmtCompact(d.tokensOut)} />
            <DetailRow k="Tokens total" v={fmtCompact(tokTotal)} />
            {ctxPct > 0 && (
              <DetailRow
                k="Context"
                v={`${ctxPct}%`}
                accent={
                  ctxPct >= 90
                    ? 'text-destructive'
                    : ctxPct >= 70
                      ? 'text-warning'
                      : 'text-foreground/70'
                }
              />
            )}
            <DetailRow k="Cost" v={`$${(d.costUsd || 0).toFixed(4)}`} accent="text-success" />
            {d.lastActivityAt && (
              <DetailRow
                k="Last seen"
                v={fmtAgo(d.lastActivityAt, now)}
                accent="text-muted-foreground"
              />
            )}
            <div className="pt-2">
              <AgentTranscript
                entries={selectedAgentTranscript}
                agentName={d.label}
                compact
                maxHeightClassName="max-h-64"
              />
            </div>
          </>
        )}

        {isClient && (
          <>
            <DetailRow
              k="Surface"
              v={surfaceLabel(d.kind as 'tui' | 'webui' | 'repl')}
              accent="text-foreground/80"
            />
            {d.branch && <DetailRow k="Branch" v={`⎇ ${d.branch}`} accent="text-foreground/70" />}
            {d.pid != null && <DetailRow k="PID" v={d.pid} />}
            {d.workingDir && <DetailRow k="Dir" v={d.workingDir} accent="text-muted-foreground" />}
            <DetailRow k="Agents" v={d.agentCount ?? 0} accent="text-primary" />
            {d.startedAt && (
              <DetailRow k="Uptime" v={fmtUptime(d.startedAt, now)} accent="text-foreground/70" />
            )}
          </>
        )}

        {d.kind === 'mailbox' && (
          <>
            <DetailRow k="Total messages" v={d.messageCount || 0} accent="text-warning" />
            <DetailRow k="Unread" v={d.unreadCount || 0} accent="text-warning" />
            {mailboxMessages.length > 0 && (
              <div className="mt-1 space-y-1 border-t border-border pt-2">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  {t('activity:office.recent')}
                </div>
                {[...mailboxMessages]
                  .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
                  .slice(0, 6)
                  .map((m) => {
                    const unread = !m.completed && (m.readByCount ?? 0) === 0;
                    return (
                      <div key={m.id} className="flex items-start gap-1.5 text-[10px]">
                        <span
                          className={cn(
                            'mt-1 h-1.5 w-1.5 shrink-0 rounded-full',
                            unread ? 'bg-warning' : m.completed ? 'bg-success' : 'bg-muted',
                          )}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-foreground/80">
                            {m.subject || t('activity:office.noSubject')}
                          </div>
                          <div className="truncate font-mono text-[9px] text-muted-foreground">
                            {m.from} → {m.to} · {fmtAgo(m.timestamp, now)}
                            {m.audience === 'leaders'
                              ? ` · ${t('activity:mailbox.audienceLeaders')}`
                              : ''}
                          </div>
                        </div>
                      </div>
                    );
                  })}
              </div>
            )}
          </>
        )}

        {d.kind === 'coordinator' && (
          <>
            <DetailRow k="Connections" v={d.connections || 0} accent="text-primary" />
            <DetailRow k="Iterations" v={d.iteration || 0} accent="text-primary" />
          </>
        )}

        {(isAgent || isClient) && d.sessionId && (
          <div className="mt-2 border-t border-border pt-2 h-72">
            <SessionWatchPanel sessionId={d.sessionId} />
          </div>
        )}
      </div>
    </div>
  );
}
