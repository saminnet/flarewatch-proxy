import type { Dispatcher } from 'undici';
import type {
  CheckFailure,
  CheckSuccess,
  JsonObject,
  MonitorTarget,
  SSLCertificateInfo,
} from './types';

export const DEFAULT_HTTP_TIMEOUT = 10000;
export const DEFAULT_SSL_EXPIRY_THRESHOLD_DAYS = 30;

/** Sound only for `JSON.parse` output: class instances and runtime bindings also pass. */
export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function toHeaders(headers?: { [key: string]: string | number }): Headers {
  return new Headers(Object.entries(headers ?? {}).map(([key, value]) => [key, String(value)]));
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: Error): string | undefined {
  return 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

/**
 * Node's fetch puts the reason in `cause`, and a connect that fails on every address of a host
 * throws an AggregateError with an empty message.
 */
export function networkErrorMessage(error: unknown): string {
  const message = getErrorMessage(error);
  if (!(error instanceof Error)) return message;
  if (error.cause instanceof Error) {
    const reason = errorCode(error.cause) ?? error.cause.message;
    return reason ? `${message}: ${reason}` : message;
  }
  return message || (errorCode(error) ?? message);
}

export function isTimeoutError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes('timeout') || lower.includes('timed out') || lower.includes('abort');
}

export interface FetchOptions extends Omit<RequestInit, 'signal' | 'body'> {
  timeout?: number;
  body?: BodyInit | null | undefined;
  dispatcher?: Dispatcher | undefined;
}

export async function fetchWithTimeout(url: string, options: FetchOptions = {}): Promise<Response> {
  const { timeout = DEFAULT_HTTP_TIMEOUT, body, ...rest } = options;

  const requestInit: RequestInit & { dispatcher?: Dispatcher | undefined } = {
    ...rest,
    signal: AbortSignal.timeout(timeout),
  };

  if (body !== undefined) {
    requestInit.body = body;
  }

  return fetch(url, requestInit);
}

export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`Operation timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new TimeoutError(ms)), ms);
  });

  try {
    const result = await Promise.race([promise, timeoutPromise]);
    clearTimeout(timeoutId!);
    return result;
  } catch (error) {
    clearTimeout(timeoutId!);
    throw error;
  }
}

/** A monitored site must not be able to exhaust the proxy's memory. */
export const MAX_BODY_BYTES = 1024 * 1024;

const JSON_PATH = /^\$(?:\.[^.[\]]+|\[\d+\])*$/;

export function jsonPathKeys(path: string): (string | number)[] | null {
  if (!JSON_PATH.test(path)) return null;
  return [...path.matchAll(/\.([^.[\]]+)|\[(\d+)\]/g)].map(
    ([, key, index]) => key ?? Number(index),
  );
}

function valueAt(document: unknown, keys: (string | number)[]): unknown {
  let value = document;
  for (const key of keys) {
    if (typeof key === 'number') {
      if (!Array.isArray(value)) return undefined;
      const items: unknown[] = value;
      value = items[key];
    } else {
      if (!isJsonObject(value) || !Object.hasOwn(value, key)) return undefined;
      value = value[key];
    }
  }
  return value;
}

type WithBody = Pick<Body, 'body'>;

export async function readTextUpTo(message: WithBody, maxBytes: number): Promise<string> {
  const reader = message.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  while (bytes < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value.subarray(0, maxBytes - bytes);
    bytes += chunk.byteLength;
    text += decoder.decode(chunk, { stream: true });
  }
  await reader.cancel().catch(() => {});
  return text + decoder.decode();
}

export async function readJsonUpTo(message: WithBody, maxBytes: number): Promise<unknown> {
  const text = await readTextUpTo(message, maxBytes + 1);
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new Error(`response is over ${maxBytes} bytes`);
  }
  return JSON.parse(text);
}

/** The returned error never quotes the response. */
export async function validateHttpResponse(
  monitor: MonitorTarget,
  reply: Response,
): Promise<string | null> {
  const { expectedCodes, responseKeyword, responseForbiddenKeyword, responseJsonPath } = monitor;
  const { status } = reply;

  if (expectedCodes) {
    if (!expectedCodes.includes(status)) {
      return `Expected status ${expectedCodes.join('|')}, got ${status}`;
    }
  } else if (status < 200 || status > 299) {
    return `Expected 2xx status, got ${status}`;
  }

  for (const [name, expected] of Object.entries(monitor.responseHeaderEquals ?? {})) {
    const actual = reply.headers.get(name);
    if (actual == null) return `Header "${name}" not found in response`;
    if (actual !== expected) return `Header "${name}" does not have the expected value`;
  }

  if (!responseKeyword && !responseForbiddenKeyword && responseJsonPath === undefined) return null;
  const body = await readTextUpTo(reply, MAX_BODY_BYTES);

  if (responseKeyword && !body.includes(responseKeyword)) {
    return `Required keyword "${responseKeyword}" not found in response`;
  }

  if (responseForbiddenKeyword && body.includes(responseForbiddenKeyword)) {
    return `Forbidden keyword "${responseForbiddenKeyword}" found in response`;
  }

  if (responseJsonPath !== undefined) {
    // A body that fills the cap may have been cut short, and a cut body is not the JSON sent.
    if (new TextEncoder().encode(body).byteLength >= MAX_BODY_BYTES) {
      return `Response is too large to check ${responseJsonPath}`;
    }
    const keys = jsonPathKeys(responseJsonPath);
    if (!keys) return `responseJsonPath ${responseJsonPath} is not a $.a.b[0] path`;
    let document: unknown;
    try {
      document = JSON.parse(body);
    } catch {
      return 'Response is not valid JSON';
    }
    const value = valueAt(document, keys);
    if (value === undefined) return `JSON path ${responseJsonPath} not found in response`;
    if (value !== monitor.responseJsonValue) {
      return `JSON value at ${responseJsonPath} is not ${JSON.stringify(monitor.responseJsonValue)}`;
    }
  }

  return null;
}

export function parseTcpTarget(target: string) {
  const url = new URL(`tcp://${target}`);
  if (!url.hostname) {
    throw new Error('Invalid TCP target hostname');
  }

  if (!url.port) {
    throw new Error('TCP target must include a port (hostname:port)');
  }

  const port = Number(url.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid TCP port: ${url.port}`);
  }

  return { hostname: url.hostname, port };
}

export function success(latency: number, ssl?: SSLCertificateInfo): CheckSuccess {
  if (ssl) {
    return { latency, ok: true, ssl };
  }
  return { latency, ok: true };
}

export function failure(error: string, latency?: number): CheckFailure {
  if (latency !== undefined) {
    return { error, latency, ok: false };
  }
  return { error, ok: false };
}
