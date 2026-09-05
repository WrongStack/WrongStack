import { Text } from "../ink.js";
import { theme } from "../theme.js";
import { glyphs } from "../ui-glyphs.js";
import type { RailSpanEntry } from "./powerline-rail.js";
import { BrainChip } from "./status-bar-chips.js";
import { fmtDebugBytes, fmtElapsed, truncateChip } from "./status-bar-format.js";
import { countdownColor, formatSuggestionLabel } from "./status-bar-helpers.js";
import { chipColor, STATUSLINE_ICONS } from "./status-bar-icons.js";
import type { FleetAgentDetail, MailboxStatus } from "./status-bar-types.js";
import {
  type StatusBarRailBuildParams,
  entry,
  compact,
  icon,
} from "./status-bar-rails-common.js";

function buildMailboxDetailEntries(
  p: StatusBarRailBuildParams,
  mailbox: MailboxStatus | undefined,
  showMailbox: boolean,
): RailSpanEntry[] {
  const { isNoColor } = p;
  if (!mailbox || !showMailbox) return [];
  const clients = (short: boolean): string => {
    const parts: string[] = [];
    if (mailbox.onlineClients.tui > 0) {
      parts.push(
        `${glyphs.desktop} TUI${mailbox.onlineClients.tui > 1 ? `×${mailbox.onlineClients.tui}` : ''}`,
      );
    }
    if (mailbox.onlineClients.webui > 0) {
      parts.push(
        `${glyphs.web} WebUI${mailbox.onlineClients.webui > 1 ? `×${mailbox.onlineClients.webui}` : ''}`,
      );
    }
    if (mailbox.onlineClients.repl > 0) {
      parts.push(
        `${glyphs.terminal} REPL${mailbox.onlineClients.repl > 1 ? `×${mailbox.onlineClients.repl}` : ''}`,
      );
    }
    return short || parts.length === 0 ? '' : ` · ${parts.join(' · ')}`;
  };

  return compact([
    entry('mailbox', 'mailbox', p, [
      mailbox.unread > 0 ? (
        <Text color={chipColor(theme.warn, isNoColor)} bold>
          {STATUSLINE_ICONS.mailbox} {mailbox.unread} new
        </Text>
      ) : (
        <Text dimColor={!isNoColor}>{STATUSLINE_ICONS.mailbox} 0</Text>
      ),
      <Text
        color={mailbox.unread > 0 ? chipColor(theme.warn, isNoColor) : undefined}
        dimColor={mailbox.unread === 0 && !isNoColor}
      >
        {STATUSLINE_ICONS.mailbox}
        {mailbox.unread}
      </Text>,
    ]),
    entry('mailbox_peers', 'mailbox', p, [
      <Text color={chipColor(theme.accent, isNoColor)}>
        {glyphs.peers} {mailbox.onlineAgents} agent{mailbox.onlineAgents === 1 ? '' : 's'}
        {clients(false)}
      </Text>,
      <Text color={chipColor(theme.accent, isNoColor)}>
        {glyphs.peers}
        {mailbox.onlineAgents}
      </Text>,
    ]),
    mailbox.lastSubject
      ? entry('mailbox_last', 'mailbox', p, [
          <Text dimColor={!isNoColor}>
            {mailbox.lastFrom ? `${mailbox.lastFrom}: ` : ''}
            {truncateChip(mailbox.lastSubject, 40)}
          </Text>,
          <Text dimColor={!isNoColor}>{truncateChip(mailbox.lastSubject, 16)}</Text>,
        ])
      : null,
  ]);
}

/**
 * One entry per live subagent. Each carries the `fleet_agents` contract key
 * (so the whole group moves line together and honours one density setting)
 * but a distinct id, so the rail can shed the 5th agent without shedding the
 * 1st and the hit-test keeps unique spans.
 */
