const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 3000;

// Initialize SQLite database (persistent file)
const dbPath = process.env.RENDER ? '/data/data.db' : 'data.db';
const db = new Database(dbPath);
// Create table if it doesn't exist
// id is string primary key, name optional, lat/lng real, updated timestamp

db.prepare(`CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT,
  lat REAL,
  lng REAL,
  updated DATETIME DEFAULT CURRENT_TIMESTAMP
)`).run();

const app = express();
// increase body limit for base64 image payloads (~1-2 MB)
app.use(express.json({ limit: '5mb' }));

// Serve static files from root directory (index.html, etc.)
app.use(express.static(path.join(__dirname, '.')));

// REST API: get all users
app.get('/api/users', (req, res) => {
  const rows = db.prepare('SELECT id, name, lat, lng, updated FROM users').all();
  res.json(rows);
});

// REST API: update location
app.post('/api/update', (req, res) => {
  const { id, name, lat, lng } = req.body || {};
  if (!id || typeof lat !== 'number' || typeof lng !== 'number') {
    return res.status(400).json({ error: 'Invalid payload' });
  }
  const upsert = db.prepare(`INSERT INTO users (id, name, lat, lng, updated) VALUES (@id, @name, @lat, @lng, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET name=@name, lat=@lat, lng=@lng, updated=CURRENT_TIMESTAMP`);
  upsert.run({ id, name, lat, lng });

  // Broadcast to WebSocket clients
  const payload = JSON.stringify({ id, name, lat, lng, updated: new Date().toISOString() });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
  res.json({ status: 'ok' });
});

const server = http.createServer(app);

// WebSocket server for real-time updates
const wss = new WebSocket.Server({ server });

// Ensure users table has points column
try {
  db.prepare('ALTER TABLE users ADD COLUMN points INTEGER DEFAULT 0').run();
} catch (e) {
  /* column exists */
}

// Create challenges table
/*
  challenge_id INTEGER PK,
  from_id TEXT,
  to_id TEXT,
  image TEXT, -- base64 png
  status TEXT CHECK(status IN ('pending','accepted','declined')) DEFAULT 'pending',
  beauty INTEGER,
  creativity INTEGER,
  creepiness INTEGER,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
*/
db.prepare(`CREATE TABLE IF NOT EXISTS challenges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id TEXT,
  to_id TEXT,
  image TEXT,
  status TEXT DEFAULT 'pending',
  beauty INTEGER,
  creativity INTEGER,
  creepiness INTEGER,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
)`).run();

function computePoints(b, c, cr) {
  // simple formula: higher beauty & creativity, lower creepiness
  b = Number(b); c = Number(c); cr = Number(cr);
  return b + c + (6 - cr); // max 15
}

// POST /api/challenge
app.post('/api/challenge', (req, res) => {
  const { from_id, to_id, image } = req.body || {};
  if (!from_id || !to_id || !image) return res.status(400).json({ error: 'Invalid payload' });
  const stmt = db.prepare('INSERT INTO challenges (from_id, to_id, image) VALUES (?, ?, ?)');
  const info = stmt.run(from_id, to_id, image);
  const challengeId = info.lastInsertRowid;
  // notify recipient via WS
  const payload = JSON.stringify({ type: 'challenge', id: challengeId, from_id, image });
  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN && c.userId === to_id) {
      c.send(payload);
    }
  });
  res.json({ id: challengeId });
});

// POST /api/response
app.post('/api/response', (req, res) => {
  const { id, accepted, beauty, creativity, creepiness } = req.body || {};
  const ch = db.prepare('SELECT * FROM challenges WHERE id = ?').get(id);
  if (!ch) return res.status(404).json({ error: 'Challenge not found' });
  if (ch.status !== 'pending') return res.status(400).json({ error: 'Already responded' });
  const status = accepted ? 'accepted' : 'declined';
  db.prepare('UPDATE challenges SET status = ?, beauty = ?, creativity = ?, creepiness = ? WHERE id = ?')
    .run(status, beauty, creativity, creepiness, id);
  let points = 0;
  if (accepted) {
    points = computePoints(beauty, creativity, creepiness);
    db.prepare('UPDATE users SET points = COALESCE(points,0) + ? WHERE id = ?').run(points, ch.from_id);
  }
  // notify both users
  const resultPayload = JSON.stringify({ type: 'challenge_result', id, accepted, points, from_id: ch.from_id });
  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN && (c.userId === ch.from_id || c.userId === ch.to_id)) {
      c.send(resultPayload);
    }
  });
  res.json({ status: 'ok', points });
});

// attach userId to ws connection (query param ?uid=)
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const userParam = url.searchParams.get('uid');
  ws.userId = userParam;
  // existing send current users list
  const rows = db.prepare('SELECT id, name, lat, lng, points FROM users').all();
  ws.send(JSON.stringify({ type: 'init', users: rows }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
}); 