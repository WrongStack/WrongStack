import { Text } from "../ink.js";
import { theme } from "../theme.js";
import { glyphs } from "../ui-glyphs.js";
import type { RailSpanEntry } from "./powerline-rail.js";
import { EternalStageChip } from "./status-bar-chips.js";
import { truncateChip } from "./status-bar-format.js";
import { countdownColor } from "./status-bar-helpers.js";
import { chipColor, STATUSLINE_ICONS } from "./status-bar-icons.js";
import {
  type StatusBarRailBuildParams,
  entry,
  compact,
  icon,
} from "./status-bar-rails-common.js";

/**
 * Standing posture (is this session dangerous? is it throttled?) followed by
 * the work in flight. A reader scans this rail left-to-right to answer
 * "what is it allowed to do, and what is it doing".
 */
export function buildSafetyWorkEntries(p: StatusBarRailBuildParams): RailSpanEntry[] {
  const {
    yolo,
    showChip,
    isNoColor,
    autonomy,
    processCount,
    tokenSavingMode,
    sideEffectCount,
    showEternalStage,
    eternalStage,
    breakerCountdown,
    droppedTools,
    todos,
    todosCleared,
    plan,
    hasTaskActivity,
    tasks,
    hasActiveGoal,
    goalSummary,
  } = p;
  const autonomyColor = chipColor(
    autonomy === 'eternal' ? theme.error : autonomy === 'auto' ? theme.warn : theme.accent,
    isNoColor,
  );

  return compact([
    yolo && showChip('yolo')
      ? entry('yolo', 'yolo', p, [
          <Text color={chipColor(theme.error, isNoColor)} bold>
            {isNoColor ? 'YOLO' : `${STATUSLINE_ICONS.yolo} YOLO`}
          </Text>,
          <Text color={chipColor(theme.error, isNoColor)} bold>
            {isNoColor ? 'YOLO' : `${STATUSLINE_ICONS.yolo}Y`}
          </Text>,
        ])
      : null,
    autonomy && autonomy !== 'off' && showChip('autonomy')
      ? entry('autonomy', 'autonomy', p, [
          <Text color={autonomyColor} bold>
            {isNoColor ? autonomy.toUpperCase() : `∞ ${autonomy.toUpperCase()}`}
          </Text>,
          <Text color={autonomyColor} bold>
            {isNoColor
              ? autonomy.slice(0, 1).toUpperCase()
              : `∞${autonomy.slice(0, 1).toUpperCase()}`}
          </Text>,
        ])
      : null,
    showEternalStage && eternalStage
      ? entry('eternal_stage', 'eternal_stage', p, [
          <EternalStageChip stage={eternalStage} monochrome={isNoColor} />,
        ])
      : null,
    // Seconds-level safety state: the breaker leads the posture block.
    breakerCountdown && showChip('breaker')
      ? (() => {
          const secs = Math.ceil(breakerCountdown.remainingMs / 1000);
          const color = countdownColor(secs, 20, 10);
          return entry('breaker', 'breaker', p, [
            <Text color={isNoColor ? undefined : color} bold>
              {STATUSLINE_ICONS.breaker} kill/reset in {secs}s
            </Text>,
            <Text color={isNoColor ? undefined : color} bold>
              {STATUSLINE_ICONS.breaker} {secs}s
            </Text>,
          ]);
        })()
      : null,
    tokenSavingMode !== undefined && tokenSavingMode !== 'off' && showChip('token_saving')
      ? entry('token_saving', 'token_saving', p, [
          <Text color={chipColor(theme.warn, isNoColor)} bold>
            {isNoColor ? tokenSavingMode : `${STATUSLINE_ICONS.token_saving} ${tokenSavingMode}`}
          </Text>,
          <Text color={chipColor(theme.warn, isNoColor)} bold>
            {isNoColor
              ? tokenSavingMode.slice(0, 1)
              : `${STATUSLINE_ICONS.token_saving}${tokenSavingMode.slice(0, 1).toUpperCase()}`}
          </Text>,
        ])
      : null,
    processCount != null && processCount > 0 && showChip('processes')
      ? entry('processes', 'processes', p, [
          <Text color={chipColor(theme.error, isNoColor)}>
            {STATUSLINE_ICONS.processes} {processCount}{' '}
            {processCount === 1 ? 'process' : 'processes'}
          </Text>,
          <Text color={chipColor(theme.error, isNoColor)}>
            {STATUSLINE_ICONS.processes}
            {processCount}
          </Text>,
        ])
      : null,
    sideEffectCount != null && sideEffectCount > 0 && showChip('side_effects')
      ? entry('side_effects', 'side_effects', p, [
          <Text color={chipColor(theme.warn, isNoColor)}>
            {icon(STATUSLINE_ICONS.side_effects, isNoColor)}
            {sideEffectCount} audit{sideEffectCount === 1 ? '' : 's'}
          </Text>,
          <Text color={chipColor(theme.warn, isNoColor)}>
            {icon(STATUSLINE_ICONS.side_effects, isNoColor)}
            {sideEffectCount}
          </Text>,
        ])
      : null,
    droppedTools != null && droppedTools > 0 && showChip('dropped_tools')
      ? entry('dropped_tools', 'dropped_tools', p, [
          <Text color={chipColor(theme.warn, isNoColor)}>
            {isNoColor
              ? `-${droppedTools} tools`
              : `${STATUSLINE_ICONS.dropped_tools} -${droppedTools}`}
          </Text>,
        ])
      : null,
    hasActiveGoal && goalSummary
      ? entry('goal', 'goal', p, [
          <Text
            color={
              isNoColor
                ? undefined
                : goalSummary.goalState === 'abandoned'
                  ? theme.textMuted
                  : goalSummary.goalState === 'active' || goalSummary.goalState === 'completed'
                    ? theme.success
                    : theme.warn
            }
          >
            {icon(STATUSLINE_ICONS.goal, isNoColor)}
            {truncateChip(goalSummary.goal, 40)} [{goalSummary.goalState}] (iter{' '}
            {goalSummary.iterations})
          </Text>,
          <Text color={isNoColor ? undefined : theme.success}>
            {icon(STATUSLINE_ICONS.goal, isNoColor)}
            {truncateChip(goalSummary.goal, 18)} (i{goalSummary.iterations})
          </Text>,
          <Text color={isNoColor ? undefined : theme.success}>
            {icon(STATUSLINE_ICONS.goal, isNoColor)}
            {truncateChip(goalSummary.goal, 8)}
          </Text>,
        ])
      : null,
    todos &&
    (todos.pending > 0 || todos.inProgress > 0 || (todos.completed > 0 && !todosCleared)) &&
    showChip('todos')
      ? (() => {
          const counts = (
            <>
              {todos.inProgress > 0 ? (
                <Text color={isNoColor ? undefined : theme.warn}>
                  {isNoColor ? `?${todos.inProgress}` : `${glyphs.running} ${todos.inProgress}`}
                </Text>
              ) : null}
              {todos.inProgress > 0 && (todos.pending > 0 || todos.completed > 0) ? ' ' : ''}
              {todos.pending > 0 ? (
                <Text dimColor={!isNoColor}>
                  {isNoColor ? `.${todos.pending}` : `${glyphs.pending} ${todos.pending}`}
                </Text>
              ) : null}
              {todos.pending > 0 && todos.completed > 0 ? ' ' : ''}
              {todos.completed > 0 ? (
                <Text color={isNoColor ? undefined : theme.success}>
                  {isNoColor ? `+${todos.completed}` : `${glyphs.success} ${todos.completed}`}
                </Text>
              ) : null}
            </>
          );
          return entry('todos', 'todos', p, [
            <Text>
              <Text dimColor={!isNoColor}>todos </Text>
              {counts}
            </Text>,
            <Text>{counts}</Text>,
            <Text color={isNoColor ? undefined : theme.warn}>
              {`${STATUSLINE_ICONS.todos}${todos.inProgress + todos.pending}`}
            </Text>,
          ]);
        })()
      : null,
    plan && (plan.open > 0 || plan.inProgress > 0 || plan.done > 0) && showChip('plan')
      ? (() => {
          const counts = (
            <>
              {plan.inProgress > 0 ? (
                <Text color={isNoColor ? undefined : theme.warn}>
                  {isNoColor ? `?${plan.inProgress}` : `${glyphs.running} ${plan.inProgress}`}
                </Text>
              ) : null}
              {plan.inProgress > 0 && (plan.open > 0 || plan.done > 0) ? ' ' : ''}
              {plan.open > 0 ? (
                <Text dimColor={!isNoColor}>
                  {isNoColor ? `.${plan.open}` : `${glyphs.pending} ${plan.open}`}
                </Text>
              ) : null}
              {plan.open > 0 && plan.done > 0 ? ' ' : ''}
              {plan.done > 0 ? (
                <Text color={isNoColor ? undefined : theme.success}>
                  {isNoColor ? `+${plan.done}` : `${glyphs.success} ${plan.done}`}
                </Text>
              ) : null}
            </>
          );
          const lead = (
            <Text color={isNoColor ? undefined : theme.accent}>
              {icon(STATUSLINE_ICONS.plan, isNoColor)}
            </Text>
          );
          return entry('plan', 'plan', p, [
            <Text>
              {lead}
              {counts}
              {plan.scope ? <Text dimColor={!isNoColor}> [{plan.scope}]</Text> : null}
            </Text>,
            <Text>
              {lead}
              {counts}
            </Text>,
            <Text color={isNoColor ? undefined : theme.accent}>
              {`${STATUSLINE_ICONS.plan}${plan.inProgress + plan.open}`}
            </Text>,
          ]);
        })()
      : null,
    hasTaskActivity && tasks && showChip('tasks')
      ? (() => {
          const counts = (
            <>
              {tasks.inProgress > 0 ? (
                <Text color={isNoColor ? undefined : theme.warn}>
                  {isNoColor ? `?${tasks.inProgress}` : `${glyphs.running} ${tasks.inProgress}`}
                </Text>
              ) : null}
              {tasks.inProgress > 0 && (tasks.pending > 0 || tasks.blocked > 0) ? ' ' : ''}
              {tasks.pending > 0 ? (
                <Text dimColor={!isNoColor}>
                  {isNoColor ? `.${tasks.pending}` : `${glyphs.pending} ${tasks.pending}`}
                </Text>
              ) : null}
              {tasks.pending > 0 && tasks.blocked > 0 ? ' ' : ''}
              {tasks.blocked > 0 ? (
                <Text color={isNoColor ? undefined : theme.error}>
                  {isNoColor ? `!${tasks.blocked}` : `${glyphs.warning} ${tasks.blocked}`}
                </Text>
              ) : null}
              {(tasks.pending > 0 || tasks.blocked > 0) && (tasks.completed > 0 || tasks.failed > 0)
                ? ' '
                : ''}
              {tasks.completed > 0 ? (
                <Text color={isNoColor ? undefined : theme.success}>
                  {isNoColor ? `+${tasks.completed}` : `${glyphs.success} ${tasks.completed}`}
                </Text>
              ) : null}
              {tasks.completed > 0 && tasks.failed > 0 ? ' ' : ''}
              {tasks.failed > 0 ? (
                <Text color={isNoColor ? undefined : theme.error}>
                  {isNoColor ? `x${tasks.failed}` : `${glyphs.failure} ${tasks.failed}`}
                </Text>
              ) : null}
            </>
          );
          const lead = (
            <Text color={isNoColor ? undefined : theme.monitor.agents}>
              {icon(STATUSLINE_ICONS.tasks, isNoColor)}
            </Text>
          );
          return entry('tasks', 'tasks', p, [
            <Text>
              {lead}
              {counts}
              {tasks.scope ? <Text dimColor={!isNoColor}> [{tasks.scope}]</Text> : null}
            </Text>,
            <Text>
              {lead}
              {counts}
            </Text>,
            <Text color={isNoColor ? undefined : theme.monitor.agents}>
              {`${STATUSLINE_ICONS.tasks}${tasks.inProgress + tasks.pending}`}
            </Text>,
          ]);
        })()
      : null,
  ]);
}