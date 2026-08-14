export {
  authorizeAuthAdmin,
  callerCanAdministerAuth,
  HQ_AUTH_ADMIN_CAPABILITY,
  isLoopbackRequest,
  writeAuthAdminRequired,
  type ApplyHqAuthFile,
} from './auth/common.js';

export {
  handleApiAuthStatus,
  handleApiLogin,
  handleApiLogout,
  handleApiPassword,
} from './auth/password-routes.js';

export {
  handleApiLoginVerify,
  handleApiTotpDisable,
  handleApiTotpEnable,
  handleApiTotpSetup,
} from './auth/totp-routes.js';

export {
  handleApiBootstrap,
  handleApiTokenUpgrade,
} from './auth/bootstrap-routes.js';

export {
  handleApiAuthAudit,
  handleApiAuthSessions,
  handleApiAuthSessionsRevoke,
} from './auth/session-audit-routes.js';
