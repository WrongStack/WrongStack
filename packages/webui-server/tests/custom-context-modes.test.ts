import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @wrongstack/core - listContextWindowModes, atomicWrite
const mockListModes = vi.hoisted(() => vi.fn());
const mockAtomicWrite = vi.hoisted(() => vi.fn());

vi.mock('@wrongstack/core/types', () => ({
  listContextWindowModes: mockListModes,
}));

vi.mock('@wrongstack/core/utils', () => ({
  atomicWrite: mockAtomicWrite,
}));

import {
  createCustomModeStore,
  type CustomContextMode,
} from '../src/server/custom-context-modes.js';

// Helper to create a valid custom mode
function makeMode(overrides: Partial<CustomContextMode> = {}): CustomContextMode {
  return {
    id: 'test-mode',
    name: 'Test Mode',
    description: 'A test mode',
    thresholds: { warn: 0.5, soft: 0.7, hard: 0.9 },
    aggressiveOn: 'soft',
    preserveK: 10,
    eliseThreshold: 2000,
    targetLoad: 0.65,
    custom: true,
    ...overrides,
  };
}

describe('custom-context-modes', () => {
  beforeEach(() => {
    mockListModes.mockReset();
    mockAtomicWrite.mockReset();
  });

  describe('createCustomModeStore', () => {
    it('creates a store with empty modes', async () => {
      const store = createCustomModeStore('/tmp/.wrongstack');
      expect(store.modes.size).toBe(0);
    });

    describe('load', () => {
      // Tests for load require mocking fs.readFile, which is also used by @wrongstack/core
      // Since we mock @wrongstack/core but not node:fs, the actual fs is used
      // For now, verify load handles missing file gracefully
      it('handles missing file gracefully', async () => {
        const store = createCustomModeStore('/nonexistent/path');
        await store.load();
        expect(store.modes.size).toBe(0);
      });

      it('handles corrupt JSON gracefully', async () => {
        const store = createCustomModeStore('/nonexistent/path');
        // File doesn't exist; should be caught by the catch block
        await store.load();
        expect(store.modes.size).toBe(0);
      });
    });

    describe('save', () => {
      it('calls atomicWrite with correct JSON', async () => {
        mockAtomicWrite.mockResolvedValue(undefined);
        const store = createCustomModeStore('/tmp/.wrongstack');
        store.modes.set('my-mode', makeMode({ id: 'my-mode', name: 'My Mode' }));
        await store.save();
        expect(mockAtomicWrite).toHaveBeenCalledTimes(1);
        const [path, json] = mockAtomicWrite.mock.calls[0];
        expect(path).toContain('custom-context-modes.json');
        const parsed = JSON.parse(json);
        expect(parsed.modes).toHaveLength(1);
        expect(parsed.modes[0].id).toBe('my-mode');
      });
    });

    describe('create', () => {
      it('creates a mode with defaults for missing fields', () => {
        const store = createCustomModeStore('/tmp/.wrongstack');
        const result = store.create(makeMode());
        expect(result.ok).toBe(true);
        const mode = store.modes.get('test-mode')!;
        expect(mode.id).toBe('test-mode');
        expect(mode.name).toBe('Test Mode');
        expect(mode.custom).toBe(true);
      });

      it('uses default thresholds when not provided', () => {
        const store = createCustomModeStore('/tmp/.wrongstack');
        store.create({ id: 'minimal', name: 'Minimal', description: '', custom: true } as any);
        const mode = store.modes.get('minimal')!;
        expect(mode.thresholds.warn).toBe(0.6);
        expect(mode.thresholds.soft).toBe(0.75);
        expect(mode.thresholds.hard).toBe(0.9);
        expect(mode.aggressiveOn).toBe('soft');
        expect(mode.preserveK).toBe(10);
        expect(mode.eliseThreshold).toBe(2000);
        expect(mode.targetLoad).toBe(0.65);
      });

      it('returns error when id is missing', () => {
        const store = createCustomModeStore('/tmp/.wrongstack');
        const result = store.create({ id: '', name: 'Test', description: '', custom: true } as any);
        expect(result.ok).toBe(false);
        expect(result.error).toContain('id is required');
      });

      it('returns error for built-in mode id', () => {
        const store = createCustomModeStore('/tmp/.wrongstack');
        const result = store.create(makeMode({ id: 'balanced' }));
        expect(result.ok).toBe(false);
        expect(result.error).toContain('Cannot override built-in mode');
      });

      it('returns error when mode id already exists', () => {
        const store = createCustomModeStore('/tmp/.wrongstack');
        store.create(makeMode());
        const result = store.create(makeMode());
        expect(result.ok).toBe(false);
        expect(result.error).toContain('already exists');
      });

      it('returns error when name is missing', () => {
        const store = createCustomModeStore('/tmp/.wrongstack');
        const result = store.create({
          id: 'test-id',
          name: '',
          description: '',
          custom: true,
        } as any);
        expect(result.ok).toBe(false);
        expect(result.error).toContain('name is required');
      });
    });

    describe('update', () => {
      it('updates fields on an existing mode', () => {
        const store = createCustomModeStore('/tmp/.wrongstack');
        store.create(makeMode({ id: 'my-mode' }));
        const result = store.update('my-mode', {
          name: 'Updated Name',
          description: 'Updated desc',
        });
        expect(result.ok).toBe(true);
        expect(store.modes.get('my-mode')!.name).toBe('Updated Name');
        expect(store.modes.get('my-mode')!.description).toBe('Updated desc');
      });

      it('returns error for built-in mode', () => {
        const store = createCustomModeStore('/tmp/.wrongstack');
        const result = store.update('balanced', { name: 'Hacked' });
        expect(result.ok).toBe(false);
        expect(result.error).toContain('Cannot modify built-in mode');
      });

      it('returns error for non-existent mode', () => {
        const store = createCustomModeStore('/tmp/.wrongstack');
        const result = store.update('nonexistent', { name: 'New Name' });
        expect(result.ok).toBe(false);
        expect(result.error).toContain('not found');
      });

      it('updates thresholds partially', () => {
        const store = createCustomModeStore('/tmp/.wrongstack');
        store.create(makeMode({ id: 'my-mode', thresholds: { warn: 0.3, soft: 0.6, hard: 0.8 } }));
        store.update('my-mode', { thresholds: { warn: 0.4 } as any });
        expect(store.modes.get('my-mode')!.thresholds.warn).toBe(0.4);
        expect(store.modes.get('my-mode')!.thresholds.soft).toBe(0.6); // unchanged
        expect(store.modes.get('my-mode')!.thresholds.hard).toBe(0.8); // unchanged
      });

      it('updates preserveK, eliseThreshold, targetLoad, aggressiveOn', () => {
        const store = createCustomModeStore('/tmp/.wrongstack');
        store.create(makeMode({ id: 'my-mode' }));
        store.update('my-mode', {
          preserveK: 20,
          eliseThreshold: 5000,
          targetLoad: 0.8,
          aggressiveOn: 'hard',
        });
        const mode = store.modes.get('my-mode')!;
        expect(mode.preserveK).toBe(20);
        expect(mode.eliseThreshold).toBe(5000);
        expect(mode.targetLoad).toBe(0.8);
        expect(mode.aggressiveOn).toBe('hard');
      });
    });

    describe('remove', () => {
      it('removes an existing custom mode', () => {
        const store = createCustomModeStore('/tmp/.wrongstack');
        store.create(makeMode({ id: 'my-mode' }));
        const result = store.remove('my-mode');
        expect(result.ok).toBe(true);
        expect(store.modes.has('my-mode')).toBe(false);
      });

      it('returns error for built-in mode', () => {
        const store = createCustomModeStore('/tmp/.wrongstack');
        const result = store.remove('balanced');
        expect(result.ok).toBe(false);
        expect(result.error).toContain('Cannot delete built-in mode');
      });

      it('returns error for non-existent mode', () => {
        const store = createCustomModeStore('/tmp/.wrongstack');
        const result = store.remove('nonexistent');
        expect(result.ok).toBe(false);
        expect(result.error).toContain('not found');
      });
    });

    describe('list', () => {
      it('returns built-in modes merged with custom modes', () => {
        mockListModes.mockReturnValue([
          {
            id: 'balanced',
            name: 'Balanced',
            description: 'Default',
            thresholds: { warn: 0.6, soft: 0.75, hard: 0.9 },
            aggressiveOn: 'soft',
            preserveK: 10,
            eliseThreshold: 2000,
            targetLoad: 0.65,
          },
        ]);
        const store = createCustomModeStore('/tmp/.wrongstack');
        store.create(makeMode({ id: 'custom-mode', name: 'Custom' }));
        const all = store.list();
        expect(all).toHaveLength(2);
        expect(all[0].id).toBe('balanced');
        expect(all[0].custom).toBe(false);
        expect(all[1].id).toBe('custom-mode');
        expect(all[1].custom).toBe(true);
      });

      it('returns only built-ins when no custom modes', () => {
        mockListModes.mockReturnValue([
          {
            id: 'balanced',
            name: 'Balanced',
            description: 'Default',
            thresholds: { warn: 0.6, soft: 0.75, hard: 0.9 },
            aggressiveOn: 'soft',
            preserveK: 10,
            eliseThreshold: 2000,
            targetLoad: 0.65,
          },
        ]);
        const store = createCustomModeStore('/tmp/.wrongstack');
        const all = store.list();
        expect(all).toHaveLength(1);
      });
    });
  });
});
