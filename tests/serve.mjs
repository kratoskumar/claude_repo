// Static server that mimics GitHub Pages: app served from docs/ under /claude_repo/.
// With { emulator: true } it swaps config.js for one that points at the local Firebase emulator.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../docs/', import.meta.url));
export const BASE = '/claude_repo/';
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png'
};
export const emuConfig = (ownerUid = '') => `export const FIREBASE = { apiKey: 'demo-key', authDomain: 'demo-mc.firebaseapp.com', projectId: 'demo-mc', appId: '1:1:web:1' };
export const OWNER_UID = '${ownerUid}';
export const CANONICAL_HOST = '';
export const FORWARD_FROM = [];
export const EMULATOR = { auth: 'http://127.0.0.1:9099', host: '127.0.0.1', port: 8080 };`;

export const BLANK_CONFIG = `export const FIREBASE = { apiKey: '', authDomain: '', projectId: '', appId: '' };
export const OWNER_UID = '';
export const CANONICAL_HOST = '';
export const FORWARD_FROM = [];
export const EMULATOR = null;`;

// config: by default the app gets a blank config (never the real Firebase project);
// realConfig: true serves docs/config.js as committed.
export function start({ port = 0, emulator = false, ownerUid = '', overrides = {}, realConfig = false } = {}) {
  const server = http.createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (!path.startsWith(BASE)) { res.writeHead(404).end('not found'); return; }
    let rel = path.slice(BASE.length) || 'index.html';
    if (rel.endsWith('/')) rel += 'index.html';
    const file = normalize(join(ROOT, rel));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    try {
      let body = overrides[rel] ?? (rel === 'config.js' && !realConfig ? (emulator ? emuConfig(ownerUid) : BLANK_CONFIG) : await readFile(file));
      // Let the page reach the local emulator; the rest of the security policy stays enforced.
      if (emulator && rel === 'index.html') body = String(body).replace("connect-src 'self'", "connect-src 'self' http://127.0.0.1:9099 http://127.0.0.1:8080").replace("frame-src 'self'", "frame-src 'self' http://127.0.0.1:9099");
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'max-age=600' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise(r => server.listen(port, '127.0.0.1', () => r({ server, url: `http://127.0.0.1:${server.address().port}${BASE}` })));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { url } = await start({ port: Number(process.env.PORT) || 8000 });
  console.log('Serving', url);
}
