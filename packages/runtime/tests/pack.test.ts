import type { SlashCommand, Tool } from '@wrongstack/contracts/types';
import type { AgentExtension } from '@wrongstack/core/extension';
import type { PluginAPI } from '@wrongstack/core/plugin';
import type { ProviderFactory } from '@wrongstack/core/registry';
import { describe, expect, it } from 'vitest';
import type { WrongStackPack } from '../src/pack.js';

/**
 * These tests verify the WrongStackPack interface structure and ensure
 * that valid pack objects can be constructed matching the interface.
 */
describe('WrongStackPack interface', () => {
  describe('interface structure', () => {
    it('requires name to be a string', () => {
      const pack: WrongStackPack = { name: 'test-pack' };
      expect(pack.name).toBe('test-pack');
    });

    it('allows optional description', () => {
      const pack: WrongStackPack = { name: 'test-pack', description: 'A test pack' };
      expect(pack.description).toBe('A test pack');
    });

    it('allows optional tools array', () => {
      const mockTool = {
        id: 'tool-1',
        name: 'TestTool',
        description: 'A test tool',
        execute: async () => ({ result: 'ok' }),
      } as never as Tool;
      const pack: WrongStackPack = { name: 'test-pack', tools: [mockTool] };
      expect(pack.tools).toHaveLength(1);
      expect(pack.tools?.[0].name).toBe('TestTool');
    });

    it('allows optional providers array', () => {
      const mockProvider = {
        providerId: 'test-provider',
        create: async () => ({}),
      } as never as ProviderFactory;
      const pack: WrongStackPack = { name: 'test-pack', providers: [mockProvider] };
      expect(pack.providers).toHaveLength(1);
    });

    it('allows optional slashCommands array', () => {
      const mockCommand = {
        name: 'test-cmd',
        description: 'A test command',
        execute: async () => {},
      } as never as SlashCommand;
      const pack: WrongStackPack = { name: 'test-pack', slashCommands: [mockCommand] };
      expect(pack.slashCommands).toHaveLength(1);
    });

    it('allows optional extensions array', () => {
      const mockExtension = {
        name: 'test-ext',
        onAgentStart: async () => {},
      } as never as AgentExtension;
      const pack: WrongStackPack = { name: 'test-pack', extensions: [mockExtension] };
      expect(pack.extensions).toHaveLength(1);
    });

    it('allows optional setup function', () => {
      const setupFn = async (_api: PluginAPI) => {
        /* noop */
      };
      const pack: WrongStackPack = { name: 'test-pack', setup: setupFn };
      expect(typeof pack.setup).toBe('function');
    });

    it('allows optional teardown function', () => {
      const teardownFn = async (_api: PluginAPI) => {
        /* noop */
      };
      const pack: WrongStackPack = { name: 'test-pack', teardown: teardownFn };
      expect(typeof pack.teardown).toBe('function');
    });
  });

  describe('full valid pack construction', () => {
    it('constructs a complete pack with all optional fields', () => {
      const mockTool = {
        id: 'tool-1',
        name: 'TestTool',
        description: 'A test tool',
        execute: async () => ({ result: 'ok' }),
      } as never as Tool;
      const mockProvider = {
        providerId: 'test-provider',
        create: async () => ({}),
      } as never as ProviderFactory;
      const mockCommand = {
        name: 'test-cmd',
        description: 'A test command',
        execute: async () => {},
      } as never as SlashCommand;
      const mockExtension = {
        name: 'test-ext',
        onAgentStart: async () => {},
      } as never as AgentExtension;

      const setupFn = async (_api: PluginAPI) => {
        /* noop */
      };
      const teardownFn = async (_api: PluginAPI) => {
        /* noop */
      };

      const pack: WrongStackPack = {
        name: 'complete-pack',
        description: 'A pack with all fields',
        tools: [mockTool],
        providers: [mockProvider],
        slashCommands: [mockCommand],
        extensions: [mockExtension],
        setup: setupFn,
        teardown: teardownFn,
      };

      expect(pack.name).toBe('complete-pack');
      expect(pack.description).toBe('A pack with all fields');
      expect(pack.tools).toHaveLength(1);
      expect(pack.providers).toHaveLength(1);
      expect(pack.slashCommands).toHaveLength(1);
      expect(pack.extensions).toHaveLength(1);
      expect(pack.setup).toBe(setupFn);
      expect(pack.teardown).toBe(teardownFn);
    });

    it('constructs a minimal pack with only required fields', () => {
      const pack: WrongStackPack = { name: 'minimal-pack' };
      expect(pack.name).toBe('minimal-pack');
      expect(pack.description).toBeUndefined();
      expect(pack.tools).toBeUndefined();
      expect(pack.providers).toBeUndefined();
      expect(pack.slashCommands).toBeUndefined();
      expect(pack.extensions).toBeUndefined();
      expect(pack.setup).toBeUndefined();
      expect(pack.teardown).toBeUndefined();
    });
  });

  describe('readonly array fields', () => {
    it('tools field is readonly', () => {
      const mockTool = {
        id: 'tool-1',
        name: 'TestTool',
        description: 'A test tool',
        execute: async () => ({ result: 'ok' }),
      } as never as Tool;
      const pack: WrongStackPack = { name: 'test-pack', tools: Object.freeze([mockTool]) };
      expect(Array.isArray(pack.tools)).toBe(true);
      expect(Object.isFrozen(pack.tools)).toBe(true);
    });

    it('providers field is readonly', () => {
      const mockProvider = {
        providerId: 'test-provider',
        create: async () => ({}),
      } as never as ProviderFactory;
      const pack: WrongStackPack = { name: 'test-pack', providers: Object.freeze([mockProvider]) };
      expect(Array.isArray(pack.providers)).toBe(true);
      expect(Object.isFrozen(pack.providers)).toBe(true);
    });
  });
});
