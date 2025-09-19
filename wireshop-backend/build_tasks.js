// backend/build_tasks.js
// Express router for "Build Next" tasks.
// Mount from server.js with:  const attachBuildTasks = require('./build_tasks'); attachBuildTasks(app);

const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

module.exports = function attachBuildTasks(app, opts = {}) {
  const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'wireshop.db');
  const db = opts.db || new sqlite3.Database(DB_PATH);
  const router = express.Router();

  // Helpers
  const now = () => Date.now();
  const username = req => String(req.headers['x-user'] || '').trim();
  function isAdmin(req) {
    // NEW: honor x-role: admin from the frontend
    const role = String(req.headers['x-role'] || '').toLowerCase();
    if (role === 'admin') return true;

    // Also honor ADMIN_USERS env list (comma-separated usernames)
    const u = username(req).toLowerCase();
    const list = String(process.env.ADMIN_USERS || '')
      .toLowerCase()
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    return list.includes(u);
  }
  function requireUser(req, res) {
    const u = username(req);
    if (!u) { res.status(401).json({ error: 'missing x-user header' }); return null; }
    return u;
  }

  // DB utils
  const run = (sql, args=[]) => new Promise((resolve,reject)=>{
    db.run(sql, args, function(err){ if(err) reject(err); else resolve({ changes:this.changes, lastID:this.lastID }); });
  });
  const get = (sql, args=[]) => new Promise((resolve,reject)=>{
    db.get(sql, args, (err,row)=> err?reject(err):resolve(row||null));
  });
  const all = (sql, args=[]) => new Promise((resolve,reject)=>{
    db.all(sql, args, (err,rows)=> err?reject(err):resolve(rows||[]));
  });

  // Schema
  db.serialize(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS build_tasks (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        partNumber   TEXT    NOT NULL,
        qty          INTEGER NOT NULL,
        status       TEXT    NOT NULL,           -- queued | claimed | done | canceled
        createdBy    TEXT    NOT NULL,
        createdAt    INTEGER NOT NULL,
        claimedBy    TEXT,
        claimedAt    INTEGER,
        completedAt  INTEGER
      )
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS build_task_events (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        taskId   INTEGER NOT NULL,
        type     TEXT    NOT NULL,              -- claim | unclaim | complete | cancel | create
        qty      INTEGER NOT NULL DEFAULT 0,    -- for completes (partial)
        user     TEXT    NOT NULL,
        ts       INTEGER NOT NULL,
        FOREIGN KEY(taskId) REFERENCES build_tasks(id)
      )
    `);
  });

  // ----- Create (ADMIN) -----
  router.post('/api/build-tasks', async (req, res) => {
    const user = requireUser(req, res); if (!user) return;
    if (!isAdmin(req)) return res.status(403).json({ error: 'admin only' });

    const pn = String(req.body?.partNumber || '').trim();
    const q = Number(req.body?.qty);
    if (!pn) return res.status(400).json({ error: 'partNumber required' });
    if (!Number.isInteger(q) || q <= 0) return res.status(400).json({ error: 'qty must be positive integer' });

    try {
      const t = now();
      const r = await run(
        `INSERT INTO build_tasks (partNumber, qty, status, createdBy, createdAt)
         VALUES (?, ?, 'queued', ?, ?)`,
        [pn, q, user, t]
      );
      await run(
        `INSERT INTO build_task_events (taskId, type, qty, user, ts)
         VALUES (?, 'create', ?, ?, ?)`,
        [r.lastID, q, user, t]
      );
      res.json(await get(`SELECT * FROM build_tasks WHERE id=?`, [r.lastID]));
    } catch (e) { res.status(500).json({ error:'db', detail:String(e.message||e) }); }
  });

  // ----- List -----
  // GET /api/build-tasks?status=queued|claimed|done&since=<epochMs>
  router.get('/api/build-tasks', async (req, res) => {
    const status = String(req.query.status || '').trim().toLowerCase();
    const since = Number(req.query.since || 0);

    try {
      let sql = `SELECT * FROM build_tasks`;
      const params = [];

      if (['queued','claimed','done'].includes(status)) {
        sql += ` WHERE status=?`;
        params.push(status);
        if (status === 'done' && since > 0) {
          sql += ` AND completedAt >= ?`;
          params.push(since);
        }
      } else if (since > 0) {
        sql += ` WHERE completedAt >= ?`;
        params.push(since);
      }

      sql += ` ORDER BY 
        CASE status WHEN 'queued' THEN 0 WHEN 'claimed' THEN 1 WHEN 'done' THEN 2 ELSE 3 END,
        createdAt ASC`;

      const rows = await all(sql, params);

      // Include last completed qty for "Done today"
      if (status === 'done') {
        await Promise.all(rows.map(async r => {
          const ev = await get(
            `SELECT qty FROM build_task_events WHERE taskId=? AND type='complete' ORDER BY ts DESC LIMIT 1`,
            [r.id]
          );
          if (ev && Number.isInteger(ev.qty)) r._lastQtyDone = ev.qty;
        }));
      }

      res.json(rows);
    } catch (e) { res.status(500).json({ error:'db', detail:String(e.message||e) }); }
  });

  // ----- Claim (any logged-in user), atomic -----
  router.patch('/api/build-tasks/:id/claim', async (req, res) => {
    const user = requireUser(req, res); if (!user) return;
    const id = Number(req.params.id || 0);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error:'bad id' });

    try {
      const t = now();
      const r = await run(
        `UPDATE build_tasks
           SET status='claimed', claimedBy=?, claimedAt=?
         WHERE id=? AND status='queued'`,
        [user, t, id]
      );
      if (r.changes === 0) {
        return res.status(409).json({ error:'not-queue', current: await get(`SELECT * FROM build_tasks WHERE id=?`, [id]) });
      }
      await run(
        `INSERT INTO build_task_events (taskId, type, qty, user, ts)
         VALUES (?, 'claim', 0, ?, ?)`,
        [id, user, t]
      );
      res.json(await get(`SELECT * FROM build_tasks WHERE id=?`, [id]));
    } catch (e) { res.status(500).json({ error:'db', detail:String(e.message||e) }); }
  });

  // ----- Unclaim (ADMIN) -----
  router.patch('/api/build-tasks/:id/unclaim', async (req, res) => {
    const user = requireUser(req, res); if (!user) return;
    if (!isAdmin(req)) return res.status(403).json({ error:'admin only' });

    const id = Number(req.params.id || 0);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error:'bad id' });

    try {
      const r = await run(
        `UPDATE build_tasks
           SET status='queued', claimedBy=NULL, claimedAt=NULL
         WHERE id=? AND status='claimed'`,
        [id]
      );
      if (r.changes === 0) return res.status(409).json({ error:'not-claimed', current: await get(`SELECT * FROM build_tasks WHERE id=?`, [id]) });

      await run(
        `INSERT INTO build_task_events (taskId, type, qty, user, ts)
         VALUES (?, 'unclaim', 0, ?, ?)`,
        [id, username(req), now()]
      );
      res.json(await get(`SELECT * FROM build_tasks WHERE id=?`, [id]));
    } catch (e) { res.status(500).json({ error:'db', detail:String(e.message||e) }); }
  });

  // ----- Complete (partial allowed) -----
  // PATCH /api/build-tasks/:id/complete  body: { qty }
  // If qty==remaining -> mark done; else decrement remaining qty and keep claimed.
  router.patch('/api/build-tasks/:id/complete', async (req, res) => {
    const user = requireUser(req, res); if (!user) return;
    const id = Number(req.params.id || 0);
    const qty = Number(req.body?.qty || 0);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error:'bad id' });
    if (!Number.isInteger(qty) || qty <= 0) return res.status(400).json({ error:'qty must be positive integer' });

    try {
      const task = await get(`SELECT * FROM build_tasks WHERE id=?`, [id]);
      if (!task) return res.status(404).json({ error:'not found' });
      if (task.status !== 'claimed') return res.status(409).json({ error:'not-claimed', current:task });
      if (qty > task.qty) return res.status(400).json({ error:'qty exceeds remaining', remaining: task.qty });

      const t = now();
      if (qty === task.qty) {
        await run(
          `UPDATE build_tasks SET status='done', qty=0, completedAt=? WHERE id=? AND status='claimed'`,
          [t, id]
        );
      } else {
        const remaining = task.qty - qty;
        await run(
          `UPDATE build_tasks SET qty=?, claimedBy=?, claimedAt=? WHERE id=? AND status='claimed'`,
          [remaining, task.claimedBy || user, task.claimedAt || t, id]
        );
      }

      await run(
        `INSERT INTO build_task_events (taskId, type, qty, user, ts)
         VALUES (?, 'complete', ?, ?, ?)`,
        [id, qty, user, t]
      );

      const updated = await get(`SELECT * FROM build_tasks WHERE id=?`, [id]);
      res.json({ task: updated, completedQty: qty, addToInventory: { partNumber: task.partNumber, qty } });
    } catch (e) { res.status(500).json({ error:'db', detail:String(e.message||e) }); }
  });

  // ----- Cancel (ADMIN) -----
  router.patch('/api/build-tasks/:id/cancel', async (req, res) => {
    const user = requireUser(req, res); if (!user) return;
    if (!isAdmin(req)) return res.status(403).json({ error:'admin only' });

    const id = Number(req.params.id || 0);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error:'bad id' });

    try {
      const r = await run(
        `UPDATE build_tasks SET status='canceled' WHERE id=? AND status!='done'`,
        [id]
      );
      if (r.changes === 0) return res.status(409).json({ error:'already-done-or-missing', current: await get(`SELECT * FROM build_tasks WHERE id=?`, [id]) });

      await run(
        `INSERT INTO build_task_events (taskId, type, qty, user, ts)
         VALUES (?, 'cancel', 0, ?, ?)`,
        [id, username(req), now()]
      );

      res.json(await get(`SELECT * FROM build_tasks WHERE id=?`, [id]));
    } catch (e) { res.status(500).json({ error:'db', detail:String(e.message||e) }); }
  });

  // ----- Events feed (optional) -----
  router.get('/api/build-task-events', async (req, res) => {
    const type = String(req.query.type || '').trim().toLowerCase() || 'complete';
    const since = Number(req.query.since || 0);
    try {
      let sql = `
        SELECT e.id, e.taskId, e.type, e.qty, e.user, e.ts,
               t.partNumber, t.claimedBy
          FROM build_task_events e
          JOIN build_tasks t ON t.id = e.taskId
         WHERE e.type = ?`;
      const params = [type];
      if (since > 0) {
        sql += ` AND e.ts >= ?`;
        params.push(since);
      }
      sql += ` ORDER BY e.ts DESC`;
      res.json(await all(sql, params));
    } catch (e) { res.status(500).json({ error:'db', detail:String(e.message||e) }); }
  });

  // mount
  app.use(express.json());
  app.use(router);
};
