export { main } from './cli-entry-main.js';
export { installBrokenPipeHandlers } from './cli-entry-point.js';
export { CLI_VERSION } from './version.js';

import { main } from './cli-entry-main.js';
import { runAsMain } from './cli-entry-point.js';

runAsMain(main);
