/**
 * Regression tests for `decodeProtocolMessage` and `decodeProtocolFrame`.
 *
 * The decoder is the wire-format gate between every @wrongstack/webui-server
 * frame and the canonical message types in this package. If it silently
 * accepts an unknown type, drift between the two servers (standalone webui
 * and CLI --webui) hides until a client crashes. Pin the contract here.
 */
export {};
//# sourceMappingURL=decoder.test.d.ts.map
