import type { ProtocolEnvelope } from '@wrongstack/webui-protocol';
import type { SessionState } from '../session-state';

/**
 * One frame type's state transition. `p` is the already-coerced payload record
 * and the session-id guard has run, so reducers only see frames for the active
 * session (or session-agnostic catalog frames).
 */
export type FrameReducer = (
  state: SessionState,
  p: Record<string, unknown>,
  frame: ProtocolEnvelope,
) => SessionState;

export type FrameReducerTable = Readonly<Record<string, FrameReducer>>;

/** Prototype-safe lookup: frame types like `constructor` never resolve. */
export function frameReducer(table: FrameReducerTable, type: string): FrameReducer | undefined {
  return Object.hasOwn(table, type) ? table[type] : undefined;
}
