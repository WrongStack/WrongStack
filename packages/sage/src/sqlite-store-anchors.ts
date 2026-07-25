import { normalizeSlashes } from './paths.js';
import type { MemoryAnchor, MemoryGraphRelation } from './types.js';

export function sqliteAnchorNode(anchor: MemoryAnchor): string | undefined {
  switch (anchor.type) {
    case 'file':
    case 'test':
    case 'git': {
      const normalizedPath = anchor.path ? normalizeSlashes(anchor.path) : undefined;
      return normalizedPath ? `file:${normalizedPath}` : undefined;
    }
    case 'directory': {
      const normalizedPath = anchor.path ? normalizeSlashes(anchor.path) : undefined;
      return normalizedPath ? `dir:${normalizedPath}` : undefined;
    }
    case 'symbol': {
      const normalizedPath = anchor.path ? normalizeSlashes(anchor.path) : undefined;
      return normalizedPath && anchor.symbol
        ? `symbol:${normalizedPath}#${anchor.symbol}`
        : undefined;
    }
    case 'package': {
      const normalizedPath = anchor.path ? normalizeSlashes(anchor.path) : undefined;
      return normalizedPath ? `dir:${normalizedPath}` : undefined;
    }
    case 'command':
      return anchor.command ? `command:${anchor.command.trim().replace(/\s+/g, ' ')}` : undefined;
    case 'agent':
      return anchor.role ? `agent:${anchor.role.trim().toLowerCase()}` : undefined;
  }
}

export function sqliteAnchorRelation(anchor: MemoryAnchor): MemoryGraphRelation | undefined {
  switch (anchor.type) {
    case 'file':
    case 'test':
    case 'git':
      return 'about_file';
    case 'directory':
      return 'about_directory';
    case 'symbol':
      return 'about_symbol';
    case 'package':
      return 'about_package';
    case 'command':
      return 'about_command';
    case 'agent':
      return 'about_agent';
  }
}
