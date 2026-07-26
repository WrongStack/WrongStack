import type { SubagentConfig } from '../../types/multi-agent.js';
import type { Tool } from '../../types/tool.js';
import type { Director } from '../director.js';
import {
  makeAskResultTool,
  makeAskTool,
  makeAssignTool,
  makeAwaitTasksTool,
  makeCollabDebugTool,
  makeFleetEmitTool,
  makeFleetTool,
  makeKanbanQueueTool,
  makeQualityGateTool,
  makeRollUpTool,
  makeSpawnTool,
  makeTerminateAllTool,
  makeTerminateTool,
  makeWorkCompleteTool,
} from '../director-tools.js';

export function buildDirectorToolset(
  director: Director,
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
    makeTerminateTool(director),
    makeTerminateAllTool(director),
    makeFleetTool(director),
    makeCollabDebugTool(director),
    makeFleetEmitTool(director),
    makeWorkCompleteTool(director),
  ];
}
