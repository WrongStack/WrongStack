import {
  ChronicleProjectServerClient,
  createChronicleProjectAccess,
  resolveChronicleProjectServerOptions,
} from '@wrongstack/chronicle';
import {
  isMailboxProjectServerAvailable,
  MailboxProjectServerConnection,
} from '@wrongstack/coordination';
import {
  assertDaemonRuntimeVersion,
  resolveWstackPaths,
  toErrorMessage,
} from '@wrongstack/core/utils';
import {
  isSageProjectServerAvailable,
  SageProjectServerConnection,
  wrongMemoryServiceActionRefusal,
} from '@wrongstack/sage';
import {
  checkCodebaseIndexServerHealth,
  ensureCodebaseIndexServer,
  shutdownCodebaseIndexServer,
} from '@wrongstack/tools';
import { isEndpointAlive, waitForShutdown } from './helpers.js';
import type { ServiceActionResult } from './types.js';

export async function killSageServer(
  projectRoot: string,
  action: 'shutdown' | 'restart',
): Promise<ServiceActionResult> {
  const servedByWrongMemory = wrongMemoryServiceActionRefusal(projectRoot);
  if (servedByWrongMemory) {
    return { serviceId: 'sage', action, success: false, message: servedByWrongMemory };
  }
  if (!isSageProjectServerAvailable()) {
    return {
      serviceId: 'sage',
      action,
      success: false,
      message: 'SAGE project server is unavailable in this runtime',
    };
  }
  const connection = new SageProjectServerConnection(projectRoot);
  try {
    const result = await connection.shutdown(`WebUI request: ${action}`);
    if (!result.stopped) {
      if (action === 'restart' && result.reason === 'not-running') {
        return await restartSageServer(projectRoot);
      }
      return {
        serviceId: 'sage',
        action,
        success: false,
        message: `SAGE memory server shutdown failed: ${result.reason ?? 'unknown'}`,
      };
    }
    if (action === 'restart') {
      return await restartSageServer(projectRoot);
    }
    return {
      serviceId: 'sage',
      action,
      success: true,
      message: 'SAGE memory server shutdown requested',
    };
  } catch (error) {
    return {
      serviceId: 'sage',
      action,
      success: false,
      message: toErrorMessage(error),
    };
  } finally {
    connection.close();
  }
}

async function restartSageServer(projectRoot: string): Promise<ServiceActionResult> {
  await waitForShutdown(async () => {
    const probe = new SageProjectServerConnection(projectRoot);
    try {
      return (await probe.status()) !== null;
    } finally {
      probe.close();
    }
  });
  const verifyConn = new SageProjectServerConnection(projectRoot);
  try {
    const health = await verifyConn.call(
      'ping',
      {},
      { timeoutMs: 10_000, meta: { clientId: `sage-restart-${process.pid}` } },
    );
    assertDaemonRuntimeVersion(health.runtimeVersion);
    return {
      serviceId: 'sage',
      action: 'restart',
      success: true,
      message: 'SAGE memory server restarted successfully',
    };
  } catch (error) {
    return {
      serviceId: 'sage',
      action: 'restart',
      success: false,
      message: `SAGE memory server restarted but verification failed: ${toErrorMessage(error)}`,
    };
  } finally {
    verifyConn.close();
  }
}

export async function killChronicleServer(
  projectRoot: string,
  action: 'shutdown' | 'restart',
): Promise<ServiceActionResult> {
  const options = resolveChronicleProjectServerOptions({ projectRoot });
  const client = new ChronicleProjectServerClient(options);
  try {
    const result = await client.shutdown(`WebUI request: ${action}`);
    if (!result.stopped) {
      if (action === 'restart' && result.reason === 'offline') {
        return await restartChronicleServer(projectRoot);
      }
      return {
        serviceId: 'chronicle',
        action,
        success: false,
        message: `Chronicle telemetry server shutdown failed: ${result.reason ?? 'unknown'}`,
      };
    }
    if (action === 'restart') {
      return await restartChronicleServer(projectRoot);
    }
    return {
      serviceId: 'chronicle',
      action,
      success: true,
      message: 'Chronicle telemetry server shutdown requested',
    };
  } catch (error) {
    return {
      serviceId: 'chronicle',
      action,
      success: false,
      message: toErrorMessage(error),
    };
  } finally {
    client.close();
  }
}

async function restartChronicleServer(projectRoot: string): Promise<ServiceActionResult> {
  const options = resolveChronicleProjectServerOptions({ projectRoot });
  const endpoint = new ChronicleProjectServerClient(options).endpoint;
  await waitForShutdown(async () => isEndpointAlive(endpoint));
  let access;
  try {
    access = createChronicleProjectAccess({ projectRoot });
    const health = await access.call('ping', {}, { timeoutMs: 10_000 });
    if (access.mode !== 'server') {
      return {
        serviceId: 'chronicle',
        action: 'restart',
        success: false,
        message: `Chronicle telemetry server restarted but running in ${access.mode} mode (expected server)`,
      };
    }
    assertDaemonRuntimeVersion(health.runtimeVersion);
    return {
      serviceId: 'chronicle',
      action: 'restart',
      success: true,
      message: 'Chronicle telemetry server restarted successfully',
    };
  } catch (error) {
    return {
      serviceId: 'chronicle',
      action: 'restart',
      success: false,
      message: `Chronicle telemetry server restarted but verification failed: ${toErrorMessage(error)}`,
    };
  } finally {
    await access?.close();
  }
}

