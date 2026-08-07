import { describe, expect, it } from 'vitest';
import { FLEET_ROSTER } from '../../src/coordination/fleet.js';

describe('DevOps dynamic MCP capability', () => {
  it('uses the stable MCP gateway instead of server-specific tools', () => {
    const tools = FLEET_ROSTER.devops?.tools ?? [];
    expect(tools).toContain('mcp_use');
    expect(tools.some((name) => name.startsWith('mcp__'))).toBe(false);
    expect(FLEET_ROSTER.devops?.capabilities).toContain('mcp.dynamic');
  });

  it('does not grant MCP lifecycle administration to DevOps by default', () => {
    const tools = FLEET_ROSTER.devops?.tools ?? [];

    expect(tools).not.toContain('mcp_control');
  });
});
