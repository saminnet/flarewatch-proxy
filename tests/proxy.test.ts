import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vite-plus/test';
import { createProxy } from '../src/app';
import type { MonitorTarget } from '../src/types';
import { createLocation } from '../src/utils/location';

describe('proxy', () => {
  const app = createProxy(
    { authToken: 'test-token', location: 'TEST' },
    { checkMonitor: () => Promise.resolve({ ok: true, latency: 100 }) },
  );

  describe('public endpoints', () => {
    it('GET /health returns ok status', async () => {
      const res = await app.request('/health');
      const json = (await res.json()) as { status: string; timestamp: number };

      expect(res.status).toBe(200);
      expect(json.status).toBe('ok');
      expect(json.timestamp).toBeTypeOf('number');
    });

    it('GET / returns info with endpoints', async () => {
      const res = await app.request('/');
      const json = (await res.json()) as { name: string; endpoints: unknown; docs: string };

      expect(res.status).toBe(200);
      expect(json.name).toBe('FlareWatch Proxy');
      expect(json.endpoints).toBeDefined();
      expect(json.docs).toContain('github.com');
    });

    it('GET / reports the package version and links the proxy repo', async () => {
      const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
        version: string;
      };

      const res = await app.request('/');
      const json = (await res.json()) as { version: string; docs: string };

      expect(json.version).toBe(pkg.version);
      expect(json.docs).toBe('https://github.com/saminnet/flarewatch-proxy');
    });

    it('GET / reports contract 2', async () => {
      const res = await app.request('/');

      expect(await res.json()).toMatchObject({ contract: 2 });
    });
  });

  describe('location', () => {
    it('answers a check with UNKNOWN while the lookup is still pending', async () => {
      const proxy = createProxy(
        { authToken: 'test-token' },
        {
          checkMonitor: () => Promise.resolve({ ok: true, latency: 1 }),
          location: createLocation(undefined, {
            lookup: () => new Promise(() => {}),
            now: () => 0,
          }),
        },
      );

      const res = await proxy.request('/check', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-token' },
        body: JSON.stringify({ target: 'https://example.com' }),
      });

      expect(await res.json()).toEqual({
        contract: 2,
        location: 'UNKNOWN',
        result: { ok: true, latency: 1 },
      });
    });
  });

  describe('authentication', () => {
    it('POST /check returns 401 without auth header', async () => {
      const res = await app.request('/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'test',
          name: 'Test',
          method: 'GET',
          target: 'https://example.com',
        }),
      });

      expect(res.status).toBe(401);
      const json: unknown = await res.json();
      expect(json).toMatchObject({ error: 'Unauthorized' });
    });

    it('POST /check returns 401 with wrong auth', async () => {
      const res = await app.request('/check', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer wrong-token',
        },
        body: JSON.stringify({
          id: 'test',
          name: 'Test',
          method: 'GET',
          target: 'https://example.com',
        }),
      });

      expect(res.status).toBe(401);
    });

    it('POST /check accepts the previous token and the current one during a rotation', async () => {
      const rotating = createProxy(
        { authToken: 'new-token', location: 'TEST', previousAuthToken: 'old-token' },
        { checkMonitor: () => Promise.resolve({ ok: true, latency: 100 }) },
      );
      const check = (token: string) =>
        rotating.request('/check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            id: 'test',
            name: 'Test',
            method: 'GET',
            target: 'https://example.com',
          }),
        });

      expect((await check('old-token')).status).toBe(200);
      expect((await check('new-token')).status).toBe(200);
      expect((await check('other-token')).status).toBe(401);
    });

    it('POST /check returns 200 with correct auth', async () => {
      const res = await app.request('/check', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-token',
        },
        body: JSON.stringify({
          id: 'test',
          name: 'Test',
          method: 'GET',
          target: 'https://example.com',
        }),
      });

      expect(res.status).toBe(200);
      const json: unknown = await res.json();
      expect(json).toMatchObject({ result: { ok: true } });
    });
  });

  describe('POST /check errors', () => {
    function check(body: string, proxy = app) {
      return proxy.request('/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
        body,
      });
    }

    it('returns 400 on a body that is not JSON', async () => {
      const res = await check('{"target":');

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Invalid JSON body' });
    });

    it('returns 500 with the message when the check throws', async () => {
      const failing = createProxy(
        { authToken: 'test-token', location: 'TEST' },
        { checkMonitor: () => Promise.reject(new Error('checker crashed')) },
      );

      const res = await check(JSON.stringify({ target: 'https://example.com' }), failing);

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'checker crashed' });
    });

    it.each([
      ['target', { target: undefined }],
      ['target', { target: '' }],
      ['body', { body: 1 }],
      ['expectedCodes.0', { expectedCodes: [200.5] }],
      ['expectedCodes', { expectedCodes: '200' }],
      ['headers.X-Flag', { headers: { 'X-Flag': true } }],
      ['id', { id: '' }],
      ['method', { method: '' }],
      ['name', { name: '' }],
      ['responseKeyword', { responseKeyword: 1 }],
      ['responseForbiddenKeyword', { responseForbiddenKeyword: 1 }],
      ['sslCheckDaysBeforeExpiry', { sslCheckDaysBeforeExpiry: -1 }],
      ['sslCheckEnabled', { sslCheckEnabled: 'yes' }],
      ['sslIgnoreSelfSigned', { sslIgnoreSelfSigned: 'yes' }],
      ['timeout', { timeout: 0 }],
      ['timeout', { timeout: 1.5 }],
      ['timeout', { timeout: 60_001 }],
      ['method', { method: 'FETCH' }],
      ['method', { method: 'get' }],
      ['method', { method: 'HEARTBEAT' }],
      ['expectedCodes', { expectedCodes: [] }],
      ['expectedCodes.0', { expectedCodes: [99] }],
      ['expectedCodes.0', { expectedCodes: [600] }],
      ['responseKeyword', { responseKeyword: '' }],
      ['responseForbiddenKeyword', { responseForbiddenKeyword: '' }],
      ['sslCheckDaysBeforeExpiry', { sslCheckDaysBeforeExpiry: 1.5 }],
      ['sslCheckDaysBeforeExpiry', { sslCheckDaysBeforeExpiry: 3651 }],
      ['target', { target: 'data:text/plain,ok' }],
      ['target', { target: 'ftp://example.com' }],
      ['target', { target: 'example.com' }],
      ['target', { target: '192.168.1.50:5432' }],
      ['target', { method: 'TCP_PING', target: 'https://example.com' }],
      ['target', { method: 'TCP_PING', target: 'db.internal' }],
      ['target', { method: 'TCP_PING', target: 'db.internal:0' }],
      ['target', { method: 'TCP_PING', target: 'db.internal:5432/path' }],
      ['responseHeaderEquals', { responseHeaderEquals: {} }],
      ['responseHeaderEquals', { responseHeaderEquals: { 'X Version': '2' } }],
      ['responseHeaderEquals.X-Version', { responseHeaderEquals: { 'X-Version': 2 } }],
      ['responseHeaderEquals', { responseHeaderEquals: 'X-Version: 2' }],
      ['responseJsonPath', { responseJsonPath: 'status', responseJsonValue: 'ok' }],
      ['responseJsonPath', { responseJsonPath: '$.a[x]', responseJsonValue: 'ok' }],
      ['responseJsonValue', { responseJsonPath: '$.a', responseJsonValue: { ok: true } }],
    ])('returns 400 naming %s for %j', async (field, fields) => {
      const res = await check(JSON.stringify({ target: 'https://example.com', ...fields }));

      const json = (await res.json()) as { error: string };

      expect(res.status).toBe(400);
      expect(json.error).toMatch(new RegExp(`^${field}: `));
    });
  });

  describe('POST /check request schema', () => {
    function capture() {
      const seen: MonitorTarget[] = [];
      const proxy = createProxy(
        { authToken: 'test-token', location: 'TEST' },
        {
          checkMonitor: (monitor) => {
            seen.push(monitor);
            return Promise.resolve({ ok: true, latency: 1 });
          },
        },
      );
      const check = (
        fields: Partial<MonitorTarget> & { tooltip?: string; maxLatencyMs?: number },
      ) =>
        proxy.request('/check', {
          method: 'POST',
          headers: { Authorization: 'Bearer test-token' },
          body: JSON.stringify(fields),
        });
      return { check, seen };
    }

    it.each([
      { timeout: 1, expectedCodes: [100, 599], sslCheckDaysBeforeExpiry: 0 },
      { timeout: 60_000, sslCheckDaysBeforeExpiry: 3650 },
      { method: 'HEAD', target: 'HTTP://Example.com/health' },
      { method: 'TCP_PING', target: 'db.internal:5432' },
      { method: 'TCP_PING', target: '[::1]:5432' },
      { responseJsonPath: '$', responseJsonValue: null },
    ])('accepts %j', async (fields) => {
      const { check, seen } = capture();

      const res = await check({ target: 'https://example.com', ...fields });

      expect(res.status).toBe(200);
      expect(seen[0]).toMatchObject(fields);
    });

    it('passes the header and JSON assertions on to the check', async () => {
      const { check, seen } = capture();
      const fields = {
        target: 'https://example.com',
        responseHeaderEquals: { 'Content-Type': 'application/json' },
        responseJsonPath: '$.checks[0].status',
        responseJsonValue: 'pass',
      };

      await check(fields);

      expect(seen[0]).toMatchObject(fields);
    });

    it('ignores fields it has no use for', async () => {
      const { check, seen } = capture();

      const res = await check({
        target: 'https://example.com',
        tooltip: 'Home',
        maxLatencyMs: 500,
      });

      expect(res.status).toBe(200);
      expect(seen[0]).not.toHaveProperty('tooltip');
      expect(seen[0]).not.toHaveProperty('maxLatencyMs');
    });

    it('returns 400 when responseJsonPath comes without responseJsonValue', async () => {
      const { check, seen } = capture();

      const res = await check({ target: 'https://example.com', responseJsonPath: '$.status' });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'responseJsonPath and responseJsonValue go together',
      });
      expect(seen).toHaveLength(0);
    });

    it('returns 400 when responseJsonValue comes without responseJsonPath', async () => {
      const { check } = capture();

      const res = await check({ target: 'https://example.com', responseJsonValue: 'ok' });

      expect(await res.json()).toEqual({
        error: 'responseJsonPath and responseJsonValue go together',
      });
    });
  });

  describe('POST /check body size', () => {
    const LIMIT = 64 * 1024;

    function post(body: string) {
      return app.request('/check', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-token' },
        body,
      });
    }

    function padded(bytes: number) {
      const json = JSON.stringify({ target: 'https://example.com' });
      return json + ' '.repeat(bytes - json.length);
    }

    it('takes a body of 64 KiB', async () => {
      const res = await post(padded(LIMIT));

      expect(res.status).toBe(200);
    });

    it('returns 413 for a body over 64 KiB', async () => {
      const res = await post(padded(LIMIT + 1));

      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ error: 'Request body is over 65536 bytes' });
    });
  });
});
