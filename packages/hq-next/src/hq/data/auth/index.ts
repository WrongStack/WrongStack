/** HQ browser auth — the single import surface for credentials and sessions. */
export {
  exchangeBootstrapIfNeeded,
  fetchHqCredentialCapabilities,
  hasAuthenticatedHqBrowserSession,
  loginWithHqToken,
  upgradeStoredTokenToCookie,
} from './session.js';
export {
  authHeaders,
  clearHqToken,
  HQ_TOKEN_STORAGE_KEY,
  normalizeHqTokenInput,
  resolveHqToken,
  scrubTokenFromUrl,
  setHqToken,
} from './token-storage.js';
