import { createServer, IncomingMessage, ServerResponse } from 'http';
import { readFile, stat } from 'fs/promises';
import { join, extname, resolve, relative, isAbsolute } from 'path';
import open from 'open';

const PORT = parseInt(process.env.PORT || '3847', 10);
const DIST = join(import.meta.dirname, '../dist');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

// Resolve DIST to absolute path for security checks
const DIST_RESOLVED = resolve(DIST);

// Security headers
const SECURITY_HEADERS: Record<string, string> = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' ws: wss:; frame-ancestors 'none';",
};

async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url || '/';
  let filePath = url === '/' ? '/index.html' : url;

  // Remove query string
  filePath = filePath.split('?')[0];

  // Decode URL to handle encoded characters (e.g., %2e%2e for ..)
  try {
    filePath = decodeURIComponent(filePath);
  } catch {
    res.writeHead(400, SECURITY_HEADERS);
    res.end('Bad Request');
    return;
  }

  // Security: prevent directory traversal using path resolution.
  //
  // Two-step check that CodeQL's `js/path-injection` analysis recognizes:
  //   1. resolve() — collapse `..` and produce an absolute path
  //   2. relative() — re-express it relative to DIST_RESOLVED; if the
  //      result starts with `..` or is itself absolute, the original path
  //      escaped DIST_RESOLVED.
  // The earlier `startsWith(DIST_RESOLVED + '/')` check is correct in
  // practice but isn't recognized as a sanitizer by CodeQL.
  const fullPath = resolve(DIST_RESOLVED, '.' + filePath);
  const rel = relative(DIST_RESOLVED, fullPath);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    res.writeHead(403, SECURITY_HEADERS);
    res.end('Forbidden');
    return;
  }
  // safePath is fullPath rebuilt from a verified-relative input, which
  // CodeQL recognizes as sanitized.
  const safePath = join(DIST_RESOLVED, rel);

  try {
    // Check if file exists
    await stat(safePath);
    const content = await readFile(safePath);
    const ext = extname(filePath).toLowerCase();
    const mimeType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': mimeType,
      'Cache-Control': 'no-cache',
    });
    res.end(content);
  } catch {
    // SPA fallback: serve index.html for client-side routing
    try {
      const index = await readFile(join(DIST, 'index.html'));
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      res.end(index);
    } catch {
      res.writeHead(404, SECURITY_HEADERS);
      res.end('Not Found');
    }
  }
}

const server = createServer(handler);

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n  Zajel Web Client`);
  console.log(`  ────────────────`);
  console.log(`  Local: ${url}\n`);

  // Open browser automatically
  open(url).catch(() => {
    console.log('  Open the URL above in your browser\n');
  });
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n  Shutting down...\n');
  server.close();
  process.exit(0);
});
