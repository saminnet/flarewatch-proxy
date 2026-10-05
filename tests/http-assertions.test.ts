import { describe, it, expect } from 'vite-plus/test';
import { validateHttpResponse } from '../src/utils';
import type { MonitorTarget } from '../src/types';
import fixture from './fixtures/http-assertions.json';

/** A byte-identical copy of saminnet/flarewatch packages/shared/tests/fixtures/http-assertions.json. */
interface Case {
  name: string;
  monitor: Partial<MonitorTarget>;
  reply: { status: number; headers: Record<string, string>; body: string };
  error: string | null;
}

describe('http-assertions.json', () => {
  it('holds every case FlareWatch runs', () => {
    expect(fixture).toHaveLength(61);
  });

  it.each(fixture as Case[])('$name', async ({ monitor, reply, error }) => {
    const target: MonitorTarget = {
      id: 'test',
      name: 'Test',
      method: 'GET',
      target: 'https://example.com',
      ...monitor,
    };
    // Bytes, not a string: a string body would add a Content-Type the server never sent.
    const response = new Response(new TextEncoder().encode(reply.body), {
      status: reply.status,
      headers: reply.headers,
    });

    await expect(validateHttpResponse(target, response)).resolves.toBe(error);
  });
});
