import { describe, expect, it } from 'vitest';
import { deferSubprocessIntegration } from '../../../../scripts/vitest-test-order.js';

describe('Bun subprocess integration scheduling', () => {
  it('defers deadline-sensitive files while preserving every specification and the other order', () => {
    const git = { moduleId: 'D:\\repo\\packages\\webui-server\\tests\\git-handlers.test.ts' };
    const first = { moduleId: '/repo/packages/core/tests/one.test.ts' };
    const heartbeat = { moduleId: '/repo/packages/tools/tests/project-server-idle.test.ts' };
    const second = { moduleId: '/repo/packages/tools/tests/other.test.ts' };
    const tui = { moduleId: 'packages/tui/tests/git-info.test.ts' };
    const input = [git, first, heartbeat, second, tui];
    expect(deferSubprocessIntegration(input)).toEqual([first, second, git, heartbeat, tui]);
    expect(input).toEqual([git, first, heartbeat, second, tui]);
  });

  it('leaves unrelated files in their existing order', () => {
    const input = [
      { moduleId: '/repo/packages/core/tests/git-handlers.test.ts' },
      { moduleId: '/repo/packages/tools/tests/bash-timeout-hermetic.test.ts' },
    ];
    expect(deferSubprocessIntegration(input)).toEqual(input);
  });
});
