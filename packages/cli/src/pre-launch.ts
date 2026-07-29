// Public barrel for the pre-launch module. Implementation is split by
// concern into ./pre-launch/{project-check,launch-prompts,indexing-question}.ts.
// Consumers should keep importing from './pre-launch.js' — this file
// re-exports the public symbols so callers don't need to know about the split.

export {
  type ProjectKind,
  detectProjectKind,
  runProjectCheck,
} from './pre-launch/project-check.js';

export {
  type LaunchModeChoices,
  LaunchAbortedError,
  persistLaunchChoices,
  runLaunchPrompts,
} from './pre-launch/launch-prompts.js';

