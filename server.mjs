import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), 'dist');
const port = Number.parseInt(process.env.PORT || '8080', 10);

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const securityHeaders = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "base-uri 'self'",
    "connect-src 'self'",
    "font-src 'self' data:",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data: blob:",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "worker-src 'self' blob:",
  ].join('; '),
  'Permissions-Policy': 'camera=(), geolocation=(), microphone=()',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

const send = (response, statusCode, body, headers = {}) => {
  response.writeHead(statusCode, {
    ...securityHeaders,
    ...headers,
  });
  response.end(body);
};

const isFile = async (filePath) => {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
};

createServer(async (request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    send(response, 405, 'Method not allowed', {
      Allow: 'GET, HEAD',
      'Content-Type': 'text/plain; charset=utf-8',
    });
    return;
  }

  const requestUrl = new URL(request.url || '/', 'http://localhost');

  if (requestUrl.pathname === '/healthz') {
    send(response, 200, request.method === 'HEAD' ? undefined : 'ok', {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=utf-8',
    });
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(requestUrl.pathname);
  } catch {
    send(response, 400, 'Bad request', {
      'Content-Type': 'text/plain; charset=utf-8',
    });
    return;
  }

  const requestedPath = resolve(root, '.' + pathname);
  const isInsideRoot = requestedPath === root || requestedPath.startsWith(root + sep);

  if (!isInsideRoot) {
    send(response, 404, 'Not found', {
      'Content-Type': 'text/plain; charset=utf-8',
    });
    return;
  }

  const directFile = requestedPath === root ? join(root, 'index.html') : requestedPath;
  const hasDirectFile = await isFile(directFile);
  const filePath = hasDirectFile ? directFile : null;

  if (!filePath || !(await isFile(filePath))) {
    send(response, 404, 'Not found', {
      'Content-Type': 'text/plain; charset=utf-8',
    });
    return;
  }

  try {
    const body = await readFile(filePath);
    const isHashedAsset = filePath.includes(sep + 'assets' + sep);
    send(response, 200, request.method === 'HEAD' ? undefined : body, {
      'Cache-Control': isHashedAsset
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
      'Content-Type': contentTypes[extname(filePath).toLowerCase()] || 'application/octet-stream',
    });
  } catch {
    send(response, 500, 'Internal server error', {
      'Content-Type': 'text/plain; charset=utf-8',
    });
  }
}).listen(port, '0.0.0.0', () => {
  console.log('Weldon demo listening on port ' + port);
});
