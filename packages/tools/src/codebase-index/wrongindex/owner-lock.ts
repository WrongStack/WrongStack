export type {
  WrongIndexOwnerInfo,
  WrongIndexWriteDelegation,
} from '@wrongstack/codebase/wrongindex/owner-lock';
export {
  IndexOwnedExternallyError,
  isOwnedByWrongIndex,
  isWrongIndexWriteBlocked,
  OWNER_INFO_FILE,
  OWNER_LOCK_FILE,
  readWrongIndexOwner,
  withWrongIndexWriteDelegation,
} from '@wrongstack/codebase/wrongindex/owner-lock';
