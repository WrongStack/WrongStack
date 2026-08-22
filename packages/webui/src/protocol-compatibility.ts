import type {
  CanonicalClientMessageType,
  CanonicalServerMessageType,
} from '@wrongstack/webui-protocol';
import type { WSClientMessageCore, WSServerMessage } from './types.js';

type AssertNever<T extends never> = T;

/**
 * Compile-time bridge while payload-rich surface types remain in this package.
 * A newly added detailed message cannot compile until the canonical runtime
 * registry represents its wire name in the matching direction.
 */
export type UnregisteredClientSurfaceMessage = AssertNever<
  Exclude<WSClientMessageCore['type'], CanonicalClientMessageType>
>;

export type UnregisteredServerSurfaceMessage = AssertNever<
  Exclude<WSServerMessage['type'], CanonicalServerMessageType>
>;
