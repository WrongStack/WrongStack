import { createAppKeyHandler } from '../app-key-handler.js';
import { createRunBlocksController } from '../run-blocks-controller.js';
import { createSubmitController } from '../submit-controller.js';
import { useStableKeyHandler } from './use-stable-key-handler.js';

export type KeyHandlerParams = Parameters<typeof createAppKeyHandler>[0];
export type RunBlocksParams = Parameters<typeof createRunBlocksController>[0];
export type SubmitParams = Parameters<typeof createSubmitController>[0];

export interface AppExecutionPipelineArgs {
  keyHandlerParams: KeyHandlerParams;
  runBlocksParams: RunBlocksParams;
  submitParams: SubmitParams;
  runBlocksRef: { current: ReturnType<typeof createRunBlocksController> };
  submitRef: { current: any };
}

export function useAppExecutionPipeline(args: AppExecutionPipelineArgs) {
  const { keyHandlerParams, runBlocksParams, submitParams, runBlocksRef, submitRef } = args;

  const handleKey = createAppKeyHandler(keyHandlerParams);
  const runBlocks = createRunBlocksController(runBlocksParams);
  runBlocksRef.current = runBlocks;

  const submit = createSubmitController(submitParams);
  submitRef.current = submit;

  const stableOnKey = useStableKeyHandler(handleKey);

  return { handleKey, runBlocks, submit, stableOnKey };
}
