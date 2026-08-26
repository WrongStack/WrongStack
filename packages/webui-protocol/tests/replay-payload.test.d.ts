/**
 * Regression tests for `buildReplayPayload`.
 *
 * Two servers (standalone webui and CLI --webui) emit this payload. The doc
 * header on `replay-payload.ts` documents a real drift incident where one
 * server fell back to in-memory conversation and the other did not, and
 * only one applied the message cap consistently. Pin the contract here so
 * a future regression to that state fails loudly in CI.
 */
export {};
//# sourceMappingURL=replay-payload.test.d.ts.map