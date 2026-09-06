// server.js - Structure Journal CLOUD version
//
// This is a separate, deployable server (Render free tier, or anywhere
// that runs Node). Unlike the local journal-app, this one has no access
// to your MT5 files directly - it only knows what your laptop's local
// app pushes to it via the /api/sync endpoint.
//
// Flow:
//   MT5 (laptop) -> local journal-app -> [sync push] -> THIS server -> your phone
//
// Everything lives in a SQLite file (journal.db) sitting next to this
// script. On Render's free tier, that file is WIPED on every new deploy
// (pushing updated code) - it survives normal sleep/wake cycles fine,
// just not a redeploy. If you want it to survive redeploys too, you'd
// need Render's paid persistent disk, or an external database - out of
// scope for this personal-use version, but worth knowing.

const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 3000;

// Shared secret - required both for the sync push AND for viewing.
// Set this in Render's environment variables. Bookmark your phone to
// https://your-app.onrender.com/?key=YOUR_SECRET so you don't have to
// type it every time.
const SYNC_KEY = process.env.SYNC_KEY || 'change-me';

const db = new Database(path.join(__dirname, 'journal.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS trades (
    position_id TEXT PRIMARY KEY,
    symbol TEXT,
    direction TEXT,
    open_price TEXT, open_time TEXT, open_volume TEXT, open_sl TEXT, open_tp TEXT,
    close_price TEXT, close_time TEXT, close_profit REAL, close_sl TEXT, close_tp TEXT,
    status TEXT
  );
  CREATE TABLE IF NOT EXISTS snapshots (
    position_id TEXT PRIMARY KEY,
    structure_raw TEXT,
    candles_json TEXT
  );
  CREATE TABLE IF NOT EXISTS notes (
    position_id TEXT PRIMARY KEY,
    note TEXT DEFAULT '',
    tags TEXT DEFAULT '',
    rating INTEGER,
    strategy TEXT DEFAULT '',
    updated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS strategies (
    name TEXT PRIMARY KEY
  );
  CREATE TABLE IF NOT EXISTS deleted_trades (
    position_id TEXT PRIMARY KEY,
    symbol TEXT,
    direction TEXT,
    deleted_at TEXT,
    payload TEXT
  );
  CREATE TABLE IF NOT EXISTS goals (
    period_type TEXT PRIMARY KEY,
    target REAL NOT NULL DEFAULT 0,
    updated_at TEXT
  );
`);
const seedStrategy = db.prepare('INSERT OR IGNORE INTO strategies (name) VALUES (?)');
for (const s of ['Structure/BOS', 'HTF CHoCH']) seedStrategy.run(s);

// --- simple key gate --------------------------------------------------
function requireKey(req, res, next) {
  const key = req.query.key || req.headers['x-sync-key'];
  if (key !== SYNC_KEY) return res.status(401).json({ error: 'Missing or invalid key' });
  next();
}

app.use(express.json({ limit: '20mb' })); // snapshots can be sizeable with years of swing data
app.use('/api', requireKey);
app.use((req, res, next) => {
  // gate the static frontend too, via a one-time cookie set from the ?key= URL
  if (req.path === '/' && req.query.key === SYNC_KEY) {
    res.cookie ? null : null; // no cookie lib; rely on the frontend re-sending ?key on API calls instead
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------
// Sync endpoint - the local app POSTs everything here in one batch.
// Upserts trades/snapshots; notes are NOT overwritten if they already
// exist remotely (so a note you added from your phone isn't clobbered
// by the next laptop sync).
// ---------------------------------------------------------------------
app.post('/api/sync', (req, res) => {
  const { trades = [], snapshots = {}, strategies = [], goals = {} } = req.body;

  const upsertTrade = db.prepare(`
    INSERT INTO trades (position_id, symbol, direction, open_price, open_time, open_volume, open_sl, open_tp,
                         close_price, close_time, close_profit, close_sl, close_tp, status)
    VALUES (@position_id, @symbol, @direction, @open_price, @open_time, @open_volume, @open_sl, @open_tp,
            @close_price, @close_time, @close_profit, @close_sl, @close_tp, @status)
    ON CONFLICT(position_id) DO UPDATE SET
      symbol=excluded.symbol, direction=excluded.direction,
      open_price=excluded.open_price, open_time=excluded.open_time, open_volume=excluded.open_volume,
      open_sl=excluded.open_sl, open_tp=excluded.open_tp,
      close_price=excluded.close_price, close_time=excluded.close_time, close_profit=excluded.close_profit,
      close_sl=excluded.close_sl, close_tp=excluded.close_tp, status=excluded.status
  `);
  const upsertSnapshot = db.prepare(`
    INSERT INTO snapshots (position_id, structure_raw, candles_json)
    VALUES (?, ?, ?)
    ON CONFLICT(position_id) DO UPDATE SET structure_raw=excluded.structure_raw, candles_json=excluded.candles_json
  `);
  const seedStrat = db.prepare('INSERT OR IGNORE INTO strategies (name) VALUES (?)');

  const tx = db.transaction(() => {
    for (const t of trades) {
      upsertTrade.run({
        position_id: String(t.position_id),
        symbol: t.symbol || '', direction: t.direction || '',
        open_price: t.open ? t.open.price : null, open_time: t.open ? t.open.time : null,
        open_volume: t.open ? t.open.volume : null, open_sl: t.open ? t.open.sl : null, open_tp: t.open ? t.open.tp : null,
        close_price: t.close ? t.close.price : null, close_time: t.close ? t.close.time : null,
        close_profit: t.close ? t.close.profit : null, close_sl: t.close ? t.close.sl : null, close_tp: t.close ? t.close.tp : null,
        status: t.close ? 'closed' : 'open',
      });
    }
    for (const [posId, snap] of Object.entries(snapshots)) {
      upsertSnapshot.run(posId, snap.structureRaw || null, JSON.stringify(snap.candles || {}));
    }
    for (const s of strategies) seedStrat.run(s);
    const upsertGoal = db.prepare(`
      INSERT INTO goals (period_type, target, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(period_type) DO UPDATE SET target = excluded.target, updated_at = excluded.updated_at
    `);
    for (const pt of ['day', 'week', 'month']) {
      if (goals[pt] !== undefined) upsertGoal.run(pt, Number(goals[pt]) || 0);
    }
  });
  tx();

  res.json({ ok: true, tradesReceived: trades.length, snapshotsReceived: Object.keys(snapshots).length });
});

// ---------------------------------------------------------------------
// Profit targets - same shape as the local app so the frontend Reports
// panel works unmodified against either server. Goals also arrive here
// via /api/sync from your laptop, but you can edit them directly from
// your phone too - they're independent per-server rows.
// ---------------------------------------------------------------------
app.get('/api/goals', (req, res) => {
  const rows = db.prepare('SELECT period_type, target FROM goals').all();
  const g = { day: 0, week: 0, month: 0 };
  for (const r of rows) g[r.period_type] = r.target;
  res.json(g);
});

app.post('/api/goals', (req, res) => {
  const { period_type, target } = req.body;
  if (!['day', 'week', 'month'].includes(period_type)) {
    return res.status(400).json({ error: 'period_type must be day, week, or month' });
  }
  const num = Number(target);
  if (!isFinite(num)) return res.status(400).json({ error: 'target must be a number' });
  db.prepare(`
    INSERT INTO goals (period_type, target, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(period_type) DO UPDATE SET target = excluded.target, updated_at = excluded.updated_at
  `).run(period_type, num);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------
// Same read/note/trash API shape as the local app, so the frontend
// works unmodified against either server.
// ---------------------------------------------------------------------
function parseSnapshotFile(content) {
  if (!content) return { header: '', timeframes: {} };
  const lines = content.split(/\r?\n/);
  let header = '';
  const timeframes = {};
  let currentTf = null;
  let currentBuf = [];
  function flush() {
    if (currentTf && currentBuf.length) {
      try { timeframes[currentTf] = JSON.parse(currentBuf.join('\n')); }
      catch (e) { timeframes[currentTf] = { error: 'failed to parse' }; }
    }
    currentBuf = [];
  }
  for (const line of lines) {
    const marker = line.match(/^\/\/ --- from (.+) ---$/);
    if (marker) {
      flush();
      const tfMatch = marker[1].match(/(PERIOD_[A-Z0-9]+)\.json/);
      currentTf = tfMatch ? tfMatch[1] : marker[1];
    } else if (line.startsWith('//')) {
      if (!currentTf) header += line.replace(/^\/\/\s?/, '') + '\n';
    } else if (currentTf) {
      currentBuf.push(line);
    }
  }
  flush();
  return { header: header.trim(), timeframes };
}

function getTradesList() {
  const rows = db.prepare('SELECT * FROM trades').all();
  const noteStmt = db.prepare('SELECT * FROM notes WHERE position_id = ?');
  const trades = rows.map(r => {
    const note = noteStmt.get(r.position_id);
    return {
      position_id: r.position_id, symbol: r.symbol, direction: r.direction, status: r.status,
      open: r.open_price ? { price: r.open_price, time: r.open_time, volume: r.open_volume, sl: r.open_sl, tp: r.open_tp } : null,
      close: r.close_price ? { price: r.close_price, time: r.close_time, profit: r.close_profit, sl: r.close_sl, tp: r.close_tp } : null,
      note: note ? note.note : '', tags: note ? note.tags : '', rating: note ? note.rating : null,
      strategy: note ? note.strategy : '',
    };
  });
  trades.sort((a, b) => {
    const ta = new Date((a.close || a.open || {}).time || 0);
    const tb = new Date((b.close || b.open || {}).time || 0);
    return tb - ta;
  });
  return trades;
}

app.get('/api/trades', (req, res) => res.json(getTradesList()));

app.get('/api/trade/:id', (req, res) => {
  const id = req.params.id;
  const trades = getTradesList();
  const trade = trades.find(t => String(t.position_id) === String(id));
  if (!trade) return res.status(404).json({ error: 'Trade not found' });

  const snapRow = db.prepare('SELECT * FROM snapshots WHERE position_id = ?').get(id);
  const structure = parseSnapshotFile(snapRow ? snapRow.structure_raw : null);
  const candles = snapRow && snapRow.candles_json ? JSON.parse(snapRow.candles_json) : {};

  res.json({ trade, structure, candles });
});

app.post('/api/trade/:id/note', (req, res) => {
  const id = req.params.id;
  const { note = '', tags = '', rating = null, strategy = '' } = req.body;
  db.prepare(`
    INSERT INTO notes (position_id, note, tags, rating, strategy, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(position_id) DO UPDATE SET
      note=excluded.note, tags=excluded.tags, rating=excluded.rating, strategy=excluded.strategy, updated_at=excluded.updated_at
  `).run(id, note, tags, rating, strategy);
  res.json({ ok: true });
});

app.get('/api/strategies', (req, res) => {
  res.json(db.prepare('SELECT name FROM strategies ORDER BY name').all().map(r => r.name));
});
app.post('/api/strategies', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });
  db.prepare('INSERT OR IGNORE INTO strategies (name) VALUES (?)').run(name.trim());
  res.json({ ok: true });
});

app.delete('/api/trade/:id', (req, res) => {
  const id = req.params.id;
  const trade = getTradesList().find(t => String(t.position_id) === String(id));
  if (!trade) return res.status(404).json({ error: 'Not found' });

  const snapRow = db.prepare('SELECT * FROM snapshots WHERE position_id = ?').get(id);
  const noteRow = db.prepare('SELECT * FROM notes WHERE position_id = ?').get(id);
  const payload = JSON.stringify({ trade, snapshot: snapRow || null, note: noteRow || null });

  db.prepare(`
    INSERT INTO deleted_trades (position_id, symbol, direction, deleted_at, payload)
    VALUES (?, ?, ?, datetime('now'), ?)
    ON CONFLICT(position_id) DO UPDATE SET deleted_at=excluded.deleted_at, payload=excluded.payload
  `).run(id, trade.symbol, trade.direction, payload);

  db.prepare('DELETE FROM trades WHERE position_id = ?').run(id);
  db.prepare('DELETE FROM snapshots WHERE position_id = ?').run(id);
  db.prepare('DELETE FROM notes WHERE position_id = ?').run(id);
  res.json({ ok: true });
});

app.get('/api/trash', (req, res) => {
  res.json(db.prepare('SELECT position_id, symbol, direction, deleted_at FROM deleted_trades ORDER BY deleted_at DESC').all());
});

app.post('/api/trash/:id/restore', (req, res) => {
  const id = req.params.id;
  const row = db.prepare('SELECT * FROM deleted_trades WHERE position_id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Not in trash' });
  const data = JSON.parse(row.payload);

  if (data.trade) {
    const t = data.trade;
    db.prepare(`
      INSERT INTO trades (position_id, symbol, direction, open_price, open_time, open_volume, open_sl, open_tp,
                           close_price, close_time, close_profit, close_sl, close_tp, status)
      VALUES (@position_id, @symbol, @direction, @open_price, @open_time, @open_volume, @open_sl, @open_tp,
              @close_price, @close_time, @close_profit, @close_sl, @close_tp, @status)
    `).run({
      position_id: id, symbol: t.symbol, direction: t.direction,
      open_price: t.open ? t.open.price : null, open_time: t.open ? t.open.time : null,
      open_volume: t.open ? t.open.volume : null, open_sl: t.open ? t.open.sl : null, open_tp: t.open ? t.open.tp : null,
      close_price: t.close ? t.close.price : null, close_time: t.close ? t.close.time : null,
      close_profit: t.close ? t.close.profit : null, close_sl: t.close ? t.close.sl : null, close_tp: t.close ? t.close.tp : null,
      status: t.status,
    });
  }
  if (data.snapshot) {
    db.prepare('INSERT INTO snapshots (position_id, structure_raw, candles_json) VALUES (?, ?, ?)')
      .run(id, data.snapshot.structure_raw, data.snapshot.candles_json);
  }
  if (data.note) {
    db.prepare(`
      INSERT INTO notes (position_id, note, tags, rating, strategy, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, data.note.note, data.note.tags, data.note.rating, data.note.strategy, data.note.updated_at);
  }
  db.prepare('DELETE FROM deleted_trades WHERE position_id = ?').run(id);
  res.json({ ok: true });
});

app.delete('/api/trash/:id', (req, res) => {
  db.prepare('DELETE FROM deleted_trades WHERE position_id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`Cloud journal running on port ${PORT}`));
