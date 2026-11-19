import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { RhythmSession } from './lib/session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const SHARED_DIR = path.join(__dirname, 'lib');
const PORT = Number(process.env.PORT) || 8080;
const TICK_MS = 25;
const HEARTBEAT_MS = 15000;
const MAX_BODY = 16 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml'
};

// Monotonic clock in seconds on an absolute origin (timeOrigin + now). The
// browser's performance clock shares this convention, so offset measurements
// compare like with like; clients never depend on the process start time.
const serverOrigin = performance.timeOrigin || Date.now();
const session = new RhythmSession(() => (serverOrigin + performance.now()) / 1000);
const subscribers = new Set();

function broadcast(evt) {
  const line = `event: ${evt.type}\ndata: ${JSON.stringify(evt.data)}\n\n`;
  for (const res of subscribers) res.write(line);
}

setInterval(() => {
  session.tick();
  for (const evt of session.takeEvents()) broadcast(evt);
}, TICK_MS).unref();

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body-too-large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch { reject(new Error('bad-json')); }
    });
    req.on('error', reject);
  });
}

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let baseDir = PUBLIC_DIR;
  let rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  if (rel.startsWith('lib/')) {
    baseDir = SHARED_DIR;
    rel = rel.slice(4);
  }
  const filePath = path.join(baseDir, rel);
  if (!filePath.startsWith(baseDir)) {
    json(res, 403, { error: 'forbidden' });
    return;
  }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    json(res, 404, { error: 'not-found' });
  }
}

function handleSse(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive'
  });
  res.write(`event: snapshot\ndata: ${JSON.stringify(session.snapshot())}\n\n`);
  subscribers.add(res);
  const heartbeat = setInterval(() => res.write(': hb\n\n'), HEARTBEAT_MS);
  req.on('close', () => {
    clearInterval(heartbeat);
    subscribers.delete(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/events') return handleSse(req, res);

    if (req.method === 'POST' && url.pathname === '/api/register') {
      const body = await readBody(req);
      const id = String(body.id || `c${Math.random().toString(36).slice(2, 10)}`).slice(0, 64);
      if (session.clients.has(id)) return json(res, 409, { error: 'id-taken' });
      const client = session.registerClient({
        id, name: body.name, outUnc: body.outUnc, inUnc: body.inUnc
      });
      for (const evt of session.takeEvents()) broadcast(evt);
      return json(res, 200, { client: session._clientView(client), now: session.now() });
    }

    if (req.method === 'POST' && url.pathname === '/api/sync-ping') {
      const body = await readBody(req);
      const out = session.handleSyncPing(String(body.clientId), Number(body.t0));
      return json(res, out.error ? 400 : 200, out);
    }

    if (req.method === 'POST' && url.pathname === '/api/sync-complete') {
      const body = await readBody(req);
      const out = session.handleSyncComplete(String(body.clientId), body);
      if (!out.error) for (const evt of session.takeEvents()) broadcast(evt);
      return json(res, out.error ? 400 : 200, out);
    }

    if (req.method === 'POST' && url.pathname === '/api/hit') {
      const body = await readBody(req);
      const out = session.handleHit(String(body.clientId), body);
      for (const evt of session.takeEvents()) broadcast(evt);
      return json(res, 200, out);
    }

    if (req.method === 'POST' && url.pathname === '/api/round/start') {
      const body = await readBody(req);
      const round = session.startRound({ startDelay: Number(body.startDelay) || 0.6 });
      for (const evt of session.takeEvents()) broadcast(evt);
      return json(res, 200, { round: session._roundView(round) });
    }

    if (req.method === 'GET' && url.pathname === '/api/snapshot') {
      return json(res, 200, session.snapshot());
    }

    if (req.method === 'GET') return serveStatic(req, res);
    json(res, 405, { error: 'method-not-allowed' });
  } catch (err) {
    json(res, 400, { error: err.message || 'bad-request' });
  }
});

server.listen(PORT, () => {
  console.log(`ensemble judgment server on http://localhost:${PORT}`);
});
