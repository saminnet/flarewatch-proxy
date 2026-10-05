import { setImmediate as flush } from 'node:timers/promises';
import { describe, expect, it } from 'vite-plus/test';
import { createLocation, lookupCloudflareColo } from '../src/utils/location';

const RETRY_MS = 60_000;

function scriptedLookup() {
  const calls: { resolve: (colo: string) => void; reject: (error: Error) => void }[] = [];
  const lookup = () =>
    new Promise<string>((resolve, reject) => {
      calls.push({ resolve, reject });
    });
  return { calls, lookup };
}

describe('createLocation', () => {
  it('uses the configured location and never looks it up', () => {
    const { calls, lookup } = scriptedLookup();

    const location = createLocation('Home lab', { lookup, now: () => 0 });

    expect(location()).toBe('Home lab');
    expect(calls).toHaveLength(0);
  });

  it('starts the lookup when created, before any request', () => {
    const { calls, lookup } = scriptedLookup();

    createLocation(undefined, { lookup, now: () => 0 });

    expect(calls).toHaveLength(1);
  });

  it('answers UNKNOWN while the lookup is pending, then the colo', async () => {
    const { calls, lookup } = scriptedLookup();
    const location = createLocation(undefined, { lookup, now: () => 0 });

    expect(location()).toBe('UNKNOWN');
    expect(location()).toBe('UNKNOWN');
    expect(calls).toHaveLength(1);

    calls[0]?.resolve('FRA');
    await flush();

    expect(location()).toBe('FRA');
  });

  it('retries a failed lookup after a minute, not before, and keeps the colo it finds', async () => {
    let now = 0;
    const { calls, lookup } = scriptedLookup();
    const location = createLocation(undefined, { lookup, now: () => now });

    calls[0]?.reject(new Error('fetch failed'));
    await flush();
    now = RETRY_MS - 1;

    expect(location()).toBe('UNKNOWN');
    expect(calls).toHaveLength(1);

    now = RETRY_MS;
    expect(location()).toBe('UNKNOWN');
    expect(calls).toHaveLength(2);

    calls[1]?.resolve('AMS');
    await flush();
    now = 10 * RETRY_MS;

    expect(location()).toBe('AMS');
    expect(calls).toHaveLength(2);
  });
});

describe('lookupCloudflareColo', () => {
  const trace = (body: string) => () => Promise.resolve(new Response(body));

  it('reads the colo line of the Cloudflare trace', async () => {
    const body = 'fl=123\nh=cloudflare.com\nip=203.0.113.9\ncolo=FRA\nloc=DE\n';

    await expect(lookupCloudflareColo(trace(body))).resolves.toBe('FRA');
  });

  it('fails when the trace has no colo', async () => {
    await expect(lookupCloudflareColo(trace('fl=123\nloc=DE\n'))).rejects.toThrow('colo');
  });

  it('reads no further than the first few KiB of the trace', async () => {
    const body = `fl=123\n${'x'.repeat(64 * 1024)}\ncolo=FRA\n`;

    await expect(lookupCloudflareColo(trace(body))).rejects.toThrow('colo');
  });
});
