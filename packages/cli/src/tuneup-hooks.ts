import * as path from 'node:path';
import type { TuneupHooks } from '@wrongstack/runtime/commands';
import { diagnoseConfig } from './config-doctor.js';
import { appendHistory } from './config-history.js';
import { checkForUpdate } from './update-check.js';

/** /tuneup's view of the CLI: its version check, config doctor and config history. */
export const cliTuneupHooks: TuneupHooks = {
  checkForUpdate: () => checkForUpdate(),
  countConfigIssues: (config) => diagnoseConfig(config).findings.length,
  appendConfigHistory: (before, after, reason, file) =>
    appendHistory(before, after, reason, () => path.dirname(path.dirname(file)), file),
};
