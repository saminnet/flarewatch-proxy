import type { IncomingHttpHeaders } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, it, expect } from 'vite-plus/test';
import { checkHttp } from '../../src/checkers/http';
import { checkSSLCertificate } from '../../src/checkers/ssl';
import type { MonitorTarget } from '../../src/types';
import { MAX_BODY_BYTES, readTextUpTo } from '../../src/utils';
import { closedPort, errorOf, startHttp } from '../helpers';

const MiB = 1024 * 1024;

function createMonitor(overrides: Partial<MonitorTarget> = {}): MonitorTarget {
  return {
    id: 'test-monitor',
    name: 'Test Monitor',
    method: 'GET',
    target: 'https://example.com',
    ...overrides,
  };
}

function reply(status: number, body = 'ok') {
  return startHttp((_req, res) => {
    res.writeHead(status).end(body);
  });
}

describe('checkHttp (proxy)', () => {
  it('fails when sslCheckEnabled is true and SSL check fails', async () => {
    const result = await checkHttp(createMonitor({ sslCheckEnabled: true }), {
      fetch: () => Promise.resolve(new Response('ok', { status: 200 })),
      checkSSLCertificate: () => Promise.reject(new Error('tls unavailable')),
    });

    expect(errorOf(result)).toContain('SSL check failed');
  });

  describe('status codes', () => {
    it.each([200, 204, 299])('passes a %i without expectedCodes', async (status) => {
      const result = await checkHttp(createMonitor({ target: await reply(status) }));

      expect(result.ok).toBe(true);
      expect(result.latency).toBeTypeOf('number');
    });

    it.each([301, 404, 500])('fails a %i without expectedCodes', async (status) => {
      const result = await checkHttp(createMonitor({ target: await reply(status) }));

      expect(errorOf(result)).toBe(`Expected 2xx status, got ${status}`);
      expect(result.latency).toBeTypeOf('number');
    });

    it('passes a listed non-2xx code', async () => {
      const target = await reply(404);

      const result = await checkHttp(createMonitor({ target, expectedCodes: [200, 404] }));

      expect(result.ok).toBe(true);
    });

    it('fails a code missing from expectedCodes, even a 2xx', async () => {
      const target = await reply(200);

      const result = await checkHttp(createMonitor({ target, expectedCodes: [201, 204] }));

      expect(errorOf(result)).toBe('Expected status 201|204, got 200');
    });
  });

  describe('keywords', () => {
    it('passes when responseKeyword is in the body', async () => {
      const target = await reply(200, 'status: healthy');

      const result = await checkHttp(createMonitor({ target, responseKeyword: 'healthy' }));

      expect(result.ok).toBe(true);
    });

    it('fails when responseKeyword is missing, matching case', async () => {
      const target = await reply(200, 'status: healthy');

      const result = await checkHttp(createMonitor({ target, responseKeyword: 'HEALTHY' }));

      expect(errorOf(result)).toBe('Required keyword "HEALTHY" not found in response');
    });

    it('fails when responseForbiddenKeyword is in the body', async () => {
      const target = await reply(200, 'status: error');

      const result = await checkHttp(createMonitor({ target, responseForbiddenKeyword: 'error' }));

      expect(errorOf(result)).toBe('Forbidden keyword "error" found in response');
    });

    it('passes when responseForbiddenKeyword is absent', async () => {
      const target = await reply(200, 'status: healthy');

      const result = await checkHttp(createMonitor({ target, responseForbiddenKeyword: 'error' }));

      expect(result.ok).toBe(true);
    });

    it('reports the status before reading the body', async () => {
      const target = await reply(500, 'down');

      const result = await checkHttp(createMonitor({ target, responseKeyword: 'healthy' }));

      expect(errorOf(result)).toBe('Expected 2xx status, got 500');
    });

    describe('in a body over 1 MiB', () => {
      it('misses a keyword after the first MiB', async () => {
        const target = await reply(200, `${'x'.repeat(MiB)}ok`);

        const result = await checkHttp(createMonitor({ target, responseKeyword: 'ok' }));

        expect(errorOf(result)).toBe('Required keyword "ok" not found in response');
      });

      it('finds a keyword that ends at the first MiB', async () => {
        const target = await reply(200, `${'x'.repeat(MiB - 2)}ok${'x'.repeat(MiB)}`);

        const result = await checkHttp(createMonitor({ target, responseKeyword: 'ok' }));

        expect(result.ok).toBe(true);
      });

      it('ignores a forbidden keyword after the first MiB', async () => {
        const target = await reply(200, `${'x'.repeat(MiB)}error`);

        const result = await checkHttp(
          createMonitor({ target, responseForbiddenKeyword: 'error' }),
        );

        expect(result.ok).toBe(true);
      });

      it('stops reading a body that never ends', async () => {
        const chunk = 'x'.repeat(64 * 1024);
        const target = await startHttp((_req, res) => {
          const write = () => {
            while (!res.destroyed && res.write(chunk));
          };
          res.on('drain', write);
          write();
        });

        const result = await checkHttp(
          createMonitor({ target, timeout: 2000, responseKeyword: 'ok' }),
        );

        expect(errorOf(result)).toBe('Required keyword "ok" not found in response');
      });
    });
  });

  describe('header and JSON assertions', () => {
    function replyWith(headers: Record<string, string>, body: string) {
      return startHttp((_req, res) => {
        res.writeHead(200, headers).end(body);
      });
    }

    it('passes when a header has the expected value', async () => {
      const target = await replyWith({ 'X-Version': '2' }, 'ok');

      const result = await checkHttp(
        createMonitor({ target, responseHeaderEquals: { 'x-version': '2' } }),
      );

      expect(result.ok).toBe(true);
    });

    it('fails when a header has another value', async () => {
      const target = await replyWith({ 'X-Version': '1' }, 'ok');

      const result = await checkHttp(
        createMonitor({ target, responseHeaderEquals: { 'X-Version': '2' } }),
      );

      expect(errorOf(result)).toBe('Header "X-Version" does not have the expected value');
    });

    it('passes when the JSON value at the path matches', async () => {
      const target = await replyWith({}, '{"checks":[{"status":"pass"}]}');

      const result = await checkHttp(
        createMonitor({
          target,
          responseJsonPath: '$.checks[0].status',
          responseJsonValue: 'pass',
        }),
      );

      expect(result.ok).toBe(true);
    });

    it('fails when the JSON value at the path differs', async () => {
      const target = await replyWith({}, '{"checks":[{"status":"fail"}]}');

      const result = await checkHttp(
        createMonitor({
          target,
          responseJsonPath: '$.checks[0].status',
          responseJsonValue: 'pass',
        }),
      );

      expect(errorOf(result)).toBe('JSON value at $.checks[0].status is not "pass"');
    });

    it('checks a JSON body one byte under 1 MiB', async () => {
      const prefix = '{"status":"ok","pad":"';
      const body = `${prefix}${'x'.repeat(MiB - 1 - prefix.length - 2)}"}`;
      expect(body).toHaveLength(MiB - 1);
      const target = await replyWith({}, body);

      const result = await checkHttp(
        createMonitor({ target, responseJsonPath: '$.status', responseJsonValue: 'ok' }),
      );

      expect(result.ok).toBe(true);
    });

    it('fails a JSON body of 1 MiB or more, which the cap may have cut', async () => {
      const body = `{"status":"ok","pad":"${'x'.repeat(MiB)}"}`;
      const target = await replyWith({}, body);

      const result = await checkHttp(
        createMonitor({ target, responseJsonPath: '$.status', responseJsonValue: 'ok' }),
      );

      expect(errorOf(result)).toBe('Response is too large to check $.status');
    });
  });

  describe('network errors', () => {
    it('fails when the body breaks off after the headers', async () => {
      const target = await startHttp((_req, res) => {
        res.writeHead(200, { 'content-length': '1000' });
        res.write('part of the body', () => res.destroy());
      });

      const result = await checkHttp(createMonitor({ target, responseKeyword: 'ok' }));

      expect(errorOf(result)).toBe('terminated: UND_ERR_SOCKET');
      expect(result.latency).toBeTypeOf('number');
    });

    it('names the cause code of a refused connection', async () => {
      const target = `http://127.0.0.1:${await closedPort()}`;

      const result = await checkHttp(createMonitor({ target }));

      expect(errorOf(result)).toBe('fetch failed: ECONNREFUSED');
      expect(result.latency).toBeTypeOf('number');
    });

    it('names the cause message when the cause has no code', async () => {
      const result = await checkHttp(createMonitor(), {
        fetch: () =>
          Promise.reject(new TypeError('fetch failed', { cause: new Error('other side closed') })),
        checkSSLCertificate,
      });

      expect(errorOf(result)).toBe('fetch failed: other side closed');
    });

    it('keeps an error without a cause as it is', async () => {
      const result = await checkHttp(createMonitor(), {
        fetch: () => Promise.reject(new Error('Invalid URL')),
        checkSSLCertificate,
      });

      expect(errorOf(result)).toBe('Invalid URL');
    });
  });

  it('fails with the timeout text when the response is late', async () => {
    const target = await startHttp((_req, res) => {
      void sleep(1000).then(() => res.end('late'));
    });

    const result = await checkHttp(createMonitor({ target, timeout: 50 }));

    expect(errorOf(result)).toBe('Timeout after 50ms');
    expect(result.latency).toBeTypeOf('number');
  });

  describe('request', () => {
    async function capture(monitor: Partial<MonitorTarget>) {
      let seen:
        | { method: string | undefined; headers: IncomingHttpHeaders; body: string }
        | undefined;
      const target = await startHttp((req, res) => {
        let body = '';
        req.on('data', (chunk: Buffer) => (body += chunk.toString()));
        req.on('end', () => {
          seen = { method: req.method, headers: req.headers, body };
          res.end('ok');
        });
      });
      const result = await checkHttp(createMonitor({ target, ...monitor }));
      return { result, seen };
    }

    it('sends the method, body and headers, numbers as text', async () => {
      const { result, seen } = await capture({
        method: 'POST',
        body: '{"ping":true}',
        headers: { 'X-Retries': 3, 'X-Name': 'probe' },
      });

      expect(result.ok).toBe(true);
      expect(seen).toMatchObject({
        method: 'POST',
        body: '{"ping":true}',
        headers: { 'x-retries': '3', 'x-name': 'probe' },
      });
    });

    it('sends the FlareWatch-Proxy user-agent by default', async () => {
      const { seen } = await capture({});

      expect(seen?.headers['user-agent']).toMatch(/^FlareWatch-Proxy\/1\.0 /);
    });

    it('keeps a configured user-agent', async () => {
      const { seen } = await capture({ headers: { 'User-Agent': 'custom/2.0' } });

      expect(seen?.headers['user-agent']).toBe('custom/2.0');
    });
  });
});

describe('readTextUpTo', () => {
  function streamOf(...chunks: number[][]) {
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk));
          controller.close();
        },
      }),
    );
  }

  it('decodes a character split between two chunks', async () => {
    const euro = [0xe2, 0x82, 0xac];

    await expect(readTextUpTo(streamOf(euro.slice(0, 1), euro.slice(1)), 16)).resolves.toBe('€');
  });

  it('turns a character the cap cuts in two into one U+FFFD', async () => {
    const response = new Response(`${'x'.repeat(MAX_BODY_BYTES - 1)}€`);

    const text = await readTextUpTo(response, MAX_BODY_BYTES);

    expect(text).toBe(`${'x'.repeat(MAX_BODY_BYTES - 1)}\uFFFD`);
  });
});
