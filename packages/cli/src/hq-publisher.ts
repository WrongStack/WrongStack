/**
 * The CLI's HQ connection: `@wrongstack/runtime/hq-host`'s host connection with the CLI's
 * version and WebSocket. The standalone engine behind WebUI/desktop uses the same connection
 * with its own.
 */
import type { HqPublisher, HqSocketLike } from '@wrongstack/hq';
import {
  createHqHostPublisher,
  type HqHostConnection,
  type HqHostConnectionOptions,
  type HqHostPublisherOptions,
  startHqHostConnection,
} from '@wrongstack/runtime/hq-host';
import { CLI_VERSION } from './version.js';
import { WebSocket } from './ws-runtime.js';

type CliHqPublisherOptions = Omit<HqHostPublisherOptions, 'socketFactory'> & {
  socketFactory?: HqHostPublisherOptions['socketFactory'];
};
type CliHqConnectionOptions = Omit<HqHostConnectionOptions, 'socketFactory'> & {
  socketFactory?: HqHostConnectionOptions['socketFactory'];
};

export type CliHqConnection = HqHostConnection;

function nodeWsSocketFactory(url: string): HqSocketLike {
  return new WebSocket(url) as unknown as HqSocketLike;
}

function withCliDefaults<T extends CliHqPublisherOptions>(
  options: T,
): T & Pick<HqHostPublisherOptions, 'socketFactory'> {
  return {
    ...options,
    clientVersion: options.clientVersion ?? options.version ?? CLI_VERSION,
    socketFactory: options.socketFactory ?? nodeWsSocketFactory,
  };
}

export function createCliHqPublisher(options: CliHqPublisherOptions): HqPublisher | undefined {
  return createHqHostPublisher(withCliDefaults(options));
}

export function startCliHqConnection(options: CliHqConnectionOptions): CliHqConnection {
  return startHqHostConnection(withCliDefaults(options));
}
