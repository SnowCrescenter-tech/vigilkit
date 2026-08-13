// vigilkit basic example server.
//
// Serves the built app from ./dist and streams the bundled FLV fixture over
// WebSocket at ws://<host>/live in paced 64 KiB binary chunks (~1.6 MB/s),
// which keeps the stream comfortably real-time for the 512 KB clip. The HEVC
// FLV fixture is served at ws://<host>/live-hevc: the FLV header plus the
// leading script + sequence-header tags are sent once, then only the coded
// frames are replayed (--loop). Replaying the header mid-stream desyncs the
// FLV demuxer, and re-sending the hvcC sequence header would make the engine
// replace the soft decoder on every pass. Each replayed pass has its tag
// timestamps shifted forward (330 ms per pass), so the loop reads as a live
// stream with advancing PTS — the engine's scheduler drops chunks more than
// 1 s late, and the fixture's timestamps would otherwise repeat forever.
//
// Usage:
//   node server.mjs                # port 8080, play the clip once
//   node server.mjs --port 9000 --loop   # repeat the stream forever
//   node server.mjs --coop         # also send COOP:same-origin + COEP:require-corp
//                                  # (needed only if a cross-origin-isolated demo
//                                  #  or SAB-dependent worker path is required)

import { createServer } from 'node:http';
import { readFileSync, realpathSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';

/**
 * Cross-Origin-Isolated headers. Enabled via --coop. They make SharedArrayBuffer
 * available and are the standard precondition for any Emscripten pthread build;
 * the vendored libde265 build is single-threaded (no SAB/Atomics in the dist),
 * so this is an opt-in compatibility surface rather than a requirement.
 */
const COOP_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

const PACKAGE_DIR = fileURLToPath(new URL('.', import.meta.url));
const DIST_DIR = resolve(PACKAGE_DIR, 'dist');
const FIXTURE_PATH = resolve(PACKAGE_DIR, 'fixtures', 'Enigma_Principles_of_Lust-part.flv');
const HEVC_FLV_FIXTURE_PATH = resolve(PACKAGE_DIR, 'hevc-fixtures', 'flv-hevc.flv');

const CHUNK_SIZE = 65536;
const CHUNK_INTERVAL_MS = 40;
/** Faster pass cycle for /live-hevc (see the header comment). */
const HEVC_CHUNK_INTERVAL_MS = 20;
/** PTS advance per /live-hevc loop pass — beyond the fixture's ~300 ms span. */
const PASS_PTS_MS = 330;
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
};

// Demo asset aliases, resolved before the dist fallback. Each route is rooted
// in its own directory with a dedicated MIME map (the wasm MIME is critical
// for instantiation).
const ALIAS_ROUTES = [
  {
    prefix: '/hls/',
    root: resolve(PACKAGE_DIR, 'hls-fixtures'),
    mimes: {
      '.m3u8': 'application/vnd.apple.mpegurl',
      '.ts': 'video/mp2t',
    },
  },
  {
    prefix: '/hevc/',
    root: resolve(PACKAGE_DIR, 'hevc-fixtures'),
    mimes: {
      '.hevc': 'video/hevc',
      '.flv': 'video/x-flv',
    },
  },
  {
    prefix: '/vendor/',
    root: resolve(PACKAGE_DIR, 'vendor'),
    mimes: {
      '.js': 'text/javascript; charset=utf-8',
      '.wasm': 'application/wasm',
    },
  },
];

function resolveAlias(pathname) {
  for (const route of ALIAS_ROUTES) {
    if (!pathname.startsWith(route.prefix)) {
      continue;
    }
    const relative = pathname.slice(route.prefix.length);
    const filePath = resolve(route.root, relative);
    if (filePath !== route.root && !filePath.startsWith(route.root + sep)) {
      return null; // path traversal
    }
    return { filePath, root: route.root, mimes: route.mimes };
  }
  return null;
}