export async function killCodebaseIndexServer(
  projectRoot: string,
  indexDir: string | undefined,
  action: 'shutdown' | 'restart',
): Promise<ServiceActionResult> {
  try {
    const result = await shutdownCodebaseIndexServer(
      projectRoot,
      indexDir,
      `websocket-request:${action}`,
    );
    if (!result.stopped) {
      if (action === 'restart' && result.reason === 'not-running') {
        return await restartCodebaseIndexServer(projectRoot, indexDir);
      }
      return {
        serviceId: 'codebase-index',
        action,
        success: false,
        message: `Codebase index server shutdown failed: ${result.reason ?? 'unknown'}`,
      };
    }
    if (action === 'restart') {
      return await restartCodebaseIndexServer(projectRoot, indexDir);
    }
    return {
      serviceId: 'codebase-index',
      action,
      success: true,
      message: 'Codebase index server shutdown requested',
    };
  } catch (error) {
    return {
      serviceId: 'codebase-index',
      action,
      success: false,
      message: toErrorMessage(error),
    };
  }
}

async function restartCodebaseIndexServer(
  projectRoot: string,
  indexDir: string | undefined,
): Promise<ServiceActionResult> {
  await waitForShutdown(async () => {
    try {
      await checkCodebaseIndexServerHealth(projectRoot, indexDir, {
        timeoutMs: 1_000,
      });
      return true;
    } catch {
      return false;
    }
  });
  try {
    await ensureCodebaseIndexServer({ projectRoot, indexDir });
    const health = await checkCodebaseIndexServerHealth(projectRoot, indexDir, {
      timeoutMs: 10_000,
    });
    if (health.status !== 'healthy') {
      return {
        serviceId: 'codebase-index',
        action: 'restart',
        success: false,
        message: `Codebase index server restart verification failed: ${health.status}`,
      };
    }
    assertDaemonRuntimeVersion(health.server?.runtimeVersion);
    return {
      serviceId: 'codebase-index',
      action: 'restart',
      success: true,
      message: 'Codebase index server restarted successfully',
    };
  } catch (error) {
    return {
      serviceId: 'codebase-index',
      action: 'restart',
      success: false,
      message: `Codebase index server restarted but verification failed: ${toErrorMessage(error)}`,
    };
  }
}

export async function killMailboxServer(
  projectRoot: string,
  action: 'shutdown' | 'restart',
): Promise<ServiceActionResult> {
  if (!isMailboxProjectServerAvailable()) {
    return {
      serviceId: 'mailbox',
      action,
      success: false,
      message: 'Mailbox project server is unavailable in this runtime',
    };
  }
  const connection = new MailboxProjectServerConnection(
    resolveWstackPaths({ projectRoot }).projectDir,
  );
  try {
    const result = await connection.shutdown(`WebUI request: ${action}`);
    if (!result.stopped) {
      if (action === 'restart' && result.reason === 'offline') {
        return await restartMailboxServer(projectRoot);
      }
      return {
        serviceId: 'mailbox',
        action,
        success: false,
        message: `Mailbox IPC server shutdown failed: ${result.reason ?? 'unknown'}`,
      };
    }
    if (action === 'restart') {
      return await restartMailboxServer(projectRoot);
    }
    return {
      serviceId: 'mailbox',
      action,
      success: true,
      message: 'Mailbox IPC server shutdown requested',
    };
  } catch (error) {
    return {
      serviceId: 'mailbox',
      action,
      success: false,
      message: toErrorMessage(error),
    };
  } finally {
    connection.close();
  }
}

async function restartMailboxServer(projectRoot: string): Promise<ServiceActionResult> {
  await waitForShutdown(async () => {
    const probe = new MailboxProjectServerConnection(
      resolveWstackPaths({ projectRoot }).projectDir,
    );
    try {
      return (await probe.probeStatus()) !== null;
    } finally {
      probe.close();
    }
  });
  const verifyConn = new MailboxProjectServerConnection(
    resolveWstackPaths({ projectRoot }).projectDir,
  );
  try {
    const health = await verifyConn.call('ping', {}, { timeoutMs: 10_000 });
    assertDaemonRuntimeVersion(health.runtimeVersion);
    return {
      serviceId: 'mailbox',
      action: 'restart',
      success: true,
      message: 'Mailbox IPC server restarted successfully',
    };
  } catch (error) {
    return {
      serviceId: 'mailbox',
      action: 'restart',
      success: false,
      message: `Mailbox IPC server restarted but verification failed: ${toErrorMessage(error)}`,
    };
  } finally {
    verifyConn.close();
  }
}
