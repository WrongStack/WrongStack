/**
 * HQ command controller. Lives in `@wrongstack/runtime/hq-host` so the standalone engine
 * behind WebUI/desktop dispatches HQ commands through the same controller.
 *
 * @module hq-command-controller
 */
export {
  createHqCommandDispatcher,
  createProjectKanbanAssignHandler,
  createProjectKanbanTransitionHandler,
  type HqCommandController,
} from '@wrongstack/runtime/hq-host';
