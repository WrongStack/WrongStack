// The UserPromptSubmit middleware and the SessionStart/Stop extension live in
// `@wrongstack/runtime/plugin-host`, shared with the standalone WebUI host (the
// desktop engine). Re-exported here for existing CLI importers.
export {
  createLifecycleHooksExtension,
  createUserPromptSubmitMiddleware,
  HookBlockedError,
} from '@wrongstack/runtime/plugin-host';
