// server.js — DeployGate demo app: a "launch board" for releases.
//
// A release has a checklist. Items can be added, checked/unchecked and
// deleted. The Deploy button is only enabled when the release has at least
// one item and every item is checked. The server enforces the same rule on
// POST /api/releases/:id/deploy, so the gate is real on both sides.
//
// No dependencies: Node built-in http only. State is persisted to data.json
// (gitignored) so a restart keeps the board.
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT || 3000);
const DATA_FILE = path.join(__dirname, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

let state = { releases: [] };
try {
  if (fs.existsSync(DATA_FILE)) {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (parsed && Array.isArray(parsed.releases)) state = parsed;
  }
} catch {
  state = { releases: [] };
}

function save() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) reject(new Error('body too large'));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function findRelease(id) {
  return state.releases.find((r) => r.id === id);
}

function releaseSummary(r) {
  const total = r.items.length;
  const done = r.items.filter((i) => i.done).length;
  return {
    id: r.id,
    name: r.name,
    status: r.status,
    createdAt: r.createdAt,
    deployedAt: r.deployedAt || null,
    items: r.items,
    total,
    done,
    readyToDeploy: total > 0 && done === total && r.status !== 'Deployed',
  };
}

async function handleApi(req, res, pathname) {
  const parts = pathname.split('/').filter(Boolean); // ['api', ...]

  // GET /api/health
  if (req.method === 'GET' && pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, releases: state.releases.length });
  }

  // GET /api/state
  if (req.method === 'GET' && pathname === '/api/state') {
    return sendJson(res, 200, { releases: state.releases.map(releaseSummary) });
  }

  // POST /api/releases { name }
  if (req.method === 'POST' && pathname === '/api/releases') {
    const body = await readBody(req);
    const name = String(body.name || '').trim();
    if (!name) return sendJson(res, 400, { error: 'name is required' });
    const release = {
      id: newId(),
      name,
      status: 'Draft',
      items: [],
      createdAt: new Date().toISOString(),
      deployedAt: null,
    };
    state.releases.unshift(release);
    save();
    return sendJson(res, 201, releaseSummary(release));
  }

  // /api/releases/:id/...
  if (parts[0] === 'api' && parts[1] === 'releases' && parts[2]) {
    const release = findRelease(parts[2]);
    if (!release) return sendJson(res, 404, { error: 'release not found' });

    // DELETE /api/releases/:id
    if (req.method === 'DELETE' && parts.length === 3) {
      state.releases = state.releases.filter((r) => r.id !== release.id);
      save();
      return sendJson(res, 200, { ok: true });
    }

    // POST /api/releases/:id/items { text }
    if (req.method === 'POST' && parts[3] === 'items' && parts.length === 4) {
      const body = await readBody(req);
      const text = String(body.text || '').trim();
      if (!text) return sendJson(res, 400, { error: 'text is required' });
      const item = { id: newId(), text, done: false };
      release.items.push(item);
      if (release.status === 'Deployed') release.status = 'Draft';
      save();
      return sendJson(res, 201, releaseSummary(release));
    }

    // PATCH /api/releases/:id/items/:itemId { done }
    // DELETE /api/releases/:id/items/:itemId
    if (parts[3] === 'items' && parts[4]) {
      const item = release.items.find((i) => i.id === parts[4]);
      if (!item) return sendJson(res, 404, { error: 'item not found' });
      if (req.method === 'PATCH') {
        const body = await readBody(req);
        item.done = body.done === true;
        save();
        return sendJson(res, 200, releaseSummary(release));
      }
      if (req.method === 'DELETE') {
        release.items = release.items.filter((i) => i.id !== item.id);
        save();
        return sendJson(res, 200, releaseSummary(release));
      }
    }

    // POST /api/releases/:id/deploy — server-side gate, same rule as the UI.
    if (req.method === 'POST' && parts[3] === 'deploy' && parts.length === 4) {
      const total = release.items.length;
      const done = release.items.filter((i) => i.done).length;
      if (release.status === 'Deployed') {
        return sendJson(res, 409, { error: 'release already deployed' });
      }
      if (total === 0) {
        return sendJson(res, 409, { error: 'cannot deploy: checklist is empty' });
      }
      if (done < total) {
        return sendJson(res, 409, {
          error: `cannot deploy: ${total - done} of ${total} checklist items unchecked`,
        });
      }
      release.status = 'Deployed';
      release.deployedAt = new Date().toISOString();
      save();
      return sendJson(res, 200, releaseSummary(release));
    }
  }

  return sendJson(res, 404, { error: 'not found' });
}

function serveStatic(req, res, pathname) {
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.normalize(path.join(PUBLIC_DIR, filePath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('not found');
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url.pathname);
    } else {
      serveStatic(req, res, url.pathname);
    }
  } catch (err) {
    sendJson(res, 500, { error: err.message || 'internal error' });
  }
});

server.listen(PORT, () => {
  console.log(`DeployGate app listening on http://localhost:${PORT}`);
});
