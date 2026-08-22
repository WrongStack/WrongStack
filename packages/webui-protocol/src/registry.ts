import {
  CLIENT_COLLABORATION_MESSAGE_TYPES,
  CLIENT_CONVERSATION_MESSAGE_TYPES,
} from './client-conversation.js';
import {
  CLIENT_EXTENSION_MESSAGE_TYPES,
  CLIENT_KNOWLEDGE_MESSAGE_TYPES,
} from './client-integrations.js';
import { CLIENT_GOAL_MESSAGE_TYPES, CLIENT_SDD_MESSAGE_TYPES } from './client-operations.js';
import {
  CLIENT_CONFIGURATION_MESSAGE_TYPES,
  CLIENT_WORKSPACE_MESSAGE_TYPES,
} from './client-workspace.js';
import {
  SERVER_COLLABORATION_MESSAGE_TYPES,
  SERVER_CONVERSATION_MESSAGE_TYPES,
} from './server-conversation.js';
import {
  SERVER_EXTENSION_MESSAGE_TYPES,
  SERVER_KNOWLEDGE_MESSAGE_TYPES,
} from './server-integrations.js';
import {
  SERVER_AUTOMATION_MESSAGE_TYPES,
  SERVER_GOAL_MESSAGE_TYPES,
  SERVER_SDD_MESSAGE_TYPES,
} from './server-operations.js';
import {
  SERVER_CONFIGURATION_MESSAGE_TYPES,
  SERVER_WORKSPACE_MESSAGE_TYPES,
} from './server-workspace.js';

export const CLIENT_MESSAGE_TYPES = [
  ...CLIENT_CONVERSATION_MESSAGE_TYPES,
  ...CLIENT_COLLABORATION_MESSAGE_TYPES,
  ...CLIENT_WORKSPACE_MESSAGE_TYPES,
  ...CLIENT_CONFIGURATION_MESSAGE_TYPES,
  ...CLIENT_GOAL_MESSAGE_TYPES,
  ...CLIENT_SDD_MESSAGE_TYPES,
  ...CLIENT_KNOWLEDGE_MESSAGE_TYPES,
  ...CLIENT_EXTENSION_MESSAGE_TYPES,
] as const;

export const SERVER_MESSAGE_TYPES = [
  ...SERVER_CONVERSATION_MESSAGE_TYPES,
  ...SERVER_COLLABORATION_MESSAGE_TYPES,
  ...SERVER_WORKSPACE_MESSAGE_TYPES,
  ...SERVER_CONFIGURATION_MESSAGE_TYPES,
  ...SERVER_GOAL_MESSAGE_TYPES,
  ...SERVER_SDD_MESSAGE_TYPES,
  ...SERVER_AUTOMATION_MESSAGE_TYPES,
  ...SERVER_KNOWLEDGE_MESSAGE_TYPES,
  ...SERVER_EXTENSION_MESSAGE_TYPES,
] as const;

export type ExactClientMessageType = (typeof CLIENT_MESSAGE_TYPES)[number];
export type ExactServerMessageType = (typeof SERVER_MESSAGE_TYPES)[number];

const CLIENT_TYPE_SET: ReadonlySet<string> = new Set(CLIENT_MESSAGE_TYPES);
const SERVER_TYPE_SET: ReadonlySet<string> = new Set(SERVER_MESSAGE_TYPES);

export function isRegisteredMessageType(type: string, direction: 'client' | 'server'): boolean {
  const exact = direction === 'client' ? CLIENT_TYPE_SET : SERVER_TYPE_SET;
  return (
    exact.has(type) ||
    (type.startsWith('kanban.') && type.length > 'kanban.'.length) ||
    (type.startsWith('agent-roster.') && type.length > 'agent-roster.'.length)
  );
}
