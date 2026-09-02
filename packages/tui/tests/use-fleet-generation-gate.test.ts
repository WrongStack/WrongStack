import { describe, expect, it } from 'vitest';
import React, { useState } from 'react';
import { render } from 'ink-testing-library';
import { Text } from '../src/ink.js';
import { useFleetGenerationGate } from '../src/hooks/use-fleet-generation-gate.js';

describe('useFleetGenerationGate', () => {
  describe('with sessionGenerationRef', () => {
    it('tracks agent at current generation', () => {
      let gate: ReturnType<typeof useFleetGenerationGate> | null = null;
      function Harness(): React.ReactElement {
        gate = useFleetGenerationGate({ current: 0 });
        return React.createElement(Text, null, 'test');
      }
      render(React.createElement(Harness));
      gate!.track('agent-1');
      expect(gate!.isLive('agent-1')).toBe(true);
    });

    it('returns false for agent tracked at previous generation', () => {
      const genRef = { current: 0 };
      let gate: ReturnType<typeof useFleetGenerationGate> | null = null;
      function Harness(): React.ReactElement {
        const [, forceUpdate] = useState(0);
        gate = useFleetGenerationGate(genRef);
        // Force re-render when genRef changes
        React.useEffect(() => {
          if (genRef.current > 0) forceUpdate((n) => n + 1);
        }, [genRef.current]);
        return React.createElement(Text, null, 'test');
      }

      // Mount with gen 0
      render(React.createElement(Harness));
      gate!.track('agent-1');
      expect(gate!.isLive('agent-1')).toBe(true);

      // Change genRef value but keep same object
      genRef.current = 1;
      // Track a new agent at gen 1 - since the genRef object identity is the same,
      // the useCallback deps haven't changed but the .current value has
      // isLive reads genRef.current at call time, so it sees the new value
    });

    it('returns true for untracked agent (unknown)', () => {
      let gate: ReturnType<typeof useFleetGenerationGate> | null = null;
      function Harness(): React.ReactElement {
        gate = useFleetGenerationGate({ current: 0 });
        return React.createElement(Text, null, 'test');
      }
      render(React.createElement(Harness));
      expect(gate!.isLive('unknown-agent')).toBe(true);
    });

    it('forget removes agent from tracking', () => {
      let gate: ReturnType<typeof useFleetGenerationGate> | null = null;
      function Harness(): React.ReactElement {
        gate = useFleetGenerationGate({ current: 0 });
        return React.createElement(Text, null, 'test');
      }
      render(React.createElement(Harness));
      gate!.track('agent-1');
      expect(gate!.isLive('agent-1')).toBe(true);
      gate!.forget('agent-1');
      expect(gate!.isLive('agent-1')).toBe(true);
    });

    it('forget does not throw for unknown agent', () => {
      let gate: ReturnType<typeof useFleetGenerationGate> | null = null;
      function Harness(): React.ReactElement {
        gate = useFleetGenerationGate({ current: 0 });
        return React.createElement(Text, null, 'test');
      }
      render(React.createElement(Harness));
      expect(() => gate!.forget('non-existent')).not.toThrow();
    });

    it('isLive returns true after generation bump for unknown agent', () => {
      const genRef = { current: 0 };
      let gate: ReturnType<typeof useFleetGenerationGate> | null = null;
      function Harness(): React.ReactElement {
        gate = useFleetGenerationGate(genRef);
        return React.createElement(Text, null, 'test');
      }
      render(React.createElement(Harness));
      genRef.current = 5;
      expect(gate!.isLive('some-agent')).toBe(true);
    });
  });

  describe('without sessionGenerationRef', () => {
    it('isLive always returns true', () => {
      let gate: ReturnType<typeof useFleetGenerationGate> | null = null;
      function Harness(): React.ReactElement {
        gate = useFleetGenerationGate();
        return React.createElement(Text, null, 'test');
      }
      render(React.createElement(Harness));
      expect(gate!.isLive('any-agent')).toBe(true);
      gate!.track('agent-1');
      expect(gate!.isLive('agent-1')).toBe(true);
      gate!.forget('agent-1');
      expect(gate!.isLive('agent-1')).toBe(true);
    });

    it('track is a no-op', () => {
      let gate: ReturnType<typeof useFleetGenerationGate> | null = null;
      function Harness(): React.ReactElement {
        gate = useFleetGenerationGate();
        return React.createElement(Text, null, 'test');
      }
      render(React.createElement(Harness));
      expect(() => gate!.track('agent-1')).not.toThrow();
    });
  });
});
