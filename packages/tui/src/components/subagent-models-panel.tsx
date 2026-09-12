import type React from 'react';
import { Box, Text } from '../ink.js';
import type { SubagentLaneView, SubagentRoleView } from '../ui-contracts.js';

/**
 * Per-session subagent model lanes — the panel behind `/subagent-models`.
 *
 * One row per lane: the Nth subagent running at any moment takes the Nth free
 * lane, so a fan-out of 8 workers runs on 8 different provider/model pairs.
 * Editing a row reuses the shared two-step model picker (`requestModelPick`),
 * which is why this component carries no provider list of its own.
 */

export interface SubagentModelsPanelProps {
  lanes: SubagentLaneView[];
  roles: SubagentRoleView[];
  selected: number;
  enabled: boolean;
  lock: boolean;
  followSessionModel: boolean;
  sessionTarget: string;
  hint?: string | undefined;
  maxRows?: number | undefined;
}

export function SubagentModelsPanel({
  lanes,
  roles,
  selected,
  enabled,
  lock,
  followSessionModel,
  sessionTarget,
  hint,
  maxRows = 12,
}: SubagentModelsPanelProps): React.ReactElement {
  // Keep the focused lane on screen for a long lane list.
  const windowStart = Math.max(
    0,
    Math.min(selected - Math.floor(maxRows / 2), lanes.length - maxRows),
  );
  const start = Math.max(0, windowStart);
  const visible = lanes.slice(start, start + maxRows);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="blue" paddingX={1}>
      <Text bold color="blue">
        ━━ Subagent models (this session) ━━
      </Text>
      <Text dimColor>
        ↑↓ move · Enter set model · c clear · l lock · s session model · space on/off · Esc close
      </Text>

      <Box marginTop={1}>
        <Text bold>Plan: </Text>
        {enabled ? <Text color="green">● on</Text> : <Text color="gray">○ off</Text>}
        <Text dimColor>{'   '}</Text>
        <Text bold>Lock: </Text>
        {lock ? <Text color="green">on</Text> : <Text color="gray">off</Text>}
        <Text dimColor>
          {lock ? '  (lanes override the leader)' : '  (leader pins win; lanes fill gaps)'}
        </Text>
      </Box>

      <Box>
        <Text bold>Use session model: </Text>
        {followSessionModel ? <Text color="green">on</Text> : <Text color="gray">off</Text>}
        {followSessionModel ? (
          <Text dimColor>{`  every plain subagent → ${sessionTarget}`}</Text>
        ) : null}
      </Box>

      <Box marginTop={1} flexDirection="column">
        {followSessionModel ? (
          <Text dimColor>lanes are inactive while "use session model" is on</Text>
        ) : null}
        {visible.map((lane, i) => {
          const index = start + i;
          const focused = index === selected;
          return (
            <Box key={`lane-${index}`}>
              <Text color={focused ? 'cyan' : undefined}>{focused ? '❯ ' : '  '}</Text>
              <Text color={lane.busy > 0 ? 'green' : 'gray'}>{lane.busy > 0 ? '●' : '○'}</Text>
              <Text dimColor>{` ${String(index + 1).padStart(2)} `}</Text>
              <Text color={lane.target ? 'cyan' : undefined} dimColor={!lane.target}>
                {lane.target || '(inherit — matrix / tier / session)'}
              </Text>
              {lane.label ? <Text dimColor>{`  ${lane.label}`}</Text> : null}
            </Box>
          );
        })}
      </Box>

      {lanes.length > maxRows ? <Text dimColor>{`  … ${lanes.length} lanes total`}</Text> : null}

      {roles.length > 0 ? (
        <Box marginTop={1} flexDirection="column">
          <Text bold>Role overrides</Text>
          <Text dimColor>beat the lanes and consume none</Text>
          {roles.map((role) => (
            <Box key={`role-${role.role}`}>
              <Text dimColor>{`    ${role.role.padEnd(20)} → `}</Text>
              <Text color="cyan">{role.target}</Text>
            </Box>
          ))}
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text dimColor>
          {hint ?? 'Scoped to this session and restored by /resume — config.json is untouched.'}
        </Text>
      </Box>
    </Box>
  );
}