function parseArgs(argv) {
  const args = { port: 8080, loop: false, coop: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--loop') {
      args.loop = true;
    } else if (arg === '--coop') {
      args.coop = true;
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
const hevcFlvFixture = readFileSync(HEVC_FLV_FIXTURE_PATH);

/**
 * Starts a paced WS stream on an accepted socket. When `bodyOnly` is set
 * (HEVC FLV), the first pass ships the full file and every loop pass replays
 * only the tag body AFTER the leading script + sequence-header tags:
 * replaying the FLV header mid-stream desyncs the demuxer (it would silently
 * stall), and re-sending the hvcC sequence header would make the engine
 * re-configure — and replace — the soft decoder on every pass, discarding
 * all in-flight decode state. The header's dataOffset (u32 at bytes 5..8)
 * is read from the fixture rather than assumed to be 9.
 */
function startStream(socket, fixtureBytes, streamName, chunkIntervalMs, bodyOnly) {
  const dataOffset = ((fixtureBytes[5] << 24) | (fixtureBytes[6] << 16) | (fixtureBytes[7] << 8) | fixtureBytes[8]) >>> 0;
  const tagsStart = dataOffset + 4;
  let body = null;
  if (bodyOnly) {
    // Walk past the script (metadata) tag and the sequence-header tag: both
    // lead each pass. Metadata replays are harmless; the sequence header is
    // skipped for the decoder-lifetime reason above.
    let pos = tagsStart;
    for (let i = 0; i < 2; i += 1) {
      const dataSize = ((fixtureBytes[pos + 1] << 16) | (fixtureBytes[pos + 2] << 8) | fixtureBytes[pos + 3]);
      pos += 11 + dataSize + 4;
    }
    body = fixtureBytes.subarray(pos);
  }
  let source = fixtureBytes;
  let offset = 0;
  let pass = 0;
  let timer = null;

  const stop = () => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  /**
   * Copies `buffer` with every tag's 3-byte timestamp shifted by `offsetMs`.
   * The HEVC fixture's tags repeat their timestamps on every loop pass; the
   * engine's scheduler drops chunks more than 1 s late, so a replayed pass
   * must look like a live stream with advancing PTS or almost nothing would
   * decode. Offsets stay far below the 24-bit timestamp range.
   */
  const shiftTagTimestamps = (buffer, offsetMs) => {
    if (offsetMs === 0) {
      return buffer;
    }
    const out = Buffer.from(buffer);
    let pos = 0;
    while (pos + 11 <= out.length) {
      const dataSize = (out[pos + 1] << 16) | (out[pos + 2] << 8) | out[pos + 3];
      if (pos + 11 + dataSize + 4 > out.length) {
        break;
      }
      const ts = out[pos + 4] | (out[pos + 5] << 8) | (out[pos + 6] << 16);
      const shifted = ts + offsetMs;
      if (shifted < 0xffffff) {
        out[pos + 4] = shifted & 0xff;
        out[pos + 5] = (shifted >> 8) & 0xff;
        out[pos + 6] = (shifted >> 16) & 0xff;
      }
      pos += 11 + dataSize + 4;
    }
    return out;
  };

  const sendChunk = () => {
    if (socket.readyState !== WebSocket.OPEN) {
      stop();
      return;
    }
    if (offset >= source.length) {
      if (!args.loop) {
        stop();
        socket.close(1000, 'end of stream');
        return;
      }
      pass += 1;
      if (body !== null) {
        source = shiftTagTimestamps(body, pass * PASS_PTS_MS);
      }
      offset = 0;
      console.log(`[vigilkit] ws ${streamName}: stream restarted (loop, pass ${pass})`);
    }
    const end = Math.min(offset + CHUNK_SIZE, source.length);
    socket.send(source.subarray(offset, end));
    offset = end;
  };

  socket.on('close', stop);
  socket.on('error', stop);
  timer = setInterval(sendChunk, chunkIntervalMs);
  sendChunk();
}

/** Merges the COOP/COEP headers into a response header object when --coop is set. */
function withCoop(headers) {
  if (!args.coop) {
    return headers;
  }
  return { ...COOP_HEADERS, ...headers };
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (url.pathname === '/healthz') {
    res.writeHead(200, withCoop({ 'Content-Type': 'text/plain; charset=utf-8' }));
    res.end('ok');
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, withCoop({ 'Content-Type': 'text/plain; charset=utf-8' }));
    res.end('method not allowed');
    return;
  }

  const alias = resolveAlias(url.pathname);
  const filePath = alias !== null ? alias.filePath : resolveStatic(url.pathname);
  let data = null;
  if (filePath !== null) {
    try {
      // Realpath check: the string-prefix guards prevent `..` escapes, but a
      // symlink inside a served root pointing outside it would still be read.
      // Resolve the canonical path and confirm it stays under the allowed root.
      const root = alias !== null ? alias.root : resolve(DIST_DIR);
      const real = realpathSync(filePath);
      if (real === root || real.startsWith(root + sep)) {
        data = readFileSync(real);
      }
    } catch {
      data = null;
    }
  }
  if (data === null) {
    res.writeHead(404, withCoop({ 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' }));
    res.end('not found');
    return;
  }

  const mimes = alias !== null ? alias.mimes : MIME_TYPES;
  const mime = mimes[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, withCoop({ 'Content-Type': mime, 'Content-Length': data.length, 'X-Content-Type-Options': 'nosniff' }));
  res.end(data);
});

// One WebSocketServer for both stream endpoints, routed by pathname: ws v8.18
// corrupts connections when two WSS instances share one HTTP server (verified
// empirically — a second instance 400s non-matching upgrades and garbles the
// first instance's frames).
const wss = new WebSocketServer({ server });

wss.on('connection', (socket, req) => {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (pathname === '/live-hevc') {
    startStream(socket, hevcFlvFixture, '/live-hevc', HEVC_CHUNK_INTERVAL_MS, true);
  } else {
    startStream(socket, fixture, '/live', CHUNK_INTERVAL_MS, false);
  }
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
  console.log(`[vigilkit] hevc fixture: ${HEVC_FLV_FIXTURE_PATH} (${hevcFlvFixture.length} bytes)`);
  console.log(
    `[vigilkit] ws stream: ws://localhost:${args.port}/live${args.loop ? ' (loop)' : ''}`
  );
  console.log(
    `[vigilkit] ws stream: ws://localhost:${args.port}/live-hevc (FLV tag-body loop, ${HEVC_CHUNK_INTERVAL_MS} ms chunks)${args.loop ? ' (loop)' : ''}`
  );
  console.log('[vigilkit] routes: /hls/* -> hls-fixtures/ (m3u8, ts), /hevc/* -> hevc-fixtures/ (hevc, flv), /vendor/* -> vendor/ (js, wasm)');
  if (args.coop) {
    console.log('[vigilkit] COOP: same-origin + COEP: require-corp enabled on all responses');
  }
});
