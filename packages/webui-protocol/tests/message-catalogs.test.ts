/**
 * Regression tests for the message-type catalogs (client and server files).
 *
 * The catalogs are the wire contract between every browser surface and the
 * two servers. The decoder is only as good as these lists: a type present in
 * a catalog but missing from the registry (or vice versa) silently breaks one
 * direction at runtime. Pin the shape, uniqueness, direction routing, and
 * registry membership here so drift fails a test instead of a websocket.
 */

import { describe, expect, it } from 'vitest';
import { decodeProtocolMessage } from '../src/decoder.js';
import { CLIENT_MESSAGE_TYPES, SERVER_MESSAGE_TYPES } from '../src/registry.js';
import {
  CLIENT_COLLABORATION_MESSAGE_TYPES,
  CLIENT_CONVERSATION_MESSAGE_TYPES,
} from '../src/client-conversation.js';
import {
  CLIENT_GOAL_MESSAGE_TYPES,
  CLIENT_SDD_MESSAGE_TYPES,
} from '../src/client-operations.js';
import {
  CLIENT_CONFIGURATION_MESSAGE_TYPES,
  CLIENT_WORKSPACE_MESSAGE_TYPES,
} from '../src/client-workspace.js';
import {
  CLIENT_EXTENSION_MESSAGE_TYPES,
  CLIENT_KNOWLEDGE_MESSAGE_TYPES,
} from '../src/client-integrations.js';
import {
  SERVER_COLLABORATION_MESSAGE_TYPES,
  SERVER_CONVERSATION_MESSAGE_TYPES,
} from '../src/server-conversation.js';
import {
  SERVER_EXTENSION_MESSAGE_TYPES,
  SERVER_KNOWLEDGE_MESSAGE_TYPES,
} from '../src/server-integrations.js';
import {
  SERVER_AUTOMATION_MESSAGE_TYPES,
  SERVER_GOAL_MESSAGE_TYPES,
  SERVER_SDD_MESSAGE_TYPES,
} from '../src/server-operations.js';
import {
  SERVER_CONFIGURATION_MESSAGE_TYPES,
  SERVER_WORKSPACE_MESSAGE_TYPES,
} from '../src/server-workspace.js';

const CLIENT_CATALOGS = {
  conversation: CLIENT_CONVERSATION_MESSAGE_TYPES,
  collaboration: CLIENT_COLLABORATION_MESSAGE_TYPES,
  workspace: CLIENT_WORKSPACE_MESSAGE_TYPES,
  configuration: CLIENT_CONFIGURATION_MESSAGE_TYPES,
  goal: CLIENT_GOAL_MESSAGE_TYPES,
  sdd: CLIENT_SDD_MESSAGE_TYPES,
  knowledge: CLIENT_KNOWLEDGE_MESSAGE_TYPES,
  extension: CLIENT_EXTENSION_MESSAGE_TYPES,
} as const;

const SERVER_CATALOGS = {
  conversation: SERVER_CONVERSATION_MESSAGE_TYPES,
  collaboration: SERVER_COLLABORATION_MESSAGE_TYPES,
  workspace: SERVER_WORKSPACE_MESSAGE_TYPES,
  configuration: SERVER_CONFIGURATION_MESSAGE_TYPES,
  goal: SERVER_GOAL_MESSAGE_TYPES,
  sdd: SERVER_SDD_MESSAGE_TYPES,
  automation: SERVER_AUTOMATION_MESSAGE_TYPES,
  knowledge: SERVER_KNOWLEDGE_MESSAGE_TYPES,
  extension: SERVER_EXTENSION_MESSAGE_TYPES,
} as const;

function assertCatalogShape(types: readonly string[]): void {
  expect(types.length).toBeGreaterThan(0);
  for (const type of types) {
    expect(typeof type).toBe('string');
    expect(type.length).toBeGreaterThan(0);
    // Dotted namespaces are the norm, but base verbs exist (abort, ping,
    // error), segments mix snake_case and camelCase (user_message, killAll),
    // and namespaces may carry hyphens (goal-state.updated).
    expect(type).toMatch(/^[a-zA-Z][a-zA-Z0-9_-]*(?:\.[a-zA-Z0-9_-]+)*$/u);
  }
  expect(new Set(types).size).toBe(types.length);
}

