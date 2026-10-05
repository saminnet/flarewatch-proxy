import { X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import type { ServerResponse } from 'node:http';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import tls from 'node:tls';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from 'vite-plus/test';
import { checkHttp } from '../../src/checkers/http';
import { checkSSLCertificate } from '../../src/checkers/ssl';
import type { MonitorTarget } from '../../src/types';
import { certificate, errorOf, listen, startHttp, startHttps } from '../helpers';

const DAY_MS = 24 * 60 * 60 * 1000;
const trustedExpiry = new X509Certificate(certificate('trusted').cert).validToDate.getTime();
const defaultCAs = tls.getCACertificates('default');

beforeAll(() => {
  tls.setDefaultCACertificates([...defaultCAs, certificate('trusted').cert]);
});

afterAll(() => {
  tls.setDefaultCACertificates(defaultCAs);
});

afterEach(() => {
  vi.useRealTimers();
});

function daysBeforeExpiry(days: number) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(trustedExpiry - days * DAY_MS);
}

async function sslMonitor(overrides: Partial<MonitorTarget> = {}): Promise<MonitorTarget> {
  const target = await startHttps('trusted', (_req, res) => res.end('ok'));
  return {
    id: 'site',
    name: 'Site',
    method: 'GET',
    target,
    timeout: 5000,
    sslCheckEnabled: true,
    ...overrides,
  };
}

