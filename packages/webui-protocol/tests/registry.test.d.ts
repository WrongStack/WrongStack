/**
 * Regression tests for the message-type registry.
 *
 * The registry is the source of truth for which wire types each direction
 * (client / server) accepts. The decoder delegates to `isRegisteredMessageType`
 * for unknown-type rejection — if a type is missing here, the decoder
 * silently drops the frame. Pin coverage here so additions to the per-domain
 * `*_MESSAGE_TYPES` arrays stay in sync.
 */
export {};
//# sourceMappingURL=registry.test.d.ts.map
