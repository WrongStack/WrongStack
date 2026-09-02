/** HQ browser auth — the single import surface for credentials and sessions. */
export {
  exchangeBootstrapIfNeeded,
  type HqTokenLoginResult,
  loginWithHqToken,
  upgradeStoredTokenToCookie,
} from './session.js';
export {
  authHeaders,
  clearHqToken,
  HQ_TOKEN_STORAGE_KEY,
  normalizeHqTokenInput,
  readStoredToken,
  resolveHqToken,
  scrubTokenFromUrl,
  setHqToken,
} from './token-storage.js';
