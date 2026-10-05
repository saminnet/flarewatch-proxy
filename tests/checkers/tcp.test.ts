import { once } from 'node:events';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it, onTestFinished } from 'vite-plus/test';
import { checkMonitor } from '../../src/checkers';
import { checkTcp } from '../../src/checkers/tcp';
import { closedPort, errorOf, listen } from '../helpers';

function tcpMonitor(target: string, timeout = 2000) {
  return { id: 'db', name: 'Database', method: 'TCP_PING', target, timeout };
}

describe('TCP_PING', () => {
  it('passes when the port accepts a connection', async () => {
    const port = await listen(net.createServer((socket) => socket.end()));

    const result = await checkMonitor(tcpMonitor(`localhost:${port}`));

    expect(result.ok).toBe(true);
    expect(result.latency).toBeTypeOf('number');
  });

  it('fails with the refusal when nothing listens on the port', async () => {
    const port = await closedPort();

    const result = await checkMonitor(tcpMonitor(`127.0.0.1:${port}`));

    expect(errorOf(result)).toBe(`connect ECONNREFUSED 127.0.0.1:${port}`);
    expect(result.latency).toBeTypeOf('number');
  });

  it('names the refusal when every address of the host refuses', async () => {
    const port = await closedPort();

    const result = await checkMonitor(tcpMonitor(`localhost:${port}`));

    expect(errorOf(result)).toContain('ECONNREFUSED');
  });

  it.each([
    ['localhost', 'TCP target must include a port (hostname:port)'],
    ['localhost:0', 'Invalid TCP port: 0'],
  ])('fails on the target %s without connecting', async (target, error) => {
    const result = await checkMonitor(tcpMonitor(target));

    expect(errorOf(result)).toBe(error);
  });

  it('fails with the timeout text when the connection never opens', async () => {
    const started = performance.now();

    const result = await checkTcp(tcpMonitor('db.internal:5432', 50), {
      connect: () => new net.Socket(),
    });

    expect(errorOf(result)).toBe('Timeout after 50ms');
    expect(performance.now() - started).toBeGreaterThanOrEqual(45);
  });

  it('closes a connection the target never closes, at the timeout', async () => {
    const held: net.Socket[] = [];
    const server = net.createServer({ allowHalfOpen: true }, (socket) => held.push(socket));
    const port = await listen(server);
    onTestFinished(() => held.forEach((socket) => socket.destroy()));
    const opened: net.Socket[] = [];

    const result = await checkTcp(tcpMonitor(`localhost:${port}`, 200), {
      connect: (options) => {
        const socket = net.createConnection(options);
        opened.push(socket);
        return socket;
      },
    });
    const [socket] = opened;
    if (!socket) throw new Error('Expected the check to connect');
    const closed = await Promise.race([
      once(socket, 'close').then(() => true),
      sleep(1000).then(() => socket.destroyed),
    ]);

    expect(result.ok).toBe(true);
    expect(closed).toBe(true);
  });
});
