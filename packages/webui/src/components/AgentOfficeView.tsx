import { Activity, Bot, Building2, Clock3, Coffee, HardDrive, Mail, Wifi, Zap } from 'lucide-react';
import { type CSSProperties, useMemo, useState } from 'react';
import { useAppTranslation } from '@/i18n';
import {
  buildAgentMailActivities,
  buildAgentToolCalls,
  buildMailRoutes,
  buildSnapshotMailActivities,
  buildSnapshotToolCalls,
  synthesizeCurrentTool,
} from '@/lib/agent-office';
import {
  useFleetStore,
  useMailboxStore,
  useMonitorStore,
  useSessionStore,
  useVizStore,
} from '@/stores';
import { ActionDetail, type SelectedAction } from './AgentOfficeDetails.js';
import { AgentLane } from './AgentOfficeView/AgentLane.js';
import { BreakRoom, isDeskAgent } from './AgentOfficeView/BreakRoom.js';
import { ClientOfficeHeader } from './AgentOfficeView/ClientOfficeHeader.js';
import {
  type ClientOfficeModel,
  clientOfficeStats,
  fallbackLogCalls,
  mergeCalls,
  mergeMail,
  type OfficeAgentModel,
} from './AgentOfficeView/model.js';
import { OfficeBriefing } from './AgentOfficeView/OfficeBriefing.js';
import { resolveClients } from './OfficeMapCanvas/resolve.js';
import { useRecentlyFinishedFleetAgents } from './OfficeMapCanvas/use-recently-finished.js';
import './AgentOfficeView.css';

export { AgentLane };

