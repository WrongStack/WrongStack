/**
 * Public exports of `@wrongstack/sage-mcp`.
 *
 * The two things a host needs are:
 *   - `createSageMcpServer(port, opts)` — build an `MCPServer` over a SAGE
 *     memory port. Pass the port, hand the result to `serveStdio` /
 *     `serveHttp` from `@wrongstack/mcp`.
 *   - `createSageMcpToolHost(port, opts)` — finer-grained: build just the
 *     host if you want to compose the server differently.
 *
 * The standalone `wstack-sage-mcp` binary lives at `src/cli.ts` (the
 * `bin` entry in `package.json`); it is not re-exported here.
 */
export {
  createSageMcpServer,
  createSageMcpToolHost,
  requireSageService,
  type SageMcpToolHostOptions,
} from './adapter.js';
export {
  selectAllowedTools,
  type SageMcpAllowedTool,
  type SageMcpPolicyOptions,
} from './policy.js';
export { SERVER_INFO } from './version.js';
