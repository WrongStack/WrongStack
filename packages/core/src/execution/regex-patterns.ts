/**
 * Shared regex patterns used across execution and security-scanner.
 * Centralized here to avoid duplication and keep patterns in sync.
 */

/** Matches Node.js ECONN* errors and fetch failure messages. */
export const NETWORK_ERR_RE = /ECONN|ETIMEDOUT|ETIME|ENOTFOUND|EAI_AGAIN|fetch failed/i;
