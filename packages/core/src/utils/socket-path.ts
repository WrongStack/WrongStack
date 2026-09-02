/**
 * Re-export of the Unix socket path-length helpers from
 * `@wrongstack/persistence` so packages that depend on core (tools, sage)
 * share one implementation with packages that depend on persistence directly
 * (kanban). See `packages/persistence/src/socket-path.ts` for rationale.
 */
export {
  assertUnixSocketPathWithinLimit,
  checkUnixSocketPath,
  unixSocketPathLimit,
} from '@wrongstack/persistence';
