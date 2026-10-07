import crypto from 'node:crypto';
import os from 'node:os';

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '127.0.0.1';
const SECRET = process.env.WOL_SECRET ?? '';
const TARGET_MAC = process.env.WOL_TARGET_MAC ?? '';
const BROADCAST = process.env.WOL_BROADCAST ?? '';
const REPEATS = Number(process.env.WOL_REPEATS ?? 3);

if (!SECRET) {
  console.error('WOL_SECRET is required. Copy .env.example to .env and set it.');
  process.exit(1);
}

const failures = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 8;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest();
}

function constantTimeEquals(a, b) {
  return crypto.timingSafeEqual(sha256(a), sha256(b));
}

function clientIp(req) {
  return req.headers['cf-connecting-ip'] ?? req.socket.remoteAddress ?? 'unknown';
}

function isBlocked(ip) {
  const entry = failures.get(ip);
  if (!entry) return false;
  if (Date.now() - entry.first > WINDOW_MS) {
    failures.delete(ip);
    return false;
  }
  return entry.count >= MAX_FAILURES;
}

function noteFailure(ip) {
  const entry = failures.get(ip);
  if (!entry || Date.now() - entry.first > WINDOW_MS) {
    failures.set(ip, { count: 1, first: Date.now() });
  } else {
    entry.count++;
  }
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleWake(req, res) {
  const ip = clientIp(req);
  if (isBlocked(ip)) {
    return json(res, 429, { ok: false, error: 'Too many failed attempts. Try again in 15 minutes.' });
  }

  let secret;
  try {
    ({ secret } = JSON.parse(await readBody(req)));
  } catch {
    return json(res, 400, { ok: false, error: 'Invalid request body.' });
  }

  if (typeof secret !== 'string' || !constantTimeEquals(secret, SECRET)) {
    noteFailure(ip);
    console.warn(`[${new Date().toISOString()}] rejected wake attempt from ${ip}`);
    return json(res, 401, { ok: false, error: 'Incorrect passphrase.' });
  }

  failures.delete(ip);

  try {
    const { sendMagicPacket } = await import('./wol.js');
    const results = await sendMagicPacket(TARGET_MAC, {
      repeats: REPEATS,
      broadcast: BROADCAST,
    });
    const okCount = results.filter((r) => r.ok).length;
    console.log(`[${new Date().toISOString()}] wake sent from ${ip} to ${TARGET_MAC} (${okCount}/${results.length} datagrams)`);
    return json(res, 200, {
      ok: true,
      mac: TARGET_MAC,
      datagrams: okCount,
      attempted: results.length,
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] wake failed: ${err.message}`);
    return json(res, 500, { ok: false, error: err.message });
  }
}

const server = await import('node:http').then((m) =>
  m.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/healthz') {
      return json(res, 200, { ok: true, mac: TARGET_MAC });
    }

    if (req.method === 'POST' && url.pathname === '/api/wake') {
      return handleWake(req, res);
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      return res.end(page(TARGET_MAC));
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  })
);

server.listen(PORT, HOST, () => {
  console.log(`[${new Date().toISOString()}] wol-web listening on http://${HOST}:${PORT}`);
  console.log(`  target MAC : ${TARGET_MAC || '(not set)'}`);
  console.log(`  broadcast  : ${BROADCAST || 'auto-detect'}`);
  console.log(`  repeats    : ${REPEATS}`);
  console.log(`  hostname   : ${os.hostname()}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}

function page(mac) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Wake PC</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: #0f1115; color: #e6e8eb;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    padding: 1.5rem;
  }
  main { width: 100%; max-width: 26rem; }
  h1 { font-size: 1.35rem; margin: 0 0 .35rem; }
  p.sub { margin: 0 0 1.5rem; color: #8b929c; font-size: .875rem; }
  p.sub code { color: #6ea8fe; }
  label { display: block; font-size: .8125rem; color: #8b929c; margin-bottom: .4rem; }
  input {
    width: 100%; padding: .7rem .8rem; font-size: 1rem;
    background: #171a21; color: #e6e8eb;
    border: 1px solid #2a2f3a; border-radius: .5rem; margin-bottom: 1rem;
  }
  input:focus { outline: 2px solid #3b82f6; outline-offset: -1px; }
  button {
    width: 100%; padding: .85rem; font-size: 1rem; font-weight: 600;
    background: #3b82f6; color: #fff; border: 0; border-radius: .5rem;
    cursor: pointer;
  }
  button:hover:not(:disabled) { background: #2f6fe0; }
  button:disabled { opacity: .55; cursor: not-allowed; }
  #status { margin-top: 1rem; font-size: .875rem; min-height: 1.25rem; color: #8b929c; }
  #status.ok { color: #4ade80; }
  #status.err { color: #f87171; }
</style>
</head>
<body>
  <main>
    <h1>Wake PC</h1>
    <p class="sub">Magic packet to <code>${mac}</code></p>
    <label for="secret">Passphrase</label>
    <input id="secret" type="password" autocomplete="current-password" placeholder="Enter passphrase">
    <button id="wake">Send magic packet</button>
    <div id="status"></div>
  </main>
  <script>
    const button = document.getElementById('wake');
    const input = document.getElementById('secret');
    const status = document.getElementById('status');

    button.addEventListener('click', async () => {
      button.disabled = true;
      status.className = '';
      status.textContent = 'Sending...';
      try {
        const res = await fetch('/api/wake', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ secret: input.value })
        });
        const data = await res.json();
        if (res.ok && data.ok) {
          status.className = 'ok';
          status.textContent = 'Magic packet sent (' + data.datagrams + ' datagrams).';
          input.value = '';
        } else {
          status.className = 'err';
          status.textContent = data.error || 'Request failed.';
        }
      } catch {
        status.className = 'err';
        status.textContent = 'Network error.';
      } finally {
        button.disabled = false;
      }
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') button.click();
    });
  </script>
</body>
</html>`;
}
