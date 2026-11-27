// A throwaway self-signed certificate for "localhost", made with openssl, for testing the certificate check.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';

export function makeCert(days = 90) {
  const dir = mkdtempSync(join(tmpdir(), 'mc-cert-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'),
      '-days', String(days), '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });
    return { key: readFileSync(join(dir, 'k.pem'), 'utf8'), cert: readFileSync(join(dir, 'c.pem'), 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function tlsServer(cert) {
  const server = tls.createServer(cert, s => s.end()).listen(0);
  await new Promise(r => server.once('listening', r));
  return server;
}
