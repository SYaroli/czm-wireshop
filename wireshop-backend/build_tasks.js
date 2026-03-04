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
    const role = String(req.headers['x-role'] || '').toLowerCase();
    if (role === 'admin') return true;
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
  const run = (sql, args = []) => new Promise((resolve, reject) => {
    db.run(sql, args, function (err) { if (err) reject(err); else resolve({ changes: this.changes, lastID: this.lastID }); });
  });
  const get = (sql, args = []) => new Promise((resolve, reject) => {
    db.get(sql, args, (err, row) => err ? reject(err) : resolve(row || null));
  });
  const all = (sql, args = []) => new Promise((resolve, reject) => {
    db.all(sql, args, (err, rows) => err ? reject(err) : resolve(rows || []));
  });

  async function tx(fn) {
    await run('BEGIN');
    try { const v = await fn(); await run('COMMIT'); return v; }
    catch (e) { await run('ROLLBACK'); throw e; }
  }

  function canControlTask(req, task) {
    if (!task) return false;
    if (isAdmin(req)) return true;
    const u = username(req);
    return !!u && String(task.claimedBy || '').toLowerCase() === u.toLowerCase();
  }

  async function autoPauseOtherRunningTasks(actorUser, claimedByUser, exceptTaskId) {
    const t = now();
    return tx(async () => {
      const rows = await all(
        `SELECT id FROM build_tasks
          WHERE status='claimed'
            AND claimedBy=?
            AND startedAt IS NOT NULL
            AND (isPaused IS NULL OR isPaused=0)
            AND id <> ?`,
        [claimedByUser, exceptTaskId]
      );

      if (!rows.length) return 0;

      const ids = rows.map(r => r.id);
      await run(
        `UPDATE build_tasks
            SET isPaused=1,
                pausedAt=?,
                pausedBySystem=0,
                pausedReason=NULL
          WHERE id IN (${ids.map(() => '?').join(',')})`,
        [t, ...ids]
      );

      await Promise.all(ids.map(id =>
        run(
          `INSERT INTO build_task_events (taskId, type, qty, user, ts)
           VALUES (?, 'pause', 0, ?, ?)`,
          [id, actorUser, t]
        )
      ));

      return ids.length;
    });
  }

  function computeElapsedSeconds(row, atTs = now()) {
    const startedAt = Number(row.startedAt || 0);
    if (!startedAt) return 0;

    const totalPaused = Number(row.totalPausedSeconds || 0);
    const isPaused = Number(row.isPaused || 0) === 1;
    const pausedAt = Number(row.pausedAt || 0);

    const extraPaused = (isPaused && pausedAt) ? Math.max(0, Math.floor((atTs - pausedAt) / 1000)) : 0;
    const elapsed = Math.floor((atTs - startedAt) / 1000) - totalPaused - extraPaused;
    return Math.max(0, elapsed);
  }

  function timerState(row) {
    if (!row.startedAt) return 'not_started';
    return (Number(row.isPaused || 0) === 1) ? 'paused' : 'running';
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
        -- timing
        startedAt          INTEGER,              -- first time the timer started
        pausedAt           INTEGER,              -- when last paused (if paused)
        totalPausedSeconds INTEGER NOT NULL DEFAULT 0,
        isPaused           INTEGER NOT NULL DEFAULT 0, -- 0 running, 1 paused
        pausedBySystem     INTEGER NOT NULL DEFAULT 0, -- 1 if SYSTEM paused it
        pausedReason       TEXT,                 -- break | shift_end | off_hours
        completedAt  INTEGER,
        priority     INTEGER NOT NULL DEFAULT 0  -- 0 normal, 1 high, 2 urgent
      )
    `);

    db.run(`ALTER TABLE build_tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 0`, () => { });
    db.run(`ALTER TABLE build_tasks ADD COLUMN startedAt INTEGER`, () => { });
    db.run(`ALTER TABLE build_tasks ADD COLUMN pausedAt INTEGER`, () => { });
    db.run(`ALTER TABLE build_tasks ADD COLUMN totalPausedSeconds INTEGER NOT NULL DEFAULT 0`, () => { });
    db.run(`ALTER TABLE build_tasks ADD COLUMN isPaused INTEGER NOT NULL DEFAULT 0`, () => { });
    db.run(`ALTER TABLE build_tasks ADD COLUMN pausedBySystem INTEGER NOT NULL DEFAULT 0`, () => { });
    db.run(`ALTER TABLE build_tasks ADD COLUMN pausedReason TEXT`, () => { });

    db.run(`
      CREATE TABLE IF NOT EXISTS build_task_events (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        taskId   INTEGER NOT NULL,
        type     TEXT    NOT NULL,              -- claim | unclaim | complete | cancel | create | pause | resume | start | auto_pause | auto_resume
        qty      INTEGER NOT NULL DEFAULT 0,    -- for completes and partial-claims
        user     TEXT    NOT NULL,
        ts       INTEGER NOT NULL,
        reason   TEXT,
        FOREIGN KEY(taskId) REFERENCES build_tasks(id)
      )
    `);

    db.run(`ALTER TABLE build_task_events ADD COLUMN reason TEXT`, () => { });
  });

  // ----- Who am I -----
  router.get('/api/whoami', (req, res) => {
    const u = requireUser(req, res); if (!u) return;
    res.json({ username: u, isAdmin: !!isAdmin(req) });
  });

  // ----- Create (ADMIN) -----
  router.post('/api/build-tasks', async (req, res) => {
    const user = requireUser(req, res); if (!user) return;
    if (!isAdmin(req)) return res.status(403).json({ error: 'admin only' });

    const pn = String(req.body?.partNumber || '').trim();
    const q = Number(req.body?.qty);
    const priority = Number(req.body?.priority ?? 0) | 0;
    if (!pn) return res.status(400).json({ error: 'partNumber required' });
    if (!Number.isInteger(q) || q <= 0) return res.status(400).json({ error: 'qty must be positive integer' });

    try {
      const t = now();
      const r = await run(
        `INSERT INTO build_tasks (partNumber, qty, status, createdBy, createdAt, priority)
         VALUES (?, ?, 'queued', ?, ?, ?)`,
        [pn, q, user, t, priority]
      );
      await run(
        `INSERT INTO build_task_events (taskId, type, qty, user, ts)
         VALUES (?, 'create', ?, ?, ?)`,
        [r.lastID, q, user, t]
      );
      res.json(await get(`SELECT * FROM build_tasks WHERE id=?`, [r.lastID]));
    } catch (e) { res.status(500).json({ error: 'db', detail: String(e.message || e) }); }
  });

  // ----- List -----
  router.get('/api/build-tasks', async (req, res) => {
    const status = String(req.query.status || '').trim().toLowerCase();
    const since = Number(req.query.since || 0);

    try {
      let sql = `SELECT * FROM build_tasks`;
      const params = [];
      const valid = ['queued', 'claimed', 'done'];

      if (valid.includes(status)) {
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

      if (status === 'queued' || status === 'claimed') {
        sql += ` ORDER BY priority DESC, createdAt ASC`;
      } else if (status === 'done') {
        sql += ` ORDER BY completedAt DESC`;
      } else {
        sql += ` ORDER BY 
          CASE status WHEN 'queued' THEN 0 WHEN 'claimed' THEN 1 WHEN 'done' THEN 2 ELSE 3 END,
          priority DESC, createdAt ASC`;
      }

      const rows = await all(sql, params);

      if (status === 'claimed') {
        const tNow = now();
        rows.forEach(r => {
          r._timerState = timerState(r);
          r._elapsedSeconds = computeElapsedSeconds(r, tNow);
        });
      }

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
    } catch (e) { res.status(500).json({ error: 'db', detail: String(e.message || e) }); }
  });

  // ----- Claim (supports partial-claim) -----
  router.patch('/api/build-tasks/:id/claim', async (req, res) => {
    const user = requireUser(req, res); if (!user) return;
    const id = Number(req.params.id || 0);
    const reqQty = Number(req.body?.qty || 0);

    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad id' });

    try {
      const task = await get(`SELECT * FROM build_tasks WHERE id=?`, [id]);
      if (!task) return res.status(404).json({ error: 'not found' });
      if (task.status !== 'queued') return res.status(409).json({ error: 'not-queue', current: task });

      const available = task.qty | 0;
      if (!Number.isInteger(available) || available <= 0) return res.status(409).json({ error: 'empty' });

      let claimQty = Number.isInteger(reqQty) && reqQty > 0 ? reqQty : available;
      if (claimQty > available) return res.status(400).json({ error: 'qty exceeds available', available });

      const t = now();

      if (claimQty === available) {
        await run(
          `UPDATE build_tasks
             SET status='claimed', claimedBy=?, claimedAt=?,
                 startedAt = COALESCE(startedAt, ?),
                 pausedAt = NULL,
                 isPaused = 0,
                 totalPausedSeconds = COALESCE(totalPausedSeconds, 0),
                 pausedBySystem = 0,
                 pausedReason = NULL
           WHERE id=? AND status='queued'`,
          [user, t, t, id]
        );
        await run(
          `INSERT INTO build_task_events (taskId, type, qty, user, ts)
           VALUES (?, 'claim', ?, ?, ?)`,
          [id, claimQty, user, t]
        );

        await autoPauseOtherRunningTasks(user, user, id);

        const claimed = await get(`SELECT * FROM build_tasks WHERE id=?`, [id]);
        return res.json(claimed);
      }

      const result = await tx(async () => {
        await run(
          `UPDATE build_tasks SET qty=? WHERE id=? AND status='queued'`,
          [available - claimQty, id]
        );

        const ins = await run(
          `INSERT INTO build_tasks (partNumber, qty, status, createdBy, createdAt, claimedBy, claimedAt, startedAt, pausedAt, totalPausedSeconds, isPaused, pausedBySystem, pausedReason, priority)
           VALUES (?, ?, 'claimed', ?, ?, ?, ?, ?, NULL, 0, 0, 0, NULL, ?)`,
          [task.partNumber, claimQty, task.createdBy, task.createdAt, user, t, t, task.priority | 0]
        );

        await run(
          `INSERT INTO build_task_events (taskId, type, qty, user, ts)
           VALUES (?, 'claim', ?, ?, ?)`,
          [ins.lastID, claimQty, user, t]
        );

        return ins.lastID;
      });

      await autoPauseOtherRunningTasks(user, user, result);

      const claimed = await get(`SELECT * FROM build_tasks WHERE id=?`, [result]);
      res.json(claimed);
    } catch (e) { res.status(500).json({ error: 'db', detail: String(e.message || e) }); }
  });

  // ----- Unclaim (ADMIN only) -----
  router.patch('/api/build-tasks/:id/unclaim', async (req, res) => {
    const user = requireUser(req, res); if (!user) return;
    if (!isAdmin(req)) return res.status(403).json({ error: 'admin only' });

    const id = Number(req.params.id || 0);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad id' });

    try {
      const r = await run(
        `UPDATE build_tasks
           SET status='queued',
               claimedBy=NULL, claimedAt=NULL,
               pausedBySystem=0, pausedReason=NULL
         WHERE id=? AND status='claimed'`,
        [id]
      );
      if (r.changes === 0) return res.status(409).json({ error: 'not-claimed', current: await get(`SELECT * FROM build_tasks WHERE id=?`, [id]) });

      await run(
        `INSERT INTO build_task_events (taskId, type, qty, user, ts)
         VALUES (?, 'unclaim', 0, ?, ?)`,
        [id, username(req), now()]
      );
      res.json(await get(`SELECT * FROM build_tasks WHERE id=?`, [id]));
    } catch (e) { res.status(500).json({ error: 'db', detail: String(e.message || e) }); }
  });

  // ----- Start timer (CLAIMER or ADMIN) -----
  router.patch('/api/build-tasks/:id/start', async (req, res) => {
    const actor = requireUser(req, res); if (!actor) return;
    const id = Number(req.params.id || 0);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad id' });

    try {
      const task = await get(`SELECT * FROM build_tasks WHERE id=?`, [id]);
      if (!task) return res.status(404).json({ error: 'not found' });
      if (task.status !== 'claimed') return res.status(409).json({ error: 'not-claimed', current: task });
      if (!canControlTask(req, task)) return res.status(403).json({ error: 'forbidden' });

      const t = now();

      await tx(async () => {
        await run(
          `UPDATE build_tasks
              SET startedAt = COALESCE(startedAt, ?),
                  pausedAt = NULL,
                  isPaused = 0,
                  totalPausedSeconds = COALESCE(totalPausedSeconds, 0),
                  pausedBySystem = 0,
                  pausedReason = NULL
            WHERE id=?`,
          [t, id]
        );

        await run(
          `INSERT INTO build_task_events (taskId, type, qty, user, ts)
           VALUES (?, 'start', 0, ?, ?)`,
          [id, actor, t]
        );
      });

      await autoPauseOtherRunningTasks(actor, task.claimedBy, id);

      res.json(await get(`SELECT * FROM build_tasks WHERE id=?`, [id]));
    } catch (e) { res.status(500).json({ error: 'db', detail: String(e.message || e) }); }
  });

  // ----- Pause timer (CLAIMER or ADMIN) -----
  router.patch('/api/build-tasks/:id/pause', async (req, res) => {
    const actor = requireUser(req, res); if (!actor) return;
    const id = Number(req.params.id || 0);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad id' });

    try {
      const task = await get(`SELECT * FROM build_tasks WHERE id=?`, [id]);
      if (!task) return res.status(404).json({ error: 'not found' });
      if (task.status !== 'claimed') return res.status(409).json({ error: 'not-claimed', current: task });
      if (!canControlTask(req, task)) return res.status(403).json({ error: 'forbidden' });

      const t = now();

      await tx(async () => {
        await run(
          `UPDATE build_tasks
              SET startedAt = COALESCE(startedAt, ?),
                  isPaused = 1,
                  pausedAt = COALESCE(pausedAt, ?),
                  totalPausedSeconds = COALESCE(totalPausedSeconds, 0),
                  pausedBySystem = 0,
                  pausedReason = NULL
            WHERE id=?`,
          [t, t, id]
        );

        await run(
          `INSERT INTO build_task_events (taskId, type, qty, user, ts)
           VALUES (?, 'pause', 0, ?, ?)`,
          [id, actor, t]
        );
      });

      res.json(await get(`SELECT * FROM build_tasks WHERE id=?`, [id]));
    } catch (e) { res.status(500).json({ error: 'db', detail: String(e.message || e) }); }
  });

  // ----- Resume timer (CLAIMER or ADMIN) -----
  router.patch('/api/build-tasks/:id/resume', async (req, res) => {
    const actor = requireUser(req, res); if (!actor) return;
    const id = Number(req.params.id || 0);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad id' });

    try {
      const task = await get(`SELECT * FROM build_tasks WHERE id=?`, [id]);
      if (!task) return res.status(404).json({ error: 'not found' });
      if (task.status !== 'claimed') return res.status(409).json({ error: 'not-claimed', current: task });
      if (!canControlTask(req, task)) return res.status(403).json({ error: 'forbidden' });

      const t = now();
      const pausedAt = Number(task.pausedAt || 0);
      const add = pausedAt ? Math.max(0, Math.floor((t - pausedAt) / 1000)) : 0;

      await tx(async () => {
        await run(
          `UPDATE build_tasks
              SET startedAt = COALESCE(startedAt, ?),
                  isPaused = 0,
                  pausedAt = NULL,
                  totalPausedSeconds = COALESCE(totalPausedSeconds, 0) + ?,
                  pausedBySystem = 0,
                  pausedReason = NULL
            WHERE id=?`,
          [t, add, id]
        );

        await run(
          `INSERT INTO build_task_events (taskId, type, qty, user, ts)
           VALUES (?, 'resume', 0, ?, ?)`,
          [id, actor, t]
        );
      });

      await autoPauseOtherRunningTasks(actor, task.claimedBy, id);

      res.json(await get(`SELECT * FROM build_tasks WHERE id=?`, [id]));
    } catch (e) { res.status(500).json({ error: 'db', detail: String(e.message || e) }); }
  });

  // ----- Complete (partial allowed) -----
  router.patch('/api/build-tasks/:id/complete', async (req, res) => {
    const user = requireUser(req, res); if (!user) return;
    const id = Number(req.params.id || 0);
    const qty = Number(req.body?.qty || 0);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad id' });
    if (!Number.isInteger(qty) || qty <= 0) return res.status(400).json({ error: 'qty must be positive integer' });

    try {
      const task = await get(`SELECT * FROM build_tasks WHERE id=?`, [id]);
      if (!task) return res.status(404).json({ error: 'not found' });
      if (task.status !== 'claimed') return res.status(409).json({ error: 'not-claimed', current: task });
      if (qty > task.qty) return res.status(400).json({ error: 'qty exceeds remaining', remaining: task.qty });

      const t = now();

      if (Number(task.isPaused || 0) === 1) {
        const pAt = Number(task.pausedAt || 0);
        const add = pAt ? Math.max(0, Math.floor((t - pAt) / 1000)) : 0;
        await run(
          `UPDATE build_tasks
              SET totalPausedSeconds = COALESCE(totalPausedSeconds, 0) + ?,
                  pausedAt = NULL,
                  isPaused = 0,
                  pausedBySystem = 0,
                  pausedReason = NULL
            WHERE id=?`,
          [add, id]
        );
        task.totalPausedSeconds = Number(task.totalPausedSeconds || 0) + add;
        task.pausedAt = null;
        task.isPaused = 0;
      }

      if (!task.startedAt) {
        await run(`UPDATE build_tasks SET startedAt=? WHERE id=?`, [task.claimedAt || t, id]);
        task.startedAt = task.claimedAt || t;
      }

      if (qty === task.qty) {
        await run(
          `UPDATE build_tasks SET status='done', qty=0, completedAt=?, pausedBySystem=0, pausedReason=NULL WHERE id=? AND status='claimed'`,
          [t, id]
        );
      } else {
        const remaining = task.qty - qty;
        await run(
          `UPDATE build_tasks SET qty=?, claimedBy=?, claimedAt=?, pausedBySystem=0, pausedReason=NULL WHERE id=? AND status='claimed'`,
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
    } catch (e) { res.status(500).json({ error: 'db', detail: String(e.message || e) }); }
  });

  // ----- Cancel (ADMIN) -----
  router.patch('/api/build-tasks/:id/cancel', async (req, res) => {
    const user = requireUser(req, res); if (!user) return;
    if (!isAdmin(req)) return res.status(403).json({ error: 'admin only' });

    const id = Number(req.params.id || 0);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad id' });

    try {
      const r = await run(
        `UPDATE build_tasks SET status='canceled', pausedBySystem=0, pausedReason=NULL WHERE id=? AND status!='done'`,
        [id]
      );
      if (r.changes === 0) return res.status(409).json({ error: 'already-done-or-missing', current: await get(`SELECT * FROM build_tasks WHERE id=?`, [id]) });

      await run(
        `INSERT INTO build_task_events (taskId, type, qty, user, ts)
         VALUES (?, 'cancel', 0, ?, ?)`,
        [id, username(req), now()]
      );

      res.json(await get(`SELECT * FROM build_tasks WHERE id=?`, [id]));
    } catch (e) { res.status(500).json({ error: 'db', detail: String(e.message || e) }); }
  });

  // ----- Events feed -----
  router.get('/api/build-task-events', async (req, res) => {
    const type = String(req.query.type || '').trim().toLowerCase() || 'complete';
    const since = Number(req.query.since || 0);
    try {
      let sql = `
        SELECT e.id, e.taskId, e.type, e.qty, e.user, e.ts, e.reason,
               t.partNumber, t.claimedBy,
               t.claimedAt, t.startedAt, t.pausedAt, t.totalPausedSeconds, t.isPaused
          FROM build_task_events e
          JOIN build_tasks t ON t.id = e.taskId
         WHERE e.type = ?`;
      const params = [type];
      if (since > 0) {
        sql += ` AND e.ts >= ?`;
        params.push(since);
      }
      sql += ` ORDER BY e.ts DESC`;

      const rows = await all(sql, params);

      if (type === 'complete') {
        rows.forEach(r => {
          const startedAt = Number(r.startedAt || r.claimedAt || 0);
          r.elapsedSeconds = computeElapsedSeconds(
            {
              startedAt,
              totalPausedSeconds: Number(r.totalPausedSeconds || 0),
              isPaused: Number(r.isPaused || 0),
              pausedAt: Number(r.pausedAt || 0)
            },
            Number(r.ts || now())
          );
        });
      }

      res.json(rows);
    } catch (e) { res.status(500).json({ error: 'db', detail: String(e.message || e) }); }
  });

  // ----- Clear events (ADMIN) -----
  router.delete('/api/build-task-events', async (req, res) => {
    const user = requireUser(req, res); if (!user) return;
    if (!isAdmin(req)) return res.status(403).json({ error: 'admin only' });
    const type = String(req.query.type || 'complete').trim().toLowerCase();
    try {
      const r = await run(`DELETE FROM build_task_events WHERE type = ?`, [type]);
      res.json({ deleted: r.changes | 0 });
    } catch (e) { res.status(500).json({ error: 'db', detail: String(e.message || e) }); }
  });

  // ----- Debug: run one scheduler tick (ADMIN only) -----
  // POST /api/debug/run-scheduler
  // Optional: provide weekday and hm (HH:MM, 24h) to simulate time:
  //   { "weekday":"Sat", "hm":"11:59" }
  // or query: ?weekday=Sat&hm=11:59
  router.post('/api/debug/run-scheduler', async (req, res) => {
    const u = requireUser(req, res); if (!u) return;
    if (!isAdmin(req)) return res.status(403).json({ error: 'admin only' });

    const weekday = String((req.body && req.body.weekday) || req.query.weekday || '').trim();
    const hm = String((req.body && req.body.hm) || req.query.hm || '').trim();

    try {
      const result = await runSchedulerTick({
        weekday: weekday || null,
        hm: hm || null,
        bypassDedup: true
      });
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: 'debug', detail: String(e.message || e) });
    }
  });

  // ----- Auto-pause + auto-resume scheduler -----
  //
  // SHIFT HOURS (shop local time):
  //   Mon–Thu: 07:00–17:00
  //   Fri:     07:00–15:30
  //   Sat:     07:00–12:00   (Saturday runs freely; no breaks/lunch auto-pauses)
  //   Sun:     closed
  //
  // BREAKS (auto pause any active timers):
  //   10:00–10:15
  //   12:00–12:30
  //   14:30–14:45
  //
  // Auto-resume ONLY at the exact break-end minute, and only for tasks the SYSTEM paused for reason='break'.
  //
  const TZ = process.env.SHOP_TZ || 'America/New_York';
  const SHIFT_START = '07:00';

  function localParts(tsMs = now()) {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: TZ,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
    const parts = fmt.formatToParts(new Date(tsMs));
    const out = {};
    for (const p of parts) out[p.type] = p.value;
    const weekday = out.weekday; // Mon, Tue, Wed, Thu, Fri, Sat, Sun
    const hh = out.hour || '00';
    const mm = out.minute || '00';
    return { weekday, hm: `${hh}:${mm}` };
  }

  function toMinutes(hm) {
    const [h, m] = String(hm).split(':').map(n => Number(n));
    if (!Number.isFinite(h) || !Number.isFinite(m)) return 0;
    return (h * 60) + m;
  }

  function inWindow(hm, start, end) {
    const t = toMinutes(hm);
    return t >= toMinutes(start) && t < toMinutes(end);
  }

  function shiftEndForWeekday(weekday) {
    if (weekday === 'Fri') return '15:30';
    if (['Mon', 'Tue', 'Wed', 'Thu'].includes(weekday)) return '17:00';
    if (weekday === 'Sat') return '12:00';
    return '00:00'; // Sun closed
  }

  function shouldAutoPause(hm, weekday) {
    // Saturday: allow work freely until 12:00 (no breaks/lunch on Sat)
    if (weekday === 'Sat') {
      if (toMinutes(hm) < toMinutes(SHIFT_START)) return { yes: true, reason: 'off_hours' };
      if (toMinutes(hm) >= toMinutes('12:00')) return { yes: true, reason: 'shift_end' };
      return { yes: false, reason: '' };
    }

    const inBreak =
      inWindow(hm, '10:00', '10:15') ||
      inWindow(hm, '12:00', '12:30') ||
      inWindow(hm, '14:30', '14:45');

    const end = shiftEndForWeekday(weekday);
    if (!end || end === '00:00') return { yes: true, reason: 'off_hours' }; // Sunday
    if (toMinutes(hm) < toMinutes(SHIFT_START)) return { yes: true, reason: 'off_hours' };
    if (toMinutes(hm) >= toMinutes(end)) return { yes: true, reason: 'shift_end' };

    if (inBreak) return { yes: true, reason: 'break' };

    return { yes: false, reason: '' };
  }

  function shouldAutoResume(hm) {
    if (hm === '10:15') return true;
    if (hm === '12:30') return true;
    if (hm === '14:45') return true;
    return false;
  }

  async function autoPauseAllRunning(reason) {
    const t = now();
    return tx(async () => {
      // Pause ONLY the currently running task per tech (claimedBy).
      // "Running" = status='claimed', startedAt not null, isPaused=0.
      const rows = await all(
        `SELECT bt.id
           FROM build_tasks bt
           JOIN (
                SELECT claimedBy, MAX(startedAt) AS maxStartedAt
                  FROM build_tasks
                 WHERE status='claimed'
                   AND claimedBy IS NOT NULL
                   AND startedAt IS NOT NULL
                   AND (isPaused IS NULL OR isPaused=0)
                 GROUP BY claimedBy
           ) x
             ON x.claimedBy = bt.claimedBy AND x.maxStartedAt = bt.startedAt
          WHERE bt.status='claimed'
            AND bt.claimedBy IS NOT NULL
            AND bt.startedAt IS NOT NULL
            AND (bt.isPaused IS NULL OR bt.isPaused=0)`
      );

      if (!rows.length) return [];

      const ids = rows.map(r => r.id);

      await run(
        `UPDATE build_tasks
            SET isPaused=1,
                pausedAt=?,
                pausedBySystem=1,
                pausedReason=?
          WHERE id IN (${ids.map(() => '?').join(',')})
            AND (isPaused IS NULL OR isPaused=0)`,
        [t, reason || '', ...ids]
      );

      await Promise.all(ids.map(id =>
        run(
          `INSERT INTO build_task_events (taskId, type, qty, user, ts, reason)
           VALUES (?, 'auto_pause', 0, 'SYSTEM', ?, ?)`,
          [id, t, reason || '']
        )
      ));

      return ids;
    });
  }

  async function autoResumeSystemPausedBreaks() {
    const t = now();

    const candidates = await all(
      `SELECT bt.id, bt.claimedBy, bt.pausedAt
         FROM build_tasks bt
         JOIN (
              SELECT claimedBy, MAX(pausedAt) AS maxPausedAt
                FROM build_tasks
               WHERE status='claimed'
                 AND isPaused=1
                 AND pausedBySystem=1
                 AND pausedReason='break'
                 AND pausedAt IS NOT NULL
               GROUP BY claimedBy
         ) x
           ON x.claimedBy = bt.claimedBy AND x.maxPausedAt = bt.pausedAt
        WHERE bt.status='claimed'
          AND bt.isPaused=1
          AND bt.pausedBySystem=1
          AND bt.pausedReason='break'`
    );

    if (!candidates.length) return [];

    return tx(async () => {
      const resumedIds = [];

      for (const row of candidates) {
        const id = row.id;
        const pausedAt = Number(row.pausedAt || 0);
        const add = pausedAt ? Math.max(0, Math.floor((t - pausedAt) / 1000)) : 0;

        const r = await run(
          `UPDATE build_tasks
              SET isPaused=0,
                  pausedAt=NULL,
                  totalPausedSeconds = COALESCE(totalPausedSeconds, 0) + ?,
                  pausedBySystem=0,
                  pausedReason=NULL
            WHERE id=?
              AND status='claimed'
              AND isPaused=1
              AND pausedBySystem=1
              AND pausedReason='break'`,
          [add, id]
        );

        if ((r.changes | 0) > 0) {
          resumedIds.push(id);
          await run(
            `INSERT INTO build_task_events (taskId, type, qty, user, ts, reason)
             VALUES (?, 'auto_resume', 0, 'SYSTEM', ?, 'break_end')`,
            [id, t]
          );
        }
      }

      return resumedIds;
    });
  }

  // Prevent double-fire within the same minute if interval drifts or overlaps
  let _autoSchedRunning = false;
  let _lastKey = '';

  async function runSchedulerTick(opts = {}) {
    const bypassDedup = !!opts.bypassDedup;

    const lp = localParts();
    const weekday = (opts.weekday && String(opts.weekday).trim()) || lp.weekday;
    const hm = (opts.hm && String(opts.hm).trim()) || lp.hm;

    const result = {
      weekday,
      hm,
      decision: null,
      paused: { count: 0, ids: [] },
      resumed: { count: 0, ids: [] },
      lastKeyBefore: _lastKey
    };

    const chk = shouldAutoPause(hm, weekday);
    if (chk.yes) {
      const key = `pause|${weekday}|${hm}|${chk.reason}`;
      result.decision = { action: 'pause', reason: chk.reason, key };

      if (bypassDedup || _lastKey !== key) {
        const ids = await autoPauseAllRunning(chk.reason);
        result.paused.ids = ids;
        result.paused.count = ids.length;
        _lastKey = key;
      }
      result.lastKeyAfter = _lastKey;
      return result;
    }

    // Saturday never auto-pauses for breaks, so don't auto-resume there.
    if (weekday !== 'Sat' && shouldAutoResume(hm)) {
      const key = `resume|${weekday}|${hm}`;
      result.decision = { action: 'resume', reason: 'break_end', key };

      if (bypassDedup || _lastKey !== key) {
        const ids = await autoResumeSystemPausedBreaks();
        result.resumed.ids = ids;
        result.resumed.count = ids.length;
        _lastKey = key;
      }
      result.lastKeyAfter = _lastKey;
      return result;
    }

    result.decision = { action: 'none', reason: '' };
    result.lastKeyAfter = _lastKey;
    return result;
  }

  setInterval(async () => {
    if (_autoSchedRunning) return;
    _autoSchedRunning = true;

    try {
      await runSchedulerTick();
    } catch (e) {
      console.warn('auto scheduler error:', e?.message || e);
    } finally {
      _autoSchedRunning = false;
    }
  }, 60 * 1000);

  app.use(router);
};