// The decoder accepts kanban.*/agent-roster.* extension types in both
// directions regardless of catalog registration (registry.ts escape hatch).
function isExtensionType(type: string): boolean {
  return (
    (type.startsWith('kanban.') && type.length > 'kanban.'.length) ||
    (type.startsWith('agent-roster.') && type.length > 'agent-roster.'.length)
  );
}

describe('client message catalogs', () => {
  it('are non-empty, dotted, and duplicate-free', () => {
    for (const [name, types] of Object.entries(CLIENT_CATALOGS)) {
      expect(types, `catalog ${name}`).toBeDefined();
      assertCatalogShape(types);
    }
  });

  it('has no type registered in two client domains', () => {
    const seen = new Map<string, string>();
    for (const [name, types] of Object.entries(CLIENT_CATALOGS)) {
      for (const type of types) {
        expect(seen.has(type), `${type} duplicated in ${name} and ${seen.get(type)}`).toBe(false);
        seen.set(type, name);
      }
    }
  });

  it('decodes every client type with the client direction', () => {
    for (const types of Object.values(CLIENT_CATALOGS)) {
      for (const type of types) {
        expect(decodeProtocolMessage({ type }, 'client').ok, type).toBe(true);
      }
    }
  });

  it('mirrors cross-direction acceptance to the server registry plus extension prefixes', () => {
    for (const types of Object.values(CLIENT_CATALOGS)) {
      for (const type of types) {
        // Dual-registered types (e.g. context.debug) decode in both
        // directions; extension prefixes are accepted everywhere; anything
        // else stays client-only. Server direction requires a payload, so
        // decode with an empty one to isolate registration.
        const expected =
          (SERVER_MESSAGE_TYPES as readonly string[]).includes(type) || isExtensionType(type);
        const cross = decodeProtocolMessage({ type, payload: {} }, 'server');
        expect(cross.ok, type).toBe(expected);
      }
    }
  });

  it('is fully contained in the client registry union', () => {
    for (const types of Object.values(CLIENT_CATALOGS)) {
      for (const type of types) {
        expect(CLIENT_MESSAGE_TYPES).toContain(type);
      }
    }
  });
});

describe('server message catalogs', () => {
  it('are non-empty, dotted, and duplicate-free', () => {
    for (const [name, types] of Object.entries(SERVER_CATALOGS)) {
      expect(types, `catalog ${name}`).toBeDefined();
      assertCatalogShape(types);
    }
  });

  it('has no type registered in two server domains', () => {
    const seen = new Map<string, string>();
    for (const [name, types] of Object.entries(SERVER_CATALOGS)) {
      for (const type of types) {
        expect(seen.has(type), `${type} duplicated in ${name} and ${seen.get(type)}`).toBe(false);
        seen.set(type, name);
      }
    }
  });

  it('decodes every server type with the server direction (payload required)', () => {
    for (const types of Object.values(SERVER_CATALOGS)) {
      for (const type of types) {
        expect(decodeProtocolMessage({ type, payload: {} }, 'server').ok, type).toBe(true);
      }
    }
  });

  it('mirrors cross-direction acceptance to the client registry plus extension prefixes', () => {
    for (const types of Object.values(SERVER_CATALOGS)) {
      for (const type of types) {
        // e.g. kanban.task.activity rides the extension-prefix escape hatch.
        const expected =
          (CLIENT_MESSAGE_TYPES as readonly string[]).includes(type) || isExtensionType(type);
        const cross = decodeProtocolMessage({ type }, 'client');
        expect(cross.ok, type).toBe(expected);
      }
    }
  });

  it('is fully contained in the server registry union', () => {
    for (const types of Object.values(SERVER_CATALOGS)) {
      for (const type of types) {
        expect(SERVER_MESSAGE_TYPES).toContain(type);
      }
    }
  });
});
