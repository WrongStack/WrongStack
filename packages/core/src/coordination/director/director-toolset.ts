import type { SubagentConfig } from '../../types/multi-agent.js';
import type { Tool } from '../../types/tool.js';
import {
  makeAskResultTool,
  makeAskTool,
  makeAssignTool,
  makeAwaitTasksTool,
  makeCollabDebugTool,
  makeFleetEmitTool,
  makeFleetTool,
  makeKanbanQueueTool,
  makeMutationTestTool,
  makeQualityGateTool,
  makeRollUpTool,
  makeSpawnTool,
  makeTerminateAllTool,
  makeTerminateTool,
  makeWorkCompleteTool,
} from '../director-tools.js';

type DirectorToolsetHost = Parameters<typeof makeSpawnTool>[0] &
  Parameters<typeof makeAssignTool>[0] &
  Parameters<typeof makeKanbanQueueTool>[0] &
  Parameters<typeof makeAwaitTasksTool>[0] &
  Parameters<typeof makeAskTool>[0] &
  Parameters<typeof makeAskResultTool>[0] &
  Parameters<typeof makeRollUpTool>[0] &
  Parameters<typeof makeQualityGateTool>[0] &
  Parameters<typeof makeMutationTestTool>[0] &
  Parameters<typeof makeTerminateTool>[0] &
  Parameters<typeof makeTerminateAllTool>[0] &
  Parameters<typeof makeFleetTool>[0] &
  Parameters<typeof makeCollabDebugTool>[0] &
  Parameters<typeof makeFleetEmitTool>[0] &
  Parameters<typeof makeWorkCompleteTool>[0];

export function buildDirectorToolset(
  director: DirectorToolsetHost,
  roster?: Record<string, SubagentConfig>,
): Tool[] {
  return [
    makeSpawnTool(director, roster),
    makeAssignTool(director),
    makeKanbanQueueTool(director, roster),
    makeAwaitTasksTool(director),
    makeAskTool(director),
    makeAskResultTool(director),
    makeRollUpTool(director),
    makeQualityGateTool(director, roster),
    makeMutationTestTool(director, roster),
    makeTerminateTool(director),
    makeTerminateAllTool(director),
    makeFleetTool(director),
    makeCollabDebugTool(director),
    makeFleetEmitTool(director),
    makeWorkCompleteTool(director),
  ];
}
