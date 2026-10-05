import net from 'node:net';
import { createLogger } from '../log';
import type { CheckResult, MonitorTarget } from '../types';
import {
  DEFAULT_HTTP_TIMEOUT,
  failure,
  getErrorMessage,
  isTimeoutError,
  networkErrorMessage,
  parseTcpTarget,
  success,
} from '../utils';

const log = createLogger('TCP');

export interface TcpCheckDeps {
  readonly connect: (options: net.TcpNetConnectOpts) => net.Socket;
}

export async function checkTcp(
  target: MonitorTarget,
  deps: TcpCheckDeps = { connect: net.createConnection },
): Promise<CheckResult> {
  const startTime = performance.now();
  const timeout = target.timeout ?? DEFAULT_HTTP_TIMEOUT;

  try {
    const { hostname, port } = parseTcpTarget(target.target);

    await new Promise<void>((resolve, reject) => {
      const socket = deps.connect({ host: hostname, port });

      // Armed until close: after end(), a target that never closes its side holds the socket open.
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Connection timed out after ${timeout}ms`));
      }, timeout);
      socket.on('close', () => clearTimeout(timer));

      socket.on('connect', () => {
        socket.end();
        resolve();
      });

      socket.on('error', (err) => {
        socket.destroy();
        reject(err);
      });
    });

    const latency = Math.round(performance.now() - startTime);
    log.info('Connected', { name: target.name, hostname, port, latency });

    return success(latency);
  } catch (error) {
    const latency = Math.round(performance.now() - startTime);

    if (isTimeoutError(getErrorMessage(error))) {
      log.info('Timeout', { name: target.name, timeout });
      return failure(`Timeout after ${timeout}ms`, latency);
    }

    const errorMessage = networkErrorMessage(error);
    log.info('Error', { name: target.name, error: errorMessage });
    return failure(errorMessage, latency);
  }
}