describe('SSL expiry', () => {
  it('reads the certificate of an IPv6 address', async () => {
    const server = tls.createServer(certificate('untrusted'));
    server.listen(0, '::1');
    await once(server, 'listening');
    onTestFinished(() => {
      server.close();
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Expected a TCP address');

    const info = await checkSSLCertificate(`https://[::1]:${address.port}`, {
      ignoreSelfSigned: true,
      timeout: 5000,
    });

    expect(info.subject).toBe('localhost');
  });

  it('closes its connection to a server that keeps sending and never closes', async () => {
    const server = tls.createServer(
      { ...certificate('trusted'), allowHalfOpen: true },
      (socket) => {
        const drip = setInterval(() => socket.write('x'), 20);
        socket.on('error', () => {});
        socket.on('close', () => clearInterval(drip));
      },
    );
    const serverSockets = new Set<net.Socket>();
    server.on('connection', (socket) => serverSockets.add(socket));
    onTestFinished(() => {
      for (const socket of serverSockets) socket.destroy();
    });
    const port = await listen(server);
    const openSockets = () =>
      process.getActiveResourcesInfo().filter((name) => name === 'TCPSocketWrap').length;
    const before = openSockets();

    await checkSSLCertificate(`https://localhost:${port}`, { timeout: 5000 });
    await sleep(300);

    const serverSide = await new Promise((resolve) =>
      server.getConnections((_error, count) => resolve(count)),
    );
    expect(openSockets() - before).toBe(serverSide);
  });

  it('passes a valid certificate and reports it', async () => {
    const monitor = await sslMonitor({ sslCheckDaysBeforeExpiry: 14 });
    daysBeforeExpiry(15);

    const result = await checkHttp(monitor);

    expect(result).toMatchObject({
      ok: true,
      ssl: {
        daysUntilExpiry: 15,
        expiryDate: trustedExpiry / 1000,
        issuer: 'FlareWatch Test trusted',
        subject: 'localhost',
      },
    });
  });

  it('fails a certificate that expires inside the threshold', async () => {
    const monitor = await sslMonitor({ sslCheckDaysBeforeExpiry: 14 });
    daysBeforeExpiry(10);

    const result = await checkHttp(monitor);

    expect(errorOf(result)).toBe('SSL certificate expires in 10 days (threshold: 14)');
    expect(result.latency).toBeTypeOf('number');
  });

  it('fails a certificate that expires exactly at the threshold', async () => {
    const monitor = await sslMonitor({ sslCheckDaysBeforeExpiry: 14 });
    daysBeforeExpiry(14);

    const result = await checkHttp(monitor);

    expect(errorOf(result)).toBe('SSL certificate expires in 14 days (threshold: 14)');
  });

  it('uses a 30-day threshold by default', async () => {
    const monitor = await sslMonitor();
    daysBeforeExpiry(30);

    const result = await checkHttp(monitor);

    expect(errorOf(result)).toBe('SSL certificate expires in 30 days (threshold: 30)');
  });

  it('skips the certificate on a plain http target', async () => {
    const target = await startHttp((_req, res) => res.end('ok'));

    const result = await checkHttp(await sslMonitor({ target }));

    expect(result.ok).toBe(true);
    expect(result).not.toHaveProperty('ssl');
  });

  it('reads the certificate whatever the case of the scheme', async () => {
    const monitor = await sslMonitor();
    daysBeforeExpiry(40);

    const result = await checkHttp({ ...monitor, target: monitor.target.toUpperCase() });

    expect(result).toMatchObject({ ok: true, ssl: { daysUntilExpiry: 40 } });
  });
});

describe('after a redirect', () => {
  const redirectTo = (location: string) => (_req: unknown, res: ServerResponse) => {
    res.writeHead(301, { location }).end();
  };

  it('reads the certificate of the final hop', async () => {
    const final = await startHttps('trusted', (_req, res) => res.end('ok'));
    const first = await startHttps('untrusted', redirectTo(final));
    daysBeforeExpiry(10);

    const result = await checkHttp(
      await sslMonitor({ target: first, sslIgnoreSelfSigned: true, sslCheckDaysBeforeExpiry: 14 }),
    );

    expect(errorOf(result)).toBe('SSL certificate expires in 10 days (threshold: 14)');
  });

  it('reports the certificate of the final hop', async () => {
    const final = await startHttps('trusted', (_req, res) => res.end('ok'));
    const first = await startHttps('untrusted', redirectTo(final));
    daysBeforeExpiry(40);

    const result = await checkHttp(await sslMonitor({ target: first, sslIgnoreSelfSigned: true }));

    expect(result).toMatchObject({
      ok: true,
      ssl: { daysUntilExpiry: 40, issuer: 'FlareWatch Test trusted' },
    });
  });

  it('passes without a certificate when the final hop is plain http', async () => {
    const final = await startHttp((_req, res) => res.end('ok'));
    const first = await startHttps('trusted', redirectTo(final));

    const result = await checkHttp(await sslMonitor({ target: first }));

    expect(result.ok).toBe(true);
    expect(result).not.toHaveProperty('ssl');
  });

  it('reads the certificate when a plain http target redirects to https', async () => {
    const final = await startHttps('trusted', (_req, res) => res.end('ok'));
    const first = await startHttp(redirectTo(final));
    daysBeforeExpiry(40);

    const result = await checkHttp(await sslMonitor({ target: first }));

    expect(result).toMatchObject({ ok: true, ssl: { daysUntilExpiry: 40 } });
  });
});

describe('sslIgnoreSelfSigned', () => {
  const selfSigned = () => startHttps('untrusted', (_req, res) => res.end('ok'));

  it('fails a self-signed target without the flag', async () => {
    const target = await selfSigned();

    const result = await checkHttp({ id: 'site', name: 'Site', method: 'GET', target });

    expect(errorOf(result)).toBe('fetch failed: DEPTH_ZERO_SELF_SIGNED_CERT');
  });

  it('passes a self-signed target with the flag', async () => {
    const target = await selfSigned();

    const result = await checkHttp({
      id: 'site',
      name: 'Site',
      method: 'GET',
      target,
      sslIgnoreSelfSigned: true,
    });

    expect(result.ok).toBe(true);
  });

  it('reads the certificate of a self-signed target with the flag', async () => {
    const target = await selfSigned();

    const result = await checkHttp({
      id: 'site',
      name: 'Site',
      method: 'GET',
      target,
      sslIgnoreSelfSigned: true,
      sslCheckEnabled: true,
      sslCheckDaysBeforeExpiry: 0,
    });

    expect(result).toMatchObject({
      ok: true,
      ssl: { issuer: 'FlareWatch Test untrusted', subject: 'localhost' },
    });
  });
});

describe('timeout budget', () => {
  async function silentTlsTarget() {
    return `https://localhost:${await listen(net.createServer(() => {}))}`;
  }

  function answerAfter(ms: number) {
    return () => sleep(ms).then(() => new Response('ok'));
  }

  it('cuts the certificate step at the time left', async () => {
    const monitor = await sslMonitor({ target: await silentTlsTarget(), timeout: 300 });
    const started = performance.now();

    const result = await checkHttp(monitor, { fetch: answerAfter(0), checkSSLCertificate });

    expect(errorOf(result)).toBe('Timeout after 300ms');
    expect(performance.now() - started).toBeLessThan(450);
  });

  it('fails without the certificate step when no time is left', async () => {
    const monitor = await sslMonitor({ target: await silentTlsTarget(), timeout: 100 });
    const started = performance.now();

    const result = await checkHttp(monitor, { fetch: answerAfter(150), checkSSLCertificate });

    expect(errorOf(result)).toBe('Timeout after 100ms');
    expect(performance.now() - started).toBeLessThan(400);
  });
});
