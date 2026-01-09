import { createServer, IncomingMessage, ServerResponse } from 'http';
import { readFile, stat } from 'fs/promises';
import { join, extname } from 'path';
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

async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url || '/';
  let filePath = url === '/' ? '/index.html' : url;

  // Remove query string
  filePath = filePath.split('?')[0];

  // Security: prevent directory traversal
  if (filePath.includes('..')) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const fullPath = join(DIST, filePath);

  try {
    // Check if file exists
    await stat(fullPath);
    const content = await readFile(fullPath);
    const ext = extname(filePath).toLowerCase();
    const mimeType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': mimeType,
      'Cache-Control': 'no-cache',
    });
    res.end(content);
  } catch {
    // SPA fallback: serve index.html for client-side routing
    try {
      const index = await readFile(join(DIST, 'index.html'));
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      res.end(index);
    } catch {
      res.writeHead(404);
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
