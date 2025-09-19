// backend/build_tasks.js
// Express router for "Build Next" tasks.
// Mount later with:  require('./build_tasks')(app)
//
// Admins can create/cancel/unclaim. Techs (any logged-in user) can claim and complete.
// Partial completes are supported: complete with qty <= remaining.
// Inventory increment will be triggered from the frontend after a successful completion.

const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

module.exports = function attachBuildTasks(app, opts = {}) {
  const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'wireshop.db');
  const db = opts.db || new sqlite3.Database(DB_PATH);
  const router = express.Router();

  // Helpers
  function now() { return Date.now(); }
  function username(req) { return String(req.headers['x-user'] || '').trim(); }
  function isAdmin(req) {
    // Admins defined by env var ADMIN_USERS="alice,bob" (case-insensitive).
    // If not set, everyone is treated as non-admin (safe default).
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

  // Utilities
  function getTask(id) {
    return new Promise((resolve, reject) => {
      db.get(`SELECT * FROM build_tasks WHERE id=?`, [id], (err, row) => {
        if (err) reject(err); else resolve(row || null);
      });
    });
  }
  function run(sql, args = []) {
    return new Promise((resolve, reject) => {
      db.run(sql, args, function onRun(err) {
        if (err) reject(err);
        else resolve({ changes: this.changes, lastID: this.lastID });
      });
    });
  }
  function all(sql, args = []) {
    return new Promise((resolve, reject) => {
      db.all(sql, args, (err, rows) => err ? reject(err) : resolve(rows));
    });
  }

  // Create task (ADMIN)
  router.post('/api/build-tasks', async (req, res) => {
    const user = requireUser(req, res); if (!user) return;
    if (!isAdmin(req)) return res.status(403).json({ error: 'admin only' });

    const { partNumber, qty } = req.body || {};
    const pn = String(partNumber || '').trim();
    const q = Number(qty);

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
      const row = await getTask(r.lastID);
      res.json(row);
    } catch (e) {
      res.status(500).json({ error: 'db', detail: String(e.message || e) });
    }
  });

  // List tasks
  // GET /api/build-tasks?status=queued|claimed|done&since=<epochMs>
  router.get('/api/build-tasks', async (req, res) => {
    const status = String(req.query.status || '').trim().toLowerCase();
    const since = Number(req.query.since || 0);

    try {
      let sql = `SELECT * FROM build_tasks`;
      const params = [];

      if (status === 'queued' || status === 'claimed' || status === 'done') {
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
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: 'db', detail: String(e.message || e) });
    }
  });

  // Claim task (any logged-in user), atomic
  router.patch('/api/build-tasks/:id/claim', async (req, res) => {
    const user = requireUser(req, res); if (!user) return;
    const id = Number(req.params.id || 0);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad id' });

    try {
      const t = now();
      const r = await run(
        `UPDATE build_tasks
         SET status='claimed', claimedBy=?, claimedAt=?
         WHERE id=? AND status='queued'`,
        [user, t, id]
      );
      if (r.changes === 0) {
        const row = await getTask(id);
        return res.status(409).json({ error: 'not-queue', current: row });
      }
      await run(
        `INSERT INTO build_task_events (taskId, type, qty, user, ts)
         VALUES (?, 'claim', 0, ?, ?)`,
        [id, user, t]
      );
      res.json(await getTask(id));
    } catch (e) {
      res.status(500).json({ error: 'db', detail: String(e.message || e) });
    }
  });

  // Unclaim back to queue (ADMIN)
  router.patch('/api/build-tasks/:id/unclaim', async (req, res) => {
    const user = requireUser(req, res); if (!user) return;
    if (!isAdmin(req)) return res.status(403).json({ error: 'admin only' });

    const id = Number(req.params.id || 0);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad id' });

    try {
      const r = await run(
        `UPDATE build_tasks
         SET status='queued', claimedBy=NULL, claimedAt=NULL
         WHERE id=? AND status='claimed'`,
        [id]
      );
      if (r.changes === 0) return res.status(409).json({ error: 'not-claimed', current: await getTask(id) });

      await run(
        `INSERT INTO build_task_events (taskId, type, qty, user, ts)
         VALUES (?, 'unclaim', 0, ?, ?)`,
        [id, user, now()]
      );

      res.json(await getTask(id));
    } catch (e) {
      res.status(500).json({ error: 'db', detail: String(e.message || e) });
    }
  });

  // Complete (partial allowed): body { qty }
  // If qty == remaining -> mark done; else decrement remaining qty and keep claimed.
  router.patch('/api/build-tasks/:id/complete', async (req, res) => {
    const user = requireUser(req, res); if (!user) return;
    const id = Number(req.params.id || 0);
    const qty = Number((req.body && req.body.qty) || 0);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad id' });
    if (!Number.isInteger(qty) || qty <= 0) return res.status(400).json({ error: 'qty must be positive integer' });

    try {
      const task = await getTask(id);
      if (!task) return res.status(404).json({ error: 'not found' });
      if (task.status !== 'claimed') return res.status(409).json({ error: 'not-claimed', current: task });
      if (qty > task.qty) return res.status(400).json({ error: 'qty exceeds remaining', remaining: task.qty });

      const t = now();

      if (qty === task.qty) {
        await run(
          `UPDATE build_tasks
           SET status='done', qty=0, completedAt=?
           WHERE id=? AND status='claimed'`,
          [t, id]
        );
      } else {
        const remaining = task.qty - qty;
        await run(
          `UPDATE build_tasks
           SET qty=?, claimedBy=?, claimedAt=?   -- keep claimed
           WHERE id=? AND status='claimed'`,
          [remaining, task.claimedBy || user, task.claimedAt || t, id]
        );
      }

      await run(
        `INSERT INTO build_task_events (taskId, type, qty, user, ts)
         VALUES (?, 'complete', ?, ?, ?)`,
        [id, qty, user, t]
      );

      // We DO NOT adjust inventory here; the frontend will call /api/inventory/:pn/adjust +qty next.
      const updated = await getTask(id);
      res.json({ task: updated, completedQty: qty, addToInventory: { partNumber: task.partNumber, qty } });
    } catch (e) {
      res.status(500).json({ error: 'db', detail: String(e.message || e) });
    }
  });

  // Cancel task (ADMIN)
  router.patch('/api/build-tasks/:id/cancel', async (req, res) => {
    const user = requireUser(req, res); if (!user) return;
    if (!isAdmin(req)) return res.status(403).json({ error: 'admin only' });

    const id = Number(req.params.id || 0);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad id' });

    try {
      const r = await run(
        `UPDATE build_tasks SET status='canceled' WHERE id=? AND status!='done'`,
        [id]
      );
      if (r.changes === 0) return res.status(409).json({ error: 'already-done-or-missing', current: await getTask(id) });

      await run(
        `INSERT INTO build_task_events (taskId, type, qty, user, ts)
         VALUES (?, 'cancel', 0, ?, ?)`,
        [id, user, now()]
      );

      res.json(await getTask(id));
    } catch (e) {
      res.status(500).json({ error: 'db', detail: String(e.message || e) });
    }
  });

  // Expose router
  app.use(express.json());
  app.use(router);
};
