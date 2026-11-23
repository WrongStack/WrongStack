// Standalone Codebase MCP and its project daemon.
import assetPackPath from '../../artifacts/codebase-mcp/.stage/assets.pack' with { type: 'file' };
import { startStandalone } from './runtime.mjs';

await startStandalone(assetPackPath, {
  async runMain() {
    const { runCodebaseIndexMcpServer } = await import(
      '../../packages/codebase-index-mcp/dist/index.js'
    );
    process.exitCode = await runCodebaseIndexMcpServer();
  },
  async runDaemon(name) {
    if (name !== 'codebase-index') {
      process.stderr.write(`wstack-codebase-index-mcp: unknown daemon "${name ?? ''}"\n`);
      process.exitCode = 2;
      return;
    }
    await import('../../packages/codebase/dist/project-server.js');
  },
});
