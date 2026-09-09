import { describe, expect, it } from 'vitest';
import {
  MCP_CONSTANTS,
  negotiateProtocolVersion,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '../src/constants.js';
import { MCPServer } from '../src/server.js';

/**
 * The server used to ignore the client's requested protocolVersion entirely
 * and always answer with its own constant. A peer asking for a newer revision
 * was told it had been granted that handshake when it had not — silently, with
 * nothing in the response to reveal the mismatch.
 */
describe('MCP protocol version negotiation', () => {
  const server = new MCPServer({
    host: { listTools: () => [], callTool: async () => ({ content: '', isError: false }) },
  });

  async function initialize(protocolVersion: unknown): Promise<{ protocolVersion: string }> {
    const raw = await server.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion,
          capabilities: {},
          clientInfo: { name: 'test', version: '1' },
        },
      }),
    );
    return (JSON.parse(raw ?? '{}') as { result: { protocolVersion: string } }).result;
  }

  it('advertises the newest revision it actually implements', () => {
    expect(MCP_CONSTANTS.PROTOCOL_VERSION).toBe(SUPPORTED_PROTOCOL_VERSIONS[0]);
    expect(SUPPORTED_PROTOCOL_VERSIONS.length).toBeGreaterThan(0);
  });

  it('echoes a supported version back to the peer', async () => {
    for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
      expect(negotiateProtocolVersion(version)).toBe(version);
      await expect(initialize(version)).resolves.toMatchObject({ protocolVersion: version });
    }
  });

  it('answers an unsupported version with its own latest, not the request', async () => {
    // The peer can then decide whether it can speak this revision. Silently
    // echoing its request would claim support that does not exist.
    const result = await initialize('2099-01-01');
    expect(result.protocolVersion).toBe(MCP_CONSTANTS.PROTOCOL_VERSION);
    expect(result.protocolVersion).not.toBe('2099-01-01');
  });

  it('falls back to its own latest for a missing or malformed version', async () => {
    expect(negotiateProtocolVersion(undefined)).toBe(MCP_CONSTANTS.PROTOCOL_VERSION);
    expect(negotiateProtocolVersion(null)).toBe(MCP_CONSTANTS.PROTOCOL_VERSION);
    expect(negotiateProtocolVersion(42)).toBe(MCP_CONSTANTS.PROTOCOL_VERSION);
    await expect(initialize(undefined)).resolves.toMatchObject({
      protocolVersion: MCP_CONSTANTS.PROTOCOL_VERSION,
    });
  });
});
