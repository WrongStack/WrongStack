import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

interface NodePtyLoaderLogger {
  debug?: (message: string) => void;
}

export function createNodePtyLoader(
  importMetaUrl: string,
  logger: NodePtyLoaderLogger,
): () => unknown {
  const requireFromCli = createRequire(importMetaUrl);
  let cachedNodePty: unknown;

  return () => {
    if (cachedNodePty !== undefined) return cachedNodePty;
    // Strategy 1: resolve webui via its main export, then walk to package.json.
    try {
      const webuiEntry = requireFromCli.resolve('@wrongstack/webui');
      const webuiDir = webuiEntry.replace(/[\\/]dist.*$/, '');
      const webuiPkgJson = path.join(webuiDir, 'package.json');
      cachedNodePty = createRequire(webuiPkgJson)('node-pty');
      if (cachedNodePty) {
        logger.debug?.(`[terminal] node-pty loaded via webui package (${webuiDir})`);
        return cachedNodePty;
      }
    } catch (err) {
      logger.debug?.(`[terminal] webui-route failed: ${(err as Error).message}`);
    }
    // Strategy 2: direct require from CLI's own resolution root.
    try {
      cachedNodePty = requireFromCli('node-pty');
      logger.debug?.('[terminal] node-pty loaded via direct requireFromCli');
      return cachedNodePty;
    } catch (err) {
      logger.debug?.(`[terminal] direct require failed: ${(err as Error).message}`);
    }
    // Strategy 3: workspace root node_modules/node-pty.
    try {
      const cliPkgJson = path.join(
        path.dirname(fileURLToPath(importMetaUrl)),
        '..',
        'package.json',
      );
      let dir = path.dirname(cliPkgJson);
      for (let i = 0; i < 6; i++) {
        const candidate = path.join(dir, 'node_modules', 'node-pty');
        if (existsSync(candidate)) {
          cachedNodePty = createRequire(candidate)('node-pty');
          if (cachedNodePty) {
            logger.debug?.(`[terminal] node-pty loaded via workspace root (${candidate})`);
            return cachedNodePty;
          }
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    } catch (err) {
      logger.debug?.(`[terminal] workspace-root walk failed: ${(err as Error).message}`);
    }
    cachedNodePty = null;
    logger.debug?.(
      '[terminal] node-pty resolution failed; terminal panel will report "unavailable"',
    );
    return cachedNodePty;
  };
}
