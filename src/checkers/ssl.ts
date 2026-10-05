import { isIP } from 'node:net';
import type { SSLCertificateInfo } from '../types';
import { DEFAULT_HTTP_TIMEOUT, withTimeout } from '../utils';

export interface SSLCheckOptions {
  ignoreSelfSigned?: boolean;
  timeout?: number;
}

/** Node returns an array when a certificate repeats an attribute. */
function certField(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(', ') : value;
}

export async function checkSSLCertificate(
  url: string,
  options: SSLCheckOptions = {},
): Promise<SSLCertificateInfo> {
  const { ignoreSelfSigned = false, timeout = DEFAULT_HTTP_TIMEOUT } = options;

  const tls = await import('node:tls').catch(() => null);

  if (!tls) {
    throw new Error('SSL checks require Node.js runtime (tls module not available)');
  }

  const parsedUrl = new URL(url);
  const hostname = parsedUrl.hostname.replace(/^\[|\]$/g, '');
  const port = parsedUrl.port ? Number(parsedUrl.port) : 443;

  const checkPromise = new Promise<SSLCertificateInfo>((resolve, reject) => {
    const socket = tls.connect(
      {
        host: hostname,
        port,
        ...(isIP(hostname) ? {} : { servername: hostname }),
        rejectUnauthorized: !ignoreSelfSigned,
      },
      () => {
        try {
          const cert = socket.getPeerCertificate();

          if (!cert || Object.keys(cert).length === 0) {
            socket.destroy();
            reject(new Error('No certificate received'));
            return;
          }

          if (!cert.valid_to) {
            socket.destroy();
            reject(new Error('Certificate missing valid_to field'));
            return;
          }

          const expiryDate = new Date(cert.valid_to).getTime();
          const now = Date.now();
          const daysUntilExpiry = Math.floor((expiryDate - now) / (1000 * 60 * 60 * 24));

          socket.destroy();

          resolve({
            expiryDate: Math.floor(expiryDate / 1000),
            daysUntilExpiry,
            issuer: certField(cert.issuer?.O ?? cert.issuer?.CN),
            subject: certField(cert.subject?.CN),
          });
        } catch (err) {
          socket.destroy();
          reject(err);
        }
      },
    );

    socket.on('error', (err) => {
      socket.destroy();
      reject(err);
    });

    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('SSL connection timeout'));
    });

    socket.setTimeout(timeout);
  });

  return withTimeout(checkPromise, timeout);
}
