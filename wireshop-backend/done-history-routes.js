const path = require('path');
const sqlite3 = require('sqlite3').verbose();

module.exports = function attachDoneHistoryRoutes(app, opts = {}) {
  const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'wireshop.db');
  const db = opts.db || new sqlite3.Database(DB_PATH);

  const run = (sql, args = []) => new Promise((resolve, reject) => {
    db.run(sql, args, function (err) {
      if (err) reject(err);
      else resolve({ changes: this.changes, lastID: this.lastID });
    });
  });
  const all = (sql, args = []) => new Promise((resolve, reject) => {
    db.all(sql, args, (err, rows) => err ? reject(err) : resolve(rows || []));
  });

  const username = req => String(req.headers['x-user'] || '').trim();
  function isAdmin(req) {
    if (String(req.headers['x-role'] || '').toLowerCase() === 'admin') return true;
    const u = username(req).toLowerCase();
    const list = String(process.env.ADMIN_USERS || '')
      .toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
    return list.includes(u);
  }

  async function ensureSchema() {
    await run(`
      CREATE TABLE IF NOT EXISTS build_task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        taskId INTEGER NOT NULL,
        type TEXT NOT NULL,
        qty INTEGER NOT NULL DEFAULT 0,
        user TEXT NOT NULL,
        ts INTEGER NOT NULL,
        reason TEXT,
        elapsedSeconds INTEGER,
        hiddenFromDone INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY(taskId) REFERENCES build_tasks(id)
      )
    `);
    try {
      await run(`ALTER TABLE build_task_events ADD COLUMN hiddenFromDone INTEGER NOT NULL DEFAULT 0`);
    } catch (err) {
      if (!/duplicate column name/i.test(String(err && err.message || err))) throw err;
    }
  }

  function computeElapsedSeconds(row, atTs) {
    const startedAt = Number(row.startedAt || row.claimedAt || 0);
    if (!startedAt) return 0;
    const totalPaused = Number(row.totalPausedSeconds || 0);
    const isPaused = Number(row.isPaused || 0) === 1;
    const pausedAt = Number(row.pausedAt || 0);
    const extraPaused = isPaused && pausedAt
      ? Math.max(0, Math.floor((Number(atTs || Date.now()) - pausedAt) / 1000))
      : 0;
    return Math.max(0, Math.floor((Number(atTs || Date.now()) - startedAt) / 1000) - totalPaused - extraPaused);
  }

  // Intercepts the completion feed before build_tasks.js.
  // Normal callers (Build Next) see only rows not cleared from Done.
  // Build History requests includeHidden=1 and sees the permanent history.
  app.get('/api/build-task-events', async (req, res, next) => {
    const type = String(req.query.type || 'complete').trim().toLowerCase();
    if (type !== 'complete') return next();
    if (!username(req)) return res.status(401).json({ error: 'missing x-user header' });

    try {
      await ensureSchema();
      const includeHidden = String(req.query.includeHidden || '0') === '1';
      const since = Number(req.query.since || 0);
      let sql = `
        SELECT e.id, e.taskId, e.type, e.qty, e.user, e.ts, e.reason, e.elapsedSeconds,
               COALESCE(e.hiddenFromDone, 0) AS hiddenFromDone,
               t.partNumber, t.claimedBy, t.claimedAt, t.startedAt,
               t.pausedAt, t.totalPausedSeconds, t.isPaused
          FROM build_task_events e
          JOIN build_tasks t ON t.id = e.taskId
         WHERE e.type = ?`;
      const params = [type];

      if (!includeHidden) sql += ` AND COALESCE(e.hiddenFromDone, 0) = 0`;
      if (since > 0) {
        sql += ` AND e.ts >= ?`;
        params.push(since);
      }
      sql += ` ORDER BY e.ts DESC`;

      const rows = await all(sql, params);
      rows.forEach(r => {
        if (Number.isFinite(Number(r.elapsedSeconds))) {
          r.elapsedSeconds = Math.max(0, Number(r.elapsedSeconds || 0));
        } else {
          r.elapsedSeconds = computeElapsedSeconds(r, Number(r.ts || Date.now()));
        }
      });
      res.json(rows);
    } catch (err) {
      console.error('[DONE HISTORY] feed failed:', err);
      res.status(500).json({ error: 'db', detail: String(err.message || err) });
    }
  });

  // Clear Done is now a soft hide, never a delete.
  app.delete('/api/build-task-events', async (req, res, next) => {
    const type = String(req.query.type || 'complete').trim().toLowerCase();
    if (type !== 'complete') return next();
    if (!username(req)) return res.status(401).json({ error: 'missing x-user header' });
    if (!isAdmin(req)) return res.status(403).json({ error: 'admin only' });

    try {
      await ensureSchema();
      const r = await run(
        `UPDATE build_task_events
            SET hiddenFromDone = 1
          WHERE type = ? AND COALESCE(hiddenFromDone, 0) = 0`,
        [type]
      );
      res.json({ hidden: r.changes | 0, deleted: 0 });
    } catch (err) {
      console.error('[DONE HISTORY] clear failed:', err);
      res.status(500).json({ error: 'db', detail: String(err.message || err) });
    }
  });
};
