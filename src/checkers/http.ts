import { Agent } from 'undici';
import { createLogger } from '../log';
import type { CheckResult, MonitorTarget } from '../types';
import {
  DEFAULT_HTTP_TIMEOUT,
  DEFAULT_SSL_EXPIRY_THRESHOLD_DAYS,
  failure,
  fetchWithTimeout,
  getErrorMessage,
  isTimeoutError,
  networkErrorMessage,
  success,
  toHeaders,
  validateHttpResponse,
} from '../utils';
import { checkSSLCertificate } from './ssl';

const log = createLogger('HTTP');

const USER_AGENT = 'FlareWatch-Proxy/1.0 (+https://github.com/saminnet/flarewatch)';

/** Node's fetch takes TLS settings only from a dispatcher, never from the request. */
const acceptAnyCertificate = new Agent({ connect: { rejectUnauthorized: false } });

export interface HttpCheckDeps {
  readonly fetch: typeof fetchWithTimeout;
  readonly checkSSLCertificate: typeof checkSSLCertificate;
}

export async function checkHttp(
  target: MonitorTarget,
  deps: HttpCheckDeps = { fetch: fetchWithTimeout, checkSSLCertificate },
): Promise<CheckResult> {
  const startTime = performance.now();
  const timeout = target.timeout ?? DEFAULT_HTTP_TIMEOUT;
  const timedOut = (latency: number) => {
    log.info('Timeout', { name: target.name, latency });
    return failure(`Timeout after ${timeout}ms`, latency);
  };

  try {
    const headers = toHeaders(target.headers);
    if (!headers.has('user-agent')) {
      headers.set('user-agent', USER_AGENT);
    }

    const response = await deps.fetch(target.target, {
      method: target.method || 'GET',
      headers,
      body: target.body,
      timeout,
      dispatcher: target.sslIgnoreSelfSigned ? acceptAnyCertificate : undefined,
    });

    const latency = Math.round(performance.now() - startTime);
    log.info('Response', { name: target.name, status: response.status, latency });

    const validationError = await validateHttpResponse(target, response);

    await response.body?.cancel().catch(() => {});

    if (validationError) {
      log.info('Validation failed', { name: target.name, error: validationError });
      return failure(validationError, latency);
    }

    // Fetch follows redirects, so read the final hop's certificate; an injected fetch may omit url.
    const finalUrl = response.url || target.target;
    if (!target.sslCheckEnabled || URL.parse(finalUrl)?.protocol !== 'https:') {
      return success(latency);
    }

    const timeLeft = timeout - (performance.now() - startTime);
    if (timeLeft <= 0) {
      return timedOut(latency);
    }

    const threshold = target.sslCheckDaysBeforeExpiry ?? DEFAULT_SSL_EXPIRY_THRESHOLD_DAYS;
    try {
      const sslInfo = await deps.checkSSLCertificate(finalUrl, {
        ignoreSelfSigned: target.sslIgnoreSelfSigned ?? false,
        timeout: timeLeft,
      });

      log.info('SSL expiry', { name: target.name, daysUntilExpiry: sslInfo.daysUntilExpiry });

      if (sslInfo.daysUntilExpiry <= threshold) {
        return failure(
          `SSL certificate expires in ${sslInfo.daysUntilExpiry} days (threshold: ${threshold})`,
          latency,
        );
      }

      return success(latency, sslInfo);
    } catch (sslError) {
      const sslErrorMessage = getErrorMessage(sslError);
      if (isTimeoutError(sslErrorMessage)) {
        return timedOut(latency);
      }
      log.warn('SSL check failed', { name: target.name, error: sslErrorMessage });
      return failure(`SSL check failed: ${sslErrorMessage}`, latency);
    }
  } catch (error) {
    const latency = Math.round(performance.now() - startTime);

    if (isTimeoutError(getErrorMessage(error))) {
      return timedOut(latency);
    }

    const errorMessage = networkErrorMessage(error);
    log.info('Error', { name: target.name, error: errorMessage });
    return failure(errorMessage, latency);
  }
}
