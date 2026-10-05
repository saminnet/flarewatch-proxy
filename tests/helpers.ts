import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onTestFinished } from 'vite-plus/test';
import type { CheckResult } from '../src/types';

export function errorOf(result: CheckResult): string {
  if (result.ok) throw new Error('Expected the check to fail');
  return result.error;
}

type CertName = 'trusted' | 'untrusted';

interface Pem {
  cert: string;
  key: string;
}

/** Different lifetimes, so a test can tell by the expiry which certificate a check read. */
const CERT_DAYS: Record<CertName, number> = { trusted: 3650, untrusted: 7300 };

const pems = new Map<CertName, Pem>();

function generate(name: CertName): Pem {
  const dir = mkdtempSync(join(tmpdir(), 'flarewatch-proxy-cert-'));
  const cert = join(dir, 'cert.pem');
  const key = join(dir, 'key.pem');
  const args = [
    ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert],
    ['-days', String(CERT_DAYS[name]), '-subj', `/O=FlareWatch Test ${name}/CN=localhost`],
    ['-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'],
  ].flat();
  try {
    execFileSync('openssl', args, { stdio: 'pipe' });
    return { cert: readFileSync(cert, 'utf8'), key: readFileSync(key, 'utf8') };
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new Error('The SSL tests make their certificates with the openssl command: install it');
    }
    throw error;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function certificate(name: CertName): Pem {
  let pem = pems.get(name);
  if (!pem) {
    pem = generate(name);
    pems.set(name, pem);
  }
  return pem;
}

export async function listen(server: net.Server): Promise<number> {
  server.listen(0, 'localhost');
  await once(server, 'listening');
  onTestFinished(() => {
    if (server instanceof http.Server) server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected a TCP address');
  return address.port;
}

export async function startHttp(handler: http.RequestListener): Promise<string> {
  return `http://localhost:${await listen(http.createServer(handler))}`;
}

export async function startHttps(
  certName: CertName,
  handler: http.RequestListener,
): Promise<string> {
  return `https://localhost:${await listen(https.createServer(certificate(certName), handler))}`;
}

export async function closedPort(): Promise<number> {
  const server = net.createServer();
  const port = await listen(server);
  server.close();
  await once(server, 'close');
  return port;
}
