import {
  Activity,
  Building2,
  Clock3,
  FilePenLine,
  FolderOpen,
  Mail,
  Search,
  TerminalSquare,
  Wifi,
} from 'lucide-react';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { type ClientOfficeModel, formatUptime } from './model.js';

export function ClientOfficeHeader({ office, now }: { office: ClientOfficeModel; now: number }) {
  const { t } = useAppTranslation();
  const { client, agents, stats } = office;
  const heartbeatAt = client.lastHeartbeatAt ? Date.parse(client.lastHeartbeatAt) : Number.NaN;
  const heartbeatFresh = Number.isFinite(heartbeatAt) && now - heartbeatAt < 20_000;
  const heartbeatDelayed = Number.isFinite(heartbeatAt) && !heartbeatFresh;
  const registryBacked = agents.some(({ agent }) => agent.presenceSource === 'registry');
  const presenceLabel = heartbeatFresh
    ? 'VERIFIED'
    : heartbeatDelayed
      ? 'DELAYED'
      : registryBacked
        ? 'REGISTRY'
        : 'LOCAL';
  const hasToolTelemetry = agents.some(
    ({ agent }) => agent.recentTools !== undefined || agent.activity !== undefined,
  );
  const hasLegacyAgent = agents.some(
    ({ agent }) =>
      agent.toolCalls > 0 && agent.recentTools === undefined && agent.activity === undefined,
  );
  return (
    <header className="agent-office__client-header">
      <div className="agent-office__client-title">
        <span className="agent-office__client-icon">
          <Building2 aria-hidden="true" />
        </span>
        <div className="agent-office__client-copy">
          <strong>{client.label}</strong>
          <span>{client.sublabel || client.sessionId}</span>
        </div>
        <div className="agent-office__client-presence">
          <span className="agent-office__client-agent-count">
            {agents.length} {t('activity:agentOffice.agents')}
          </span>
          <span
            className={cn(
              'agent-office__presence-chip',
              !heartbeatDelayed && 'is-live',
              heartbeatDelayed && 'is-legacy',
            )}
          >
            <Wifi aria-hidden="true" /> {presenceLabel}
          </span>
          <span className="agent-office__presence-chip">
            <Clock3 aria-hidden="true" /> {formatUptime(client.startedAt, now)} UP
          </span>
          <span
            className={cn(
              'agent-office__presence-chip',
              hasLegacyAgent ? 'is-legacy' : hasToolTelemetry && 'is-telemetry',
            )}
          >
            <Activity aria-hidden="true" />
            {hasLegacyAgent ? 'RECONNECT' : hasToolTelemetry ? 'TOOLS LIVE' : 'READY'}
          </span>
        </div>
      </div>
      <fieldset
        className="agent-office__client-stats"
        aria-label={t('activity:agentOffice.sessionActivityTotals')}
      >
        <span title={t('activity:agentOffice.uniqueFilesTouched')}>
          <FolderOpen /> <strong>{stats.files}</strong> {t('activity:agentOffice.files')}
        </span>
        <span title={t('activity:agentOffice.fileReads')}>
          <Search /> <strong>{stats.reads}</strong> {t('activity:agentOffice.read')}
        </span>
        <span title={t('activity:agentOffice.filesWritten')}>
          <FilePenLine /> <strong>{stats.writes}</strong> {t('activity:agentOffice.write')}
        </span>
        <span title={t('activity:agentOffice.filesEdited')}>
          <FilePenLine /> <strong>{stats.edits}</strong> {t('activity:agentOffice.edit')}
        </span>
        <span
          className="agent-office__client-delta"
          title={t('activity:agentOffice.linesAddedAndRemoved')}
        >
          <strong>+{stats.linesAdded}</strong> / <b>−{stats.linesRemoved}</b>
        </span>
        <span title={t('activity:agentOffice.terminalCommands')}>
          <TerminalSquare /> <strong>{stats.terminalCalls}</strong> {t('activity:agentOffice.term')}
        </span>
        <span title={t('activity:agentOffice.incomingAndOutgoingMail')}>
          <Mail /> <strong>{stats.incomingMail}</strong>↓ <strong>{stats.outgoingMail}</strong>↑
        </span>
      </fieldset>
    </header>
  );
}
