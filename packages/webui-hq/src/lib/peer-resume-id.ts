/**
 * Re-export of the canonical `HQ_BROWSER_PEER_RESUME_CLIENT_ID` from
 * `@wrongstack/core/hq/protocol`. The constant lives next to the peer-lifecycle
 * protocol types it gates (`peer.rehydrate` / `peer.lost`); this file
 * remains as a backward-compat shim so existing webui-hq imports keep
 * working. New code should import directly from `@wrongstack/core/hq/protocol`.
 */
export { HQ_BROWSER_PEER_RESUME_CLIENT_ID } from '@wrongstack/core/hq/protocol';