function buildFleetAgentEntries(
  p: StatusBarRailBuildParams,
  agents: FleetAgentDetail[] | undefined,
): RailSpanEntry[] {
  const { isNoColor, showChip } = p;
  if (!agents || !showChip('fleet_agents')) return [];
  return compact(
    agents.map((agent, index) =>
      entry(index === 0 ? 'fleet_agents' : `fleet_agent-${index}`, 'fleet_agents', p, [
        <Text>
          <Text color={isNoColor ? undefined : agent.color} bold>
            {agent.label}
          </Text>
          <Text color={agent.running && !isNoColor ? theme.warn : undefined}>
            {` ${agent.running ? glyphs.running : '·'} `}
          </Text>
          <Text dimColor={!isNoColor}>
            {fmtElapsed(agent.elapsedMs)} · {agent.toolCalls}t
          </Text>
          {agent.tool ? (
            <Text color={isNoColor ? undefined : theme.accent}>{` · ${agent.tool}`}</Text>
          ) : null}
          {agent.extensions && agent.extensions > 0 ? (
            <Text color={isNoColor ? undefined : theme.warn}>
              {` · ${glyphs.process} ×${agent.extensions}`}
            </Text>
          ) : null}
        </Text>,
        <Text>
          <Text color={isNoColor ? undefined : agent.color} bold>
            {truncateChip(agent.label, 10)}
          </Text>
          <Text
            dimColor={!isNoColor}
          >{` ${agent.running ? glyphs.running : '·'} ${fmtElapsed(agent.elapsedMs)}`}</Text>
        </Text>,
        <Text color={isNoColor ? undefined : agent.color} bold>
          {truncateChip(agent.label, 6)}
        </Text>,
      ]),
    ),
  );
}

/**
 * Background activity: fleets, peers, services — plus the countdowns, which
 * tick every second and belong with the other things that arrive and leave
 * on their own schedule rather than with the turn's telemetry.
 */
