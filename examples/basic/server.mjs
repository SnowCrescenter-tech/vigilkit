// vigilkit basic example server.
//
// Serves the built app from ./dist and streams the bundled FLV fixture over
// WebSocket at ws://<host>/live in paced 64 KiB binary chunks (~1.6 MB/s),
// which keeps the stream comfortably real-time for the 512 KB clip.
//
// Usage:
//   node server.mjs                # port 8080, play the clip once
//   node server.mjs --port 9000 --loop   # repeat the stream forever

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';

const PACKAGE_DIR = fileURLToPath(new URL('.', import.meta.url));
const DIST_DIR = resolve(PACKAGE_DIR, 'dist');
const FIXTURE_PATH = resolve(PACKAGE_DIR, 'fixtures', 'Enigma_Principles_of_Lust-part.flv');

const CHUNK_SIZE = 65536;
const CHUNK_INTERVAL_MS = 40;
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
};

function parseArgs(argv) {
  const args = { port: 8080, loop: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--loop') {
      args.loop = true;
    } else if (arg === '--port') {
      const raw = argv[i + 1];
      if (raw === undefined || !/^\d+$/.test(raw)) {
        throw new Error(`--port expects a numeric value, got ${String(raw)}`);
      }
      args.port = Number(raw);
      i += 1;
    } else if (arg.startsWith('--port=')) {
      const raw = arg.slice('--port='.length);
      if (!/^\d+$/.test(raw)) {
        throw new Error(`--port expects a numeric value, got ${raw}`);
      }
      args.port = Number(raw);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

function resolveStatic(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const filePath = resolve(DIST_DIR, relative);
  const root = resolve(DIST_DIR);
  if (filePath !== root && !filePath.startsWith(root + sep)) {
    return null; // path traversal
  }
  return filePath;
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error(`[vigilkit] ${err.message}`);
  process.exit(2);
}

const fixture = readFileSync(FIXTURE_PATH);

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('ok');
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('method not allowed');
    return;
  }

  const filePath = resolveStatic(url.pathname);
  let data = null;
  if (filePath !== null) {
    try {
      data = readFileSync(filePath);
    } catch {
      data = null;
    }
  }
  if (data === null) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }

  const mime = MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime, 'Content-Length': data.length });
  res.end(data);
});

const wss = new WebSocketServer({ server, path: '/live' });

wss.on('connection', (socket) => {
  let offset = 0;
  let timer = null;

  const stop = () => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  const sendChunk = () => {
    if (socket.readyState !== WebSocket.OPEN) {
      stop();
      return;
    }
    if (offset >= fixture.length) {
      if (args.loop) {
        offset = 0;
        console.log('[vigilkit] ws /live: stream restarted (loop)');
      } else {
        stop();
        socket.close(1000, 'end of stream');
        return;
      }
    }
    const end = Math.min(offset + CHUNK_SIZE, fixture.length);
    socket.send(fixture.subarray(offset, end));
    offset = end;
  };

  socket.on('close', stop);
  socket.on('error', stop);
  timer = setInterval(sendChunk, CHUNK_INTERVAL_MS);
  sendChunk();
});

server.on('error', (err) => {
  console.error(`[vigilkit] ${err.message}`);
  process.exit(1);
});

process.on('SIGINT', () => {
  wss.close();
  server.close(() => process.exit(0));
});

server.listen(args.port, () => {
  console.log(`[vigilkit] example server listening on http://localhost:${args.port}`);
  console.log(`[vigilkit] fixture: ${FIXTURE_PATH} (${fixture.length} bytes)`);
  console.log(
    `[vigilkit] ws stream: ws://localhost:${args.port}/live${args.loop ? ' (loop)' : ''}`
  );
});
