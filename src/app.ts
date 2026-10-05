import { createHash, timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { version } from '../package.json';
import { checkMonitor } from './checkers';
import { createLogger } from './log';
import type { CheckResult, CheckResultWithLocation, MonitorTarget } from './types';
import { getErrorMessage, jsonPathKeys, readJsonUpTo } from './utils';
import { createLocation } from './utils/location';

const log = createLogger('Proxy');

/** 1 (no `contract` field sent): status and keyword checks. 2: adds `responseHeaderEquals` and `responseJsonPath`. */
export const PROXY_CONTRACT = 2;

export interface ProxyConfig {
  authToken: string;
  previousAuthToken?: string | undefined;
  location?: string | undefined;
}

export interface ProxyDeps {
  readonly checkMonitor: (target: MonitorTarget) => Promise<CheckResult>;
  readonly location: () => string;
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest();
}

const PULL_METHODS = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
  'TCP_PING',
] as const;
/** A check may not outlast the minute between FlareWatch's check runs. */
const MAX_TIMEOUT_MS = 60_000;
/** RFC 9110 token characters; Headers.get throws on anything else. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const MAX_REQUEST_BYTES = 64 * 1024;

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isValidHostPort(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;

  try {
    const url = new URL(`http://${trimmed}`);
    if (!url.hostname || !url.port) return false;
    if (url.username || url.password) return false;
    if (url.pathname !== '/' || url.search || url.hash) return false;

    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return false;

    return true;
  } catch {
    return false;
  }
}

function targetIssue(method: string, target: string): string | null {
  if (method === 'TCP_PING') {
    return isValidHostPort(target)
      ? null
      : 'TCP_PING target must be host:port (e.g. "example.com:443")';
  }
  return isValidHttpUrl(target.trim()) ? null : `${method} target must be an http(s) URL`;
}

function nonEmptyString(field: string) {
  const error = `${field} must be a non-empty string`;
  return z.string({ error }).min(1, { error });
}

function intInRange(field: string, min: number, max: number) {
  const error = `${field} must be an integer from ${min} to ${max}`;
  return z.int({ error }).min(min, { error }).max(max, { error });
}

/** Mirrors the monitor schema in FlareWatch's packages/shared/src/config.ts. */
const MonitorTargetSchema = z
  .object({
    body: z.string().optional(),
    expectedCodes: z
      .array(intInRange('expectedCodes', 100, 599), {
        error: 'expectedCodes must be a list of status codes',
      })
      .min(1, { error: 'expectedCodes must list at least one status code' })
      .optional(),
    headers: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
    id: nonEmptyString('id').default('unknown'),
    method: z
      .enum(PULL_METHODS, { error: `method must be one of ${PULL_METHODS.join(', ')}` })
      .default('GET'),
    name: nonEmptyString('name').optional(),
    responseForbiddenKeyword: nonEmptyString('responseForbiddenKeyword').optional(),
    responseHeaderEquals: z
      .record(z.string(), z.string({ error: 'responseHeaderEquals values must be strings' }), {
        error: 'responseHeaderEquals must map header names to strings',
      })
      .refine((headers) => Object.keys(headers).length > 0, {
        error: 'responseHeaderEquals must name at least one header',
      })
      .refine((headers) => Object.keys(headers).every((name) => HEADER_NAME.test(name)), {
        error: 'responseHeaderEquals has a bad header name',
      })
      .optional(),
    responseJsonPath: z
      .string({ error: 'responseJsonPath must be a string' })
      .refine((path) => jsonPathKeys(path) !== null, {
        error: 'responseJsonPath must be a path like $.a.b[0].c',
      })
      .optional(),
    responseJsonValue: z
      .union([z.string(), z.number(), z.boolean(), z.null()], {
        error: 'responseJsonValue must be a string, number, boolean or null',
      })
      .optional(),
    responseKeyword: nonEmptyString('responseKeyword').optional(),
    sslCheckDaysBeforeExpiry: intInRange('sslCheckDaysBeforeExpiry', 0, 3650).optional(),
    sslCheckEnabled: z.boolean().optional(),
    sslIgnoreSelfSigned: z.boolean().optional(),
    target: z.string({ error: 'target URL is required' }),
    timeout: intInRange('timeout', 1, MAX_TIMEOUT_MS).optional(),
  })
  .superRefine(({ method, target, responseJsonPath, responseJsonValue }, ctx) => {
    const issue = targetIssue(method, target);
    if (issue) ctx.addIssue({ code: 'custom', message: issue, path: ['target'] });
    if ((responseJsonPath === undefined) !== (responseJsonValue === undefined)) {
      ctx.addIssue({
        code: 'custom',
        message: 'responseJsonPath and responseJsonValue go together',
      });
    }
  });

function parseMonitorTarget(
  value: unknown,
): { ok: true; monitor: MonitorTarget } | { ok: false; error: string } {
  const result = MonitorTargetSchema.safeParse(value);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    const path = firstIssue?.path.join('.') || '';
    const message = firstIssue?.message ?? 'Invalid request body';
    return { ok: false, error: path ? `${path}: ${message}` : message };
  }
  const data = result.data;
  return {
    ok: true,
    monitor: { ...data, name: data.name ?? data.id },
  };
}

async function handleCheckRequest(c: Context, deps: ProxyDeps): Promise<Response> {
  try {
    let body: unknown;
    try {
      body = await readJsonUpTo(c.req.raw, MAX_REQUEST_BYTES);
    } catch (error) {
      return error instanceof SyntaxError
        ? c.json({ error: 'Invalid JSON body' }, 400)
        : c.json({ error: `Request body is over ${MAX_REQUEST_BYTES} bytes` }, 413);
    }

    const parsed = parseMonitorTarget(body);
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, 400);
    }

    const monitor = parsed.monitor;
    log.info('Starting check', { name: monitor.name ?? monitor.id });

    const result = await deps.checkMonitor(monitor);
    const location = deps.location();

    log.info('Completed', { location, status: result.ok ? 'UP' : 'DOWN' });
    return c.json({
      contract: PROXY_CONTRACT,
      location,
      result,
    } satisfies CheckResultWithLocation);
  } catch (error) {
    const message = getErrorMessage(error);
    log.error('Error', { error: message });
    return c.json({ error: message }, 500);
  }
}

export function createProxy(config: ProxyConfig, overrides: Partial<ProxyDeps> = {}) {
  const deps: ProxyDeps = {
    checkMonitor: overrides.checkMonitor ?? checkMonitor,
    location: overrides.location ?? createLocation(config.location),
  };
  const app = new Hono();

  app.get('/health', (c) => {
    return c.json({ status: 'ok', timestamp: Date.now() });
  });

  const accepted = [config.authToken, config.previousAuthToken]
    .filter((token) => token !== undefined)
    .map((token) => sha256(`Bearer ${token}`));

  app.use('/check', async (c, next) => {
    const given = sha256(c.req.header('Authorization') ?? '');
    if (!accepted.map((expected) => timingSafeEqual(given, expected)).includes(true)) {
      log.info('Unauthorized request');
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return next();
  });

  app.post('/check', (c) => handleCheckRequest(c, deps));

  app.get('/', (c) => {
    return c.json({
      contract: PROXY_CONTRACT,
      docs: 'https://github.com/saminnet/flarewatch-proxy',
      endpoints: {
        'GET /': 'This info page',
        'GET /health': 'Health check',
        'POST /check': 'Execute a monitor check',
      },
      name: 'FlareWatch Proxy',
      version,
    });
  });

  return app;
}
