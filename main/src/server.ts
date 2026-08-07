import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DriverRegistry } from '@custos/core';
import { AzureSqlDriver } from '@custos/driver-azuresql';
import { MySqlDriver } from '@custos/driver-mysql';
import type { CustosApiMethod } from '@custos/shared';
import { ConnectionManager, InMemorySecretStore } from './engine';
import { JsonConnectionStore } from './store/json-connection-store';
import { createDispatcher } from './dispatch';

/**
 * Custos web host: serves the built Angular UI and brokers real database
 * connections over HTTP, so Custos runs in a browser without the Electron
 * desktop shell. Bind to localhost only — this process holds live DB
 * connections and secrets.
 *
 *   node main/dist/server.js         # then open http://127.0.0.1:4174
 *
 * Secrets are kept in memory only (re-enter after a restart); connection
 * metadata persists under CUSTOS_DATA_DIR (default ~/.custos).
 */

const PORT = Number(process.env.CUSTOS_PORT ?? 4174);
const HOST = '127.0.0.1';
const DATA_DIR = process.env.CUSTOS_DATA_DIR ?? path.join(os.homedir(), '.custos');
const RENDERER_DIST = path.join(__dirname, '..', '..', 'renderer', 'dist', 'custos', 'browser');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json',
  '.png': 'image/png',
};

function buildManager(): ConnectionManager {
  const registry = new DriverRegistry();
  registry.register(new MySqlDriver());
  registry.register(new AzureSqlDriver());
  return new ConnectionManager(
    registry,
    new JsonConnectionStore(path.join(DATA_DIR, 'connections.json')),
    new InMemorySecretStore(),
  );
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 8 * 1024 * 1024) reject(new Error('Request body too large'));
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// Security headers for the served document. The CSP mirrors the <meta> baked
// into index.html (which is what protects the Electron file:// load, where
// there are no HTTP headers) and additionally sets frame-ancestors, which a
// <meta> CSP cannot. The web host is localhost-only, but this keeps a stray
// browser tab from framing it or sniffing content types.
const SECURITY_HEADERS: http.OutgoingHttpHeaders = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "font-src 'self'; img-src 'self' data:; connect-src 'self'; " +
    "worker-src 'self' blob:; object-src 'none'; base-uri 'self'; " +
    "form-action 'none'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

/** Serve a static file from the renderer build; inject the web-mode flag into index.html. */
function serveStatic(urlPath: string, res: http.ServerResponse): void {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath.replace(/^\/+/, ''));
  // Prevent path traversal outside the renderer dist.
  const filePath = path.normalize(path.join(RENDERER_DIST, rel));
  if (!filePath.startsWith(RENDERER_DIST)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA fallback → index.html (so client routes resolve).
      if (rel !== 'index.html') return serveStatic('/', res);
      res.writeHead(404).end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.html') {
      // Mark web-host mode with a <meta> tag rather than an inline <script>,
      // so the strict `script-src 'self'` CSP needs no inline-script exception.
      const html = data
        .toString('utf8')
        .replace('</head>', '<meta name="custos-host" content="http"></head>');
      res.writeHead(200, { 'Content-Type': MIME['.html']!, ...SECURITY_HEADERS }).end(html);
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' }).end(data);
  });
}

function main(): void {
  // Last-resort guards. A driver (or one of its dependencies) can throw
  // asynchronously outside any request's await chain — tedious, for instance,
  // can throw during its login handshake. On a localhost dev tool it is far
  // better to log and keep serving than to let one bad connection take the whole
  // host down. The request that triggered it still fails or times out; the
  // server survives for every other tab. (Driver inputs are validated up front,
  // so this should rarely fire — it is a backstop, not the primary defense.)
  process.on('uncaughtException', (err) => {
    // eslint-disable-next-line no-console
    console.error('[custos] Uncaught exception — server kept alive:', err);
  });
  process.on('unhandledRejection', (reason) => {
    // eslint-disable-next-line no-console
    console.error('[custos] Unhandled rejection — server kept alive:', reason);
  });

  const dispatch = createDispatcher(buildManager());

  const server = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/api') {
      try {
        const { method, args } = JSON.parse(await readBody(req)) as {
          method: CustosApiMethod;
          args: unknown[];
        };
        const result = await dispatch(method, Array.isArray(args) ? args : []);
        res.writeHead(200, { 'Content-Type': MIME['.json']! }).end(JSON.stringify(result));
      } catch {
        res
          .writeHead(400, { 'Content-Type': MIME['.json']! })
          .end(JSON.stringify({ ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid request' } }));
      }
      return;
    }
    if (req.method === 'GET' && req.url) {
      serveStatic(req.url.split('?')[0]!, res);
      return;
    }
    res.writeHead(405).end('Method not allowed');
  });

  server.listen(PORT, HOST, () => {
    // eslint-disable-next-line no-console
    console.log(`\n  Custos web  →  http://${HOST}:${PORT}\n  (data: ${DATA_DIR} · secrets in memory · localhost only)\n`);
  });
}

main();
