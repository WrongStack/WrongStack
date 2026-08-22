export type ProtocolDirection = 'client' | 'server';

export interface ProtocolEnvelope<TType extends string = string> {
  type: TType;
  payload?: unknown | undefined;
}

export type CanonicalClientMessage = ProtocolEnvelope<CanonicalClientMessageType>;
export type CanonicalServerMessage = ProtocolEnvelope<CanonicalServerMessageType> & {
  payload: unknown;
};

export type CanonicalClientMessageType =
  | import('./registry.js').ExactClientMessageType
  | `kanban.${string}`
  | `agent-roster.${string}`;

export type CanonicalServerMessageType =
  | import('./registry.js').ExactServerMessageType
  | `kanban.${string}`
  | `agent-roster.${string}`;

export interface ProtocolDecodeIssue {
  code: 'invalid_envelope' | 'invalid_type' | 'unknown_type' | 'unsafe_key' | 'too_deep';
  message: string;
  path?: string | undefined;
}

export type ProtocolDecodeResult<TMessage extends ProtocolEnvelope> =
  | { ok: true; message: TMessage }
  | { ok: false; issue: ProtocolDecodeIssue };