export function AgentOfficeView() {
  const { t } = useAppTranslation();
  const liveSessions = useMonitorStore((state) => state.liveSessions);
  const aggregate = useMonitorStore((state) => state.aggregate);
  const fleetAgents = useFleetStore((state) => state.agents);
  const mailboxAgents = useMailboxStore((state) => state.agents);
  const mailboxMessages = useMailboxStore((state) => state.messages);
  const toolEvents = useVizStore((state) => state.toolEvents);
  const projectNameFromSession = useSessionStore((state) => state.projectName);
  const recentlyFinished = useRecentlyFinishedFleetAgents(fleetAgents);
  const [selected, setSelected] = useState<SelectedAction | null>(null);

  const clients = useMemo(
    () =>
      resolveClients(
        liveSessions,
        fleetAgents,
        mailboxAgents,
        recentlyFinished.map,
        recentlyFinished.now,
      ),
    [liveSessions, fleetAgents, mailboxAgents, recentlyFinished],
  );

  const models = useMemo<OfficeAgentModel[]>(
    () =>
      clients.flatMap((client) =>
        client.agents.map((agent) => {
          const richCalls = buildAgentToolCalls(toolEvents, agent.serverId, client.sessionId);
          const snapshotCalls = buildSnapshotToolCalls(
            agent.recentTools,
            agent.serverId,
            client.sessionId,
          );
          const logs = fleetAgents.get(agent.serverId)?.toolLog ?? [];
          const calls = mergeCalls(richCalls, snapshotCalls, fallbackLogCalls(agent, client, logs));
          const isActive = agent.status === 'active' || agent.status === 'streaming';
          let current = calls.find((call) => call.status === 'running');
          if (!current && isActive && agent.currentTool) {
            current = synthesizeCurrentTool(agent.serverId, agent.currentTool, client.sessionId);
          }
          const display = current ?? calls[0];
          const history = calls.filter((call) => call.status !== 'running').slice(0, 6);
          const mail = mergeMail(
            buildSnapshotMailActivities(agent.recentMail),
            buildAgentMailActivities(mailboxMessages, agent, client.sessionId),
          );
          return {
            key: agent.officeId,
            client,
            agent,
            calls,
            current,
            display,
            history,
            mail,
          };
        }),
      ),
    [clients, fleetAgents, mailboxMessages, toolEvents],
  );

  const offices = useMemo<ClientOfficeModel[]>(
    () =>
      clients
        .map((client) => {
          const agents = models.filter((model) => model.client.id === client.id);
          return { client, agents, stats: clientOfficeStats(agents) };
        })
        .filter((office) => office.agents.length > 0),
    [clients, models],
  );

  const activeCount = models.filter(
    ({ agent }) => agent.status === 'active' || agent.status === 'streaming',
  ).length;
  const projectName =
    projectNameFromSession ||
    liveSessions.find((candidate) => candidate.projectName)?.projectName ||
    t('activity:office.fleetHq');
  const now = Date.now();

  return (
    <div className="agent-office">
      <header className="agent-office__header">
        <div className="agent-office__title">
          <span className="agent-office__brand-mark">
            <Building2 aria-hidden="true" />
          </span>
          <div>
            <span>{t('activity:agentOffice.liveProjectOffice')}</span>
            <h1>{projectName}</h1>
          </div>
        </div>

        <div className="agent-office__live-pill">
          <span /> {t('activity:agentOffice.live')}
        </div>

        <div className="agent-office__summary">
          <div>
            <Bot />
            <strong>{models.length}</strong>
            <span>{t('activity:agentOffice.agents')}</span>
          </div>
          <div>
            <Zap />
            <strong>{activeCount}</strong>
            <span>{t('activity:agentOffice.working')}</span>
          </div>
          <div>
            <Activity />
            <strong>{aggregate.toolCalls.toLocaleString()}</strong>
            <span>{t('activity:agentOffice.toolCalls')}</span>
          </div>
        </div>
      </header>

      <main className="agent-office__floor">
        {models.length > 0 ? (
          offices.map((office) => {
            const deskAgents = office.agents.filter(isDeskAgent);
            const loungeAgents = office.agents.filter((model) => !isDeskAgent(model));
            const mailRoutes = buildMailRoutes(deskAgents, now);
            const routedMailIds = new Set(mailRoutes.map((route) => route.id));
            return (
              <section className="agent-office__client-office" key={office.client.id}>
                <ClientOfficeHeader office={office} now={now} />
                <OfficeBriefing office={office} now={now} onSelect={setSelected} />
                {deskAgents.length > 0 && (
                  <div className="agent-office__column-headings" aria-hidden="true">
                    <span>{t('activity:agentOffice.team')}</span>
                    <span>{t('activity:agentOffice.liveDesk')}</span>
                    <span>{t('activity:agentOffice.lastActions')}</span>
                  </div>
                )}
                <div className="agent-office__client-desks">
                  {deskAgents.map((model) => (
                    <AgentLane
                      key={model.key}
                      model={model}
                      now={now}
                      onSelect={setSelected}
                      routedMailIds={routedMailIds}
                    />
                  ))}
                  {mailRoutes.length > 0 && (
                    <div className="agent-office__mail-routes" aria-hidden="true">
                      {mailRoutes.map((route) => (
                        <div
                          key={route.id}
                          className="agent-office__mail-route"
                          style={
                            {
                              '--from': `${((route.fromIndex + 0.5) / deskAgents.length) * 100}%`,
                              '--to': `${((route.toIndex + 0.5) / deskAgents.length) * 100}%`,
                            } as CSSProperties
                          }
                        >
                          <span className="agent-office__mail-route-parcel">
                            <Mail aria-hidden="true" />
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                  {deskAgents.length === 0 && (
                    <div className="agent-office__desks-empty">
                      <Coffee aria-hidden="true" />
                      {t('activity:agentOffice.desksEmpty')}
                    </div>
                  )}
                </div>
                {loungeAgents.length > 0 && (
                  <BreakRoom agents={loungeAgents} now={now} onSelect={setSelected} />
                )}
              </section>
            );
          })
        ) : (
          <div className="agent-office__empty-state">
            <span>
              <Wifi aria-hidden="true" />
            </span>
            <h2>{t('activity:agentOffice.readyTitle')}</h2>
            <p>{t('activity:agentOffice.readyBody')}</p>
          </div>
        )}
      </main>

      <footer className="agent-office__footer">
        <span>
          <span className="agent-office__status-dot is-active" />{' '}
          {t('activity:agentOffice.liveEvent')}
        </span>
        <span>
          <HardDrive />{' '}
          {t('activity:agentOffice.connectedSessions', { count: liveSessions.length })}
        </span>
        <span>
          <Clock3 /> {t('activity:agentOffice.detailHint')}
        </span>
      </footer>

      {selected && (
        <>
          <button
            type="button"
            className="agent-office__detail-backdrop"
            onClick={() => setSelected(null)}
            aria-label={t('activity:agentOffice.closeToolDetails')}
          />
          <ActionDetail selected={selected} onClose={() => setSelected(null)} />
        </>
      )}
    </div>
  );
}
