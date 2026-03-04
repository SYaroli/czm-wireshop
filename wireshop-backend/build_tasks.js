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
  const run = (sql, args=[]) => new Promise((resolve,reject)=>{
    db.run(sql, args, function(err){ if(err) reject(err); else resolve({ changes:this.changes, lastID:this.lastID }); });
  });
  const get = (sql, args=[]) => new Promise((resolve,reject)=>{
    db.get(sql, args, (err,row)=> err?reject(err):resolve(row||null));
  });
  const all = (sql, args=[]) => new Promise((resolve,reject)=>{
    db.all(sql, args, (err,rows)=> err?reject(err):resolve(rows||[]));
  });

  async function tx(fn){
    await run('BEGIN');
    try { const v = await fn(); await run('COMMIT'); return v; }
    catch(e){ await run('ROLLBACK'); throw e; }
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
          WHERE id IN (${ids.map(()=>'?').join(',')})`,
        [t, ...ids]
      );

      // log pause events (actor is whoever triggered the pause)
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

    // best-effort add for existing DBs
    db.run(`ALTER TABLE build_tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 0`, ()=>{});
    db.run(`ALTER TABLE build_tasks ADD COLUMN startedAt INTEGER`, ()=>{});
    db.run(`ALTER TABLE build_tasks ADD COLUMN pausedAt INTEGER`, ()=>{});
    db.run(`ALTER TABLE build_tasks ADD COLUMN totalPausedSeconds INTEGER NOT NULL DEFAULT 0`, ()=>{});
    db.run(`ALTER TABLE build_tasks ADD COLUMN isPaused INTEGER NOT NULL DEFAULT 0`, ()=>{});
    db.run(`ALTER TABLE build_tasks ADD COLUMN pausedBySystem INTEGER NOT NULL DEFAULT 0`, ()=>{});
    db.run(`ALTER TABLE build_tasks ADD COLUMN pausedReason TEXT`, ()=>{});

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

    // best-effort add reason for existing DBs
    db.run(`ALTER TABLE build_task_events ADD COLUMN reason TEXT`, ()=>{});
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
      const valid = ['queued','claimed','done'];

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
    } catch (e) { res.status(500).json({ error:'db', detail:String(e.message||e) }); }
  });

  // ----- Claim (supports partial-claim) -----
  // PATCH /api/build-tasks/:id/claim   body: { qty? }
  router.patch('/api/build-tasks/:id/claim', async (req, res) => {
    const user = requireUser(req, res); if (!user) return;
    const id = Number(req.params.id || 0);
    const reqQty = Number(req.body?.qty || 0);

    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error:'bad id' });

    try {
      const task = await get(`SELECT * FROM build_tasks WHERE id=?`, [id]);
      if (!task) return res.status(404).json({ error:'not found' });
      if (task.status !== 'queued') return res.status(409).json({ error:'not-queue', current:task });

      const available = task.qty|0;
      if (!Number.isInteger(available) || available <= 0) return res.status(409).json({ error:'empty' });

      // claimQty defaults to all if not provided or invalid
      let claimQty = Number.isInteger(reqQty) && reqQty > 0 ? reqQty : available;
      if (claimQty > available) return res.status(400).json({ error:'qty exceeds available', available });

      const t = now();

      // full-claim: keep same row
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

        // enforce: only one running timer per tech
        await autoPauseOtherRunningTasks(user, user, id);

        const claimed = await get(`SELECT * FROM build_tasks WHERE id=?`, [id]);
        return res.json(claimed);
      }

      // partial-claim: split inside a transaction
      const result = await tx(async () => {
        // 1) reduce original queued qty
        await run(
          `UPDATE build_tasks SET qty=? WHERE id=? AND status='queued'`,
          [available - claimQty, id]
        );

        // 2) create a new claimed task with the claimed qty
        const ins = await run(
          `INSERT INTO build_tasks (partNumber, qty, status, createdBy, createdAt, claimedBy, claimedAt, startedAt, pausedAt, totalPausedSeconds, isPaused, pausedBySystem, pausedReason, priority)
           VALUES (?, ?, 'claimed', ?, ?, ?, ?, ?, NULL, 0, 0, 0, NULL, ?)`,
          [task.partNumber, claimQty, task.createdBy, task.createdAt, user, t, t, task.priority|0]
        );

        // 3) event for the claimed slice
        await run(
          `INSERT INTO build_task_events (taskId, type, qty, user, ts)
           VALUES (?, 'claim', ?, ?, ?)`,
          [ins.lastID, claimQty, user, t]
        );

        return ins.lastID;
      });

      // enforce: only one running timer per tech
      await autoPauseOtherRunningTasks(user, user, result);

      const claimed = await get(`SELECT * FROM build_tasks WHERE id=?`, [result]);
      res.json(claimed);
    } catch (e) { res.status(500).json({ error:'db', detail:String(e.message||e) }); }
  });

  // ----- Unclaim (ADMIN only) -----
  router.patch('/api/build-tasks/:id/unclaim', async (req, res) => {
    const user = requireUser(req, res); if (!user) return;
    if (!isAdmin(req)) return res.status(403).json({ error:'admin only' });

    const id = Number(req.params.id || 0);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error:'bad id' });

    try {
      const r = await run(
        `UPDATE build_tasks
           SET status='queued',
               claimedBy=NULL, claimedAt=NULL,
               pausedBySystem=0, pausedReason=NULL
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

  // ----- Start timer (CLAIMER or ADMIN) -----
  // PATCH /api/build-tasks/:id/start
  router.patch('/api/build-tasks/:id/start', async (req, res) => {
    const actor = requireUser(req, res); if (!actor) return;
    const id = Number(req.params.id || 0);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error:'bad id' });

    try {
      const task = await get(`SELECT * FROM build_tasks WHERE id=?`, [id]);
      if (!task) return res.status(404).json({ error:'not found' });
      if (task.status !== 'claimed') return res.status(409).json({ error:'not-claimed', current:task });
      if (!canControlTask(req, task)) return res.status(403).json({ error:'forbidden' });

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

      // enforce: only one running timer per tech
      await autoPauseOtherRunningTasks(actor, task.claimedBy, id);

      res.json(await get(`SELECT * FROM build_tasks WHERE id=?`, [id]));
    } catch (e) { res.status(500).json({ error:'db', detail:String(e.message||e) }); }
  });

  // ----- Pause timer (CLAIMER or ADMIN) -----
  router.patch('/api/build-tasks/:id/pause', async (req, res) => {
    const actor = requireUser(req, res); if (!actor) return;
    const id = Number(req.params.id || 0);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error:'bad id' });

    try {
      const task = await get(`SELECT * FROM build_tasks WHERE id=?`, [id]);
      if (!task) return res.status(404).json({ error:'not found' });
      if (task.status !== 'claimed') return res.status(409).json({ error:'not-claimed', current:task });
      if (!canControlTask(req, task)) return res.status(403).json({ error:'forbidden' });

      const t = now();

      await tx(async () => {
        // if it was never started, start it first (so we don't lose time)
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
    } catch (e) { res.status(500).json({ error:'db', detail:String(e.message||e) }); }
  });

  // ----- Resume timer (CLAIMER or ADMIN) -----
  router.patch('/api/build-tasks/:id/resume', async (req, res) => {
    const actor = requireUser(req, res); if (!actor) return;
    const id = Number(req.params.id || 0);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error:'bad id' });

    try {
      const task = await get(`SELECT * FROM build_tasks WHERE id=?`, [id]);
      if (!task) return res.status(404).json({ error:'not found' });
      if (task.status !== 'claimed') return res.status(409).json({ error:'not-claimed', current:task });
      if (!canControlTask(req, task)) return res.status(403).json({ error:'forbidden' });

      const t = now();
      const pausedAt = Number(task.pausedAt || 0);
      const add = pausedAt ? Math.max(0, Math.floor((t - pausedAt)/1000)) : 0;

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

      // enforce: only one running timer per tech
      await autoPauseOtherRunningTasks(actor, task.claimedBy, id);

      res.json(await get(`SELECT * FROM build_tasks WHERE id=?`, [id]));
    } catch (e) { res.status(500).json({ error:'db', detail:String(e.message||e) }); }
  });

  // ----- Complete (partial allowed) -----
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

      // normalize timer: if paused, accrue paused time up to now and clear pausedAt
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

      // if the task was never started, backfill startedAt from claimedAt (or now)
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
        `UPDATE build_tasks SET status='canceled', pausedBySystem=0, pausedReason=NULL WHERE id=? AND status!='done'`,
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

      // Key fix: give the export what it needs (elapsed time at the moment of completion)
      if (type === 'complete') {
        rows.forEach(r => {
          // prefer startedAt; fallback to claimedAt; else 0
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
    } catch (e) { res.status(500).json({ error:'db', detail:String(e.message||e) }); }
  });

  // ----- Clear events (ADMIN) -----
  router.delete('/api/build-task-events', async (req, res) => {
    const user = requireUser(req, res); if (!user) return;
    if (!isAdmin(req)) return res.status(403).json({ error:'admin only' });
    const type = String(req.query.type || 'complete').trim().toLowerCase();
    try {
      const r = await run(`DELETE FROM build_task_events WHERE type = ?`, [type]);
      res.json({ deleted: r.changes|0 });
    } catch (e) { res.status(500).json({ error:'db', detail:String(e.message||e) }); }
  });

  // ----- Auto-pause + auto-resume scheduler -----
  // Breaks:
  //  - 10:30–10:45 (all days)
  //  - 12:00–12:30 (all days)
  //  - 14:30–14:45 Mon–Thu
  //  - 14:00–14:15 Fri
  // Auto-resume at EXACT end times:
  //  - 10:45
  //  - 12:30
  //  - 14:45 Mon–Thu
  //  - 14:15 Fri
  //
  // Shift:
  //  - Start 07:00
  //  - End 17:00 Mon–Thu
  //  - End 15:30 Fri
  //
  // Auto-pause behavior:
  //  - Every minute, if current local time is in a break window OR outside shift hours,
  //    auto-pause any RUNNING task (status='claimed' and isPaused=0), and log event type='auto_pause'
  //    with reason: break | shift_end | off_hours.
  //
  // Auto-resume behavior:
  //  - At the exact break-end minute, auto-resume only tasks that the SYSTEM auto-paused for reason='break'.
  //  - Resume only ONE per tech: newest paused task per claimedBy (MAX pausedAt).
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
    if (['Mon','Tue','Wed','Thu'].includes(weekday)) return '17:00';
    return '00:00'; // weekends closed
  }

  function shouldAutoPause(hm, weekday) {
    // Breaks
    if (inWindow(hm, '10:30', '10:45')) return { yes: true, reason: 'break' };
    if (inWindow(hm, '12:00', '12:30')) return { yes: true, reason: 'break' };
    if (weekday === 'Fri') {
      if (inWindow(hm, '14:00', '14:15')) return { yes: true, reason: 'break' };
    } else if (['Mon','Tue','Wed','Thu'].includes(weekday)) {
      if (inWindow(hm, '14:30', '14:45')) return { yes: true, reason: 'break' };
    }

    // Off-hours / shift end
    const end = shiftEndForWeekday(weekday);
    if (!end || end === '00:00') return { yes: true, reason: 'off_hours' }; // weekends
    if (toMinutes(hm) < toMinutes(SHIFT_START)) return { yes: true, reason: 'off_hours' };
    if (toMinutes(hm) >= toMinutes(end)) return { yes: true, reason: 'shift_end' };

    return { yes: false, reason: '' };
  }

  function shouldAutoResume(hm, weekday) {
    if (hm === '10:45') return { yes: true, reason: 'break_end' };
    if (hm === '12:30') return { yes: true, reason: 'break_end' };
    if (weekday === 'Fri' && hm === '14:15') return { yes: true, reason: 'break_end' };
    if (['Mon','Tue','Wed','Thu'].includes(weekday) && hm === '14:45') return { yes: true, reason: 'break_end' };
    return { yes: false, reason: '' };
  }

  async function autoPauseAllRunning(reason) {
    const t = now();
    return tx(async () => {
      const rows = await all(
        `SELECT id FROM build_tasks
          WHERE status='claimed'
            AND startedAt IS NOT NULL
            AND (isPaused IS NULL OR isPaused=0)`
      );

      if (!rows.length) return 0;

      const ids = rows.map(r => r.id);

      await run(
        `UPDATE build_tasks
            SET isPaused=1,
                pausedAt=?,
                pausedBySystem=1,
                pausedReason=?
          WHERE id IN (${ids.map(()=>'?').join(',')})
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

      return ids.length;
    });
  }

  async function autoResumeSystemPausedBreaks() {
    const t = now();

    // Pick ONE paused-by-system BREAK task per tech: newest pausedAt per claimedBy
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

    if (!candidates.length) return 0;

    return tx(async () => {
      let resumed = 0;

      for (const row of candidates) {
        const id = row.id;
        const pausedAt = Number(row.pausedAt || 0);
        const add = pausedAt ? Math.max(0, Math.floor((t - pausedAt) / 1000)) : 0;

        // resume: add paused time, clear paused flags
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

        if ((r.changes|0) > 0) {
          resumed++;
          await run(
            `INSERT INTO build_task_events (taskId, type, qty, user, ts, reason)
             VALUES (?, 'auto_resume', 0, 'SYSTEM', ?, 'break_end')`,
            [id, t]
          );
        }
      }

      return resumed;
    });
  }

  // Prevent double-fire within the same minute if interval drifts or overlaps
  let _autoSchedRunning = false;
  let _lastKey = ''; // e.g. "pause|Fri|14:00" or "resume|Fri|14:15"
  setInterval(async () => {
    if (_autoSchedRunning) return;
    _autoSchedRunning = true;

    try {
      const { weekday, hm } = localParts();

      // auto-pause (breaks/off-hours) - safe even if called repeatedly; filter isPaused=0
      const chk = shouldAutoPause(hm, weekday);
      if (chk.yes) {
        const key = `pause|${weekday}|${hm}|${chk.reason}`;
        if (_lastKey !== key) {
          await autoPauseAllRunning(chk.reason);
          _lastKey = key;
        }
      } else {
        // auto-resume only on exact break-end minute
        const rs = shouldAutoResume(hm, weekday);
        if (rs.yes) {
          const key = `resume|${weekday}|${hm}`;
          if (_lastKey !== key) {
            await autoResumeSystemPausedBreaks();
            _lastKey = key;
          }
        }
      }

    } catch (e) {
      console.warn('auto scheduler error:', e?.message || e);
    } finally {
      _autoSchedRunning = false;
    }
  }, 60 * 1000);

  app.use(router);
};