export function buildAsyncChipEntries(p: StatusBarRailBuildParams): RailSpanEntry[] {
  const {
    showChip,
    isNoColor,
    fleetHasActivity,
    fleet,
    subagentCount,
    showBrain,
    brain,
    showDebugStream,
    debugStreamStats,
    mailbox,
    fleetAgents,
    showMailbox,
    memoryDetailChips,
    hasNextStepsAutoSubmit,
    nextStepsAutoSubmitCountdown,
    nextStepsAutoSubmitLabel,
    nextStepsColor,
    hasAutoProceed,
    autoProceedCountdown,
    showEnhance,
    enhanceCountdown,
  } = p;

  return compact([
    fleetHasActivity && showChip('fleet')
      ? fleet
        ? (() => {
            const counts = (
              <>
                {fleet.running > 0 ? (
                  <Text color={isNoColor ? undefined : theme.warn}>
                    {isNoColor ? `>${fleet.running}` : `${glyphs.running} ${fleet.running}`}
                  </Text>
                ) : null}
                {fleet.running > 0 && (fleet.pending > 0 || fleet.idle > 0 || fleet.completed > 0)
                  ? ' '
                  : ''}
                {fleet.pending > 0 ? (
                  <Text dimColor={!isNoColor}>
                    {isNoColor ? `.${fleet.pending}` : `${glyphs.pending} ${fleet.pending}`}
                  </Text>
                ) : null}
                {fleet.pending > 0 && (fleet.idle > 0 || fleet.completed > 0) ? ' ' : ''}
                {fleet.idle > 0 ? <Text dimColor={!isNoColor}>·{fleet.idle}idle</Text> : null}
                {fleet.idle > 0 && fleet.completed > 0 ? ' ' : ''}
                {fleet.completed > 0 ? (
                  <Text color={isNoColor ? undefined : theme.success}>
                    {isNoColor ? `+${fleet.completed}` : `${glyphs.success} ${fleet.completed}`}
                  </Text>
                ) : null}
              </>
            );
            const lead = (
              <Text color={isNoColor ? undefined : theme.accent}>
                {icon(STATUSLINE_ICONS.fleet, isNoColor)}
              </Text>
            );
            return entry('fleet', 'fleet', p, [
              <Text>
                {lead}
                {counts}
              </Text>,
              <Text>
                {lead}
                <Text color={isNoColor ? undefined : theme.warn}>
                  {`${glyphs.running} ${fleet.running}`}
                </Text>
              </Text>,
              <Text color={isNoColor ? undefined : theme.accent}>
                {`${STATUSLINE_ICONS.fleet}${fleet.running}`}
              </Text>,
            ]);
          })()
        : entry('fleet', 'fleet', p, [
            <Text color={chipColor(theme.accent, isNoColor)}>
              {icon(STATUSLINE_ICONS.fleet, isNoColor)}
              {subagentCount} agent{subagentCount === 1 ? '' : 's'}
            </Text>,
            <Text color={chipColor(theme.accent, isNoColor)}>
              {`${STATUSLINE_ICONS.fleet}${subagentCount}`}
            </Text>,
          ])
      : null,
    ...buildFleetAgentEntries(p, fleetAgents),
    ...buildMailboxDetailEntries(p, mailbox, showMailbox),
    showBrain && brain
      ? entry('brain', 'brain', p, [<BrainChip brain={brain} monochrome={isNoColor} />])
      : null,
    showDebugStream && debugStreamStats
      ? entry('debug_stream', 'debug_stream', p, [
          <Text color={chipColor(theme.accent, isNoColor)}>
            <Text bold>{isNoColor ? 'stream' : `${STATUSLINE_ICONS.debug_stream} stream`}</Text>
            <Text dimColor={!isNoColor}> #{debugStreamStats.chunkCount}</Text>
            <Text dimColor={!isNoColor}> · {debugStreamStats.lastChunkSize}B</Text>
            <Text dimColor={!isNoColor}> · +{debugStreamStats.lastDeltaMs}ms</Text>
            <Text dimColor={!isNoColor}> · {fmtDebugBytes(debugStreamStats.totalBytes)}</Text>
          </Text>,
          <Text color={chipColor(theme.accent, isNoColor)}>
            {`${STATUSLINE_ICONS.debug_stream}${debugStreamStats.chunkCount} · ${fmtDebugBytes(debugStreamStats.totalBytes)}`}
          </Text>,
          <Text color={chipColor(theme.accent, isNoColor)}>
            {`${STATUSLINE_ICONS.debug_stream}${debugStreamStats.chunkCount}`}
          </Text>,
        ])
      : null,
    ...memoryDetailChips,
    hasNextStepsAutoSubmit && nextStepsAutoSubmitCountdown != null && showChip('next_steps')
      ? entry('next_steps', 'next_steps', p, [
          <Text>
            <Text color={isNoColor ? undefined : nextStepsColor} bold>
              {isNoColor
                ? `${nextStepsAutoSubmitCountdown}s`
                : `${STATUSLINE_ICONS.next_steps} ${nextStepsAutoSubmitCountdown}s`}
            </Text>
            <Text dimColor={!isNoColor}>
              {nextStepsAutoSubmitLabel
                ? ` ${formatSuggestionLabel(nextStepsAutoSubmitLabel)}`
                : ''}
              {' · ⇥ edit'}
            </Text>
          </Text>,
          <Text color={isNoColor ? undefined : nextStepsColor} bold>
            {isNoColor
              ? `${nextStepsAutoSubmitCountdown}s ⇥`
              : `${STATUSLINE_ICONS.next_steps} ${nextStepsAutoSubmitCountdown}s ⇥`}
          </Text>,
        ])
      : null,
    hasAutoProceed && showChip('auto_proceed')
      ? entry('auto_proceed', 'auto_proceed', p, [
          <Text
            color={
              isNoColor
                ? undefined
                : autoProceedCountdown != null && autoProceedCountdown <= 5
                  ? theme.warn
                  : theme.accent
            }
          >
            {isNoColor
              ? `auto in ${autoProceedCountdown}s`
              : `${STATUSLINE_ICONS.auto_proceed} auto in ${autoProceedCountdown}s`}
          </Text>,
          <Text color={isNoColor ? undefined : theme.accent}>
            {`${STATUSLINE_ICONS.auto_proceed}${autoProceedCountdown}s`}
          </Text>,
        ])
      : null,
    showEnhance && enhanceCountdown != null
      ? entry('enhance', 'enhance', p, [
          <Text color={isNoColor ? undefined : countdownColor(enhanceCountdown, 15, 5)}>
            {isNoColor
              ? `refined · send in ${enhanceCountdown}s`
              : `${STATUSLINE_ICONS.enhance} refinement ready · send in ${enhanceCountdown}s`}
          </Text>,
          <Text color={isNoColor ? undefined : countdownColor(enhanceCountdown, 15, 5)}>
            {`${STATUSLINE_ICONS.enhance} send ${enhanceCountdown}s`}
          </Text>,
        ])
      : null,
  ]);
}
