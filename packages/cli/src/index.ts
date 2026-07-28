export { installBrokenPipeHandlers } from './cli-entry-point.js';
export { main } from './cli-entry-main.js';
export { CLI_VERSION } from './version.js';

import { runAsMain } from './cli-entry-point.js';
import { main } from './cli-entry-main.js';

runAsMain(main);
